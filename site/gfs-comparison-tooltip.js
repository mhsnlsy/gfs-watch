function clearGfsSvgGroup(group){
  if(!group)return;
  while(group.firstChild)group.removeChild(group.firstChild);
}
function escapeGfsTooltip(value){
  return String(value == null ? "" : value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
}
function formatGfsTooltipNumber(value){
  if(value===null||value===undefined||!Number.isFinite(Number(value)))return "—";
  return new Intl.NumberFormat("tr-TR",{minimumFractionDigits:1,maximumFractionDigits:1}).format(Number(value));
}
function formatGfsTooltipTs(validTime){
  // The first F3 point is the 12Z cycle's 15:00 timestamp shown in the
  // report's UTC valid-time key. Keep this report convention as 15:00;
  // do not add another +03:00 offset (that incorrectly turns it into 18:00).
  const utcLabel=String(validTime&&validTime.utcLabel||validTime&&validTime.utc_label||"").trim();
  const match=utcLabel.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})\s+UTC$/i);
  if(match)return match[1]+"."+match[2]+"."+match[3]+" "+match[4]+":"+match[5]+" TSİ";
  return String(validTime&&validTime.label||"").replace(/\s*UTC\b/g,"").trim();
}

function gfsWindCardinal(degrees){
  if(degrees===null||degrees===undefined||!Number.isFinite(Number(degrees)))return "";
  const names=["K","KD","D","GD","G","GB","B","KB"];
  return names[Math.round((Number(degrees)%360)/45)%8];
}
function buildGfsTooltipMarkup(panel,index,validTime,latestOnly){
  const allSeries=(panel.series||[]).slice();
  // Publication metadata is chronological (oldest -> newest). On desktop,
  // show only the final/newest run; mobile keeps the full four-run comparison.
  const visibleSeries=latestOnly ? allSeries.slice(-1) : allSeries.reverse();
  const rows=visibleSeries.map(series=>{
    const value=series.values == null ? void 0 : series.values[index];
    const lead=series.lead_hours == null ? void 0 : series.lead_hours[index];
    const direction=series.directions_deg == null ? void 0 : series.directions_deg[index];
    const formatted=value===null||value===undefined?"—":formatGfsTooltipNumber(value);
    const directionText=panel.id==="wind_10m"&&direction!==null&&direction!==undefined
      ? " · "+gfsWindCardinal(direction)+" ("+Math.round(direction)+"°)" : "";
    return '<div class="gfs-chart-tooltip-row">'+
      '<div class="gfs-chart-tooltip-cycle"><i class="gfs-chart-tooltip-swatch" style="background:'+escapeGfsTooltip(series.color)+'"></i>'+
      '<div class="gfs-chart-tooltip-cycle-name">'+escapeGfsTooltip(String(series.label||"").replace(/^YENİ\s*·\s*/,"").replace(/\s*UTC\b/g,""))+
      '<span class="gfs-chart-tooltip-lead">'+(lead===null||lead===undefined?"Tahmin adımı yok":"F"+escapeGfsTooltip(lead))+'</span></div></div>'+
      '<div class="gfs-chart-tooltip-value">'+formatted+' <small>'+escapeGfsTooltip(panel.unit)+'</small>'+escapeGfsTooltip(directionText)+'</div>'+
      '</div>';
  }).join("");
  const hint=latestOnly
    ? "En yeni döngü · aynı geçerlilik anı · TSİ"
    : "Dört döngü · aynı geçerlilik anı · TSİ";
  return '<div class="gfs-chart-tooltip-head"><div><div class="gfs-chart-tooltip-title">'+escapeGfsTooltip(panel.title)+'</div>'+
    '<div class="gfs-chart-tooltip-time">'+escapeGfsTooltip(formatGfsTooltipTs(validTime))+'</div></div></div>'+
    rows+'<div class="gfs-chart-tooltip-hint">'+hint+'</div>';
}
function positionGfsTooltip(host,tooltip,clientX,clientY){
  if(!Number.isFinite(clientX)||!Number.isFinite(clientY))return;
  const rect=host.getBoundingClientRect();
  tooltip.hidden=false;
  tooltip.style.position="absolute";
  tooltip.style.zIndex="1000";
  tooltip.style.pointerEvents="none";
  tooltip.style.left="0px";
  tooltip.style.top="0px";
  const tw=tooltip.offsetWidth,th=tooltip.offsetHeight;
  const gap=12;
  const x=clientX-rect.left;
  const y=clientY-rect.top;
  const maxLeft=Math.max(8,rect.width-tw-8);
  const maxTop=Math.max(8,rect.height-th-8);
  const left=Math.max(8,Math.min(maxLeft,x-tw/2));
  const top=Math.max(8,Math.min(maxTop,y-th-gap));
  tooltip.style.left=Math.round(left)+"px";
  tooltip.style.top=Math.round(top)+"px";
}
function attachGfsSvgInteractions(host,svg,metadata,syncGroup,latestOnly){
  const panels=new Map((metadata.panels||[]).map(panel=>[panel.id,panel]));
  const panelList=Array.from(panels.values());
  const tooltips=new Map();
  panelList.forEach(panel=>{
    const tip=document.createElement("div");
    tip.className="gfs-chart-tooltip";
    tip.hidden=true;
    tip.setAttribute("role","status");
    tip.setAttribute("aria-live","polite");
    tip.setAttribute("aria-atomic","true");
    host.appendChild(tip);
    tooltips.set(panel.id,tip);
  });
  const activeIndexes=new Map();
  function hide(){
    tooltips.forEach(tip=>tip.hidden=true);
    host.removeAttribute("data-pinned");
    host.style.removeProperty("z-index");
    svg.querySelectorAll(".gfs-tooltip-crosshair").forEach(line=>line.setAttribute("visibility","hidden"));
    svg.querySelectorAll(".gfs-tooltip-markers").forEach(group=>clearGfsSvgGroup(group));
  }
  function panelAtEvent(event){
    const rect=svg.getBoundingClientRect();
    const sx=Number(svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal.width : void 0||0);
    const sy=Number(svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal.height : void 0||0);
    if(!sx||!sy)return null;
    const localX=(event.clientX-rect.left)*(sx/rect.width)+(svg.viewBox.baseVal.x||0);
    const localY=(event.clientY-rect.top)*(sy/rect.height)+(svg.viewBox.baseVal.y||0);
    for(const panel of panelList){
      const plot=panel.plot||{};
      const x=Number(plot.x||0),y=Number(plot.y||0),w=Number(plot.width||0),h=Number(plot.height||0);
      if(localX>=x-28&&localX<=x+w+28&&localY>=y-48&&localY<=y+h+48)return panel;
    }
    return panelList.length===1?panelList[0]:null;
  }
  function anchorForIndex(panel,index){
    const rect=svg.getBoundingClientRect();
    const vb=svg.viewBox.baseVal;
    const x=Number(panel.x_positions == null ? void 0 : panel.x_positions[index]);
    const plot=panel.plot||{};
    const y=Number(plot.y||0)+Number(plot.height||0)*0.45;
    if(!rect.width||!rect.height||!vb.width||!vb.height||!Number.isFinite(x))return null;
    return {
      clientX:rect.left+(x-vb.x)*(rect.width/vb.width),
      clientY:rect.top+(y-vb.y)*(rect.height/vb.height)
    };
  }
  function show(panel,index,event){
    if(!panel || !Array.isArray(panel.valid_times) || !panel.valid_times[index])return;
    const validTime=panel.valid_times[index];
    const overlay=svg.querySelector('.gfs-panel-interaction[data-panel-id="'+panel.id+'"]');
    if(!overlay)return;
    activeIndexes.set(panel.id,index);
    const crosshair=overlay.querySelector(".gfs-tooltip-crosshair");
    const x=panel.x_positions[index];
    crosshair.setAttribute("x1",x);
    crosshair.setAttribute("x2",x);
    crosshair.setAttribute("visibility","visible");
    const markerGroup=overlay.querySelector(".gfs-tooltip-markers");
    clearGfsSvgGroup(markerGroup);
    (panel.series||[]).forEach(series=>{
      const y=series.y_positions == null ? void 0 : series.y_positions[index];
      const value=series.values == null ? void 0 : series.values[index];
      if(y===null||y===undefined||value===null||value===undefined)return;
      const marker=document.createElementNS("http://www.w3.org/2000/svg","circle");
      marker.setAttribute("cx",x);
      marker.setAttribute("cy",y);
      marker.setAttribute("r","5.2");
      marker.setAttribute("fill",series.color);
      marker.setAttribute("stroke","#071724");
      marker.setAttribute("stroke-width","1.7");
      marker.setAttribute("class","gfs-tooltip-marker");
      markerGroup.appendChild(marker);
    });
    const panelTooltip=tooltips.get(panel.id);
    if(!panelTooltip)return;
    panelTooltip.innerHTML=buildGfsTooltipMarkup(panel,index,validTime,latestOnly===true);
    const anchor=event&&Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)
      ? event : (anchorForIndex(panel,index)||event);
    positionGfsTooltip(host,panelTooltip,anchor && anchor.clientX,anchor && anchor.clientY);
  }
  function showSynchronized(index,event){
    if(syncGroup && syncGroup.members && syncGroup.members.length){
      const sourcePanel=panelList[0];
      const sourceTime=sourcePanel && sourcePanel.valid_times != null ? sourcePanel.valid_times[index] : void 0;
      const sourceKey=sourceTime && sourceTime.localKey||sourceTime && sourceTime.utcLabel||sourceTime && sourceTime.label||null;
      syncGroup.members.forEach(member=>{
        const panel=member.panelList[0];
        if(!panel)return;
        let targetIndex=index;
        if(sourceKey){
          const found=panel.valid_times && panel.valid_times.findIndex(item=>
            (item && item.localKey||item && item.utcLabel||item && item.label||null)===sourceKey
          );
          if(found>=0)targetIndex=found;
        }
        if(!Array.isArray(panel.valid_times) || !panel.valid_times[targetIndex])return;
        member.host.style.setProperty("z-index","20","important");
        member.show(panel,targetIndex,member===api ? event : (member.anchorForIndex(panel,targetIndex)||event));
      });
      return;
    }
    // Desktop: one SVG contains all four panels, so activate all four
    // tooltips at the same valid timestamp.
    panelList.forEach(panel=>{
      if(!panel || !Array.isArray(panel.valid_times) || !panel.valid_times[index])return;
      show(panel,index,anchorForIndex(panel,index)||event);
    });
  }
  function selectNearest(event){
    const panel=panelAtEvent(event);
    if(!panel)return;
    const rect=svg.getBoundingClientRect();
    const vb=svg.viewBox.baseVal;
    const localX=(event.clientX-rect.left)*(vb.width/rect.width)+vb.x;
    let nearest=0,best=Infinity;
    panel.x_positions.forEach((x,index)=>{
      const distance=Math.abs(x-localX);
      if(distance<best){best=distance;nearest=index;}
    });
    showSynchronized(nearest,event);
  }
  // Touch scrub is handled at both Pointer Events and the native touch layer.
  // This is deliberate: some mobile WebViews/Safari builds do not continuously
  // dispatch pointermove while the finger is sliding over an SVG.
  svg.style.touchAction="pan-y";
  svg.style.webkitTapHighlightColor="transparent";
  const handleTouchMove=event=>{
    if(event.pointerType&&event.pointerType!=="touch")return;
    if(!host.hasAttribute("data-pinned"))host.setAttribute("data-pinned","true");
    selectNearest(event);
  };
  svg.addEventListener("pointermove",event=>{
    if(event.pointerType==="touch"){
      handleTouchMove(event);
      return;
    }
    if(host.hasAttribute("data-pinned"))return;
    selectNearest(event);
  });
  svg.addEventListener("pointerrawupdate",handleTouchMove,{passive:true});
  svg.addEventListener("touchmove",event=>{
    const touch=event.touches && event.touches[0];
    if(!touch)return;
    handleTouchMove({clientX:touch.clientX,clientY:touch.clientY,pointerType:"touch"});
  },{passive:true});
  svg.addEventListener("pointerdown",event=>{
    if(event.pointerType!=="touch"&&event.pointerType!=="pen")return;
    host.setAttribute("data-pinned","true");
    try{svg.setPointerCapture(event.pointerId);}catch(_){}
    selectNearest(event);
  });
  svg.addEventListener("pointerup",event=>{
    // Do not close the selected tooltip when the finger is lifted.
    // The selected valid time must remain visible across all four mobile panels.
    if(event.pointerType==="touch")host.setAttribute("data-pinned","true");
  });
  svg.addEventListener("pointercancel",event=>{
    // Keep the synchronized selection visible after a cancelled touch sequence.
    if(event.pointerType==="touch")host.setAttribute("data-pinned","true");
  });
  svg.addEventListener("pointerleave",()=>{
    if(!host.hasAttribute("data-pinned"))hide();
  });
  window.addEventListener("scroll",hide,{passive:true,capture:true});
  window.addEventListener("resize",hide,{passive:true});
  svg.addEventListener("keydown",event=>{
    if(event.key==="Escape"){event.preventDefault();hide();return;}
    if(event.key!=="ArrowLeft"&&event.key!=="ArrowRight")return;
    const panel=panelList[0];
    if(!panel)return;
    const current=(activeIndexes.get(panel.id) == null ? 0 : activeIndexes.get(panel.id));
    const next=Math.max(0,Math.min(panel.valid_times.length-1,current+(event.key==="ArrowRight"?1:-1)));
    show(panel,next,{clientX:svg.getBoundingClientRect().left+svg.getBoundingClientRect().width/2,clientY:svg.getBoundingClientRect().top+40});
  });
  const api={host,panelList,show,anchorForIndex};
  if(syncGroup){
    syncGroup.members.push(api);
  }
  host.gfsHideTooltip=hide;
}
function isMobileGfsLayout(){
  const viewportWidth=Math.min(
    Number(window.innerWidth||0),
    Number(document.documentElement && document.documentElement.clientWidth || 0)||Infinity
  );
  return viewportWidth<=700 ||
    window.matchMedia("(max-width:700px)").matches ||
    window.matchMedia("(pointer:coarse)").matches ||
    Number(navigator.maxTouchPoints||0)>0;
}

// Apply the dark report palette directly to the SVG nodes after parsing.
// This protects the live DOM even when a parent stylesheet or old cached CSS wins.
function forceDarkGfsSvg(svg){
  if(!svg)return;
  svg.style.setProperty("background-color","#0A1B29","important");
  svg.style.setProperty("background","#0A1B29","important");
  const fills = new Map([
    ["patch_1","#0A1B29"],
    ["patch_2","#102A3A"],
    ["patch_3","#102A3A"],
    ["patch_4","#102A3A"],
    ["patch_5","#102A3A"],
    ["patch_6","#102A3A"],
    ["patch_11","#102A3A"],
    ["patch_16","#102A3A"],
    ["patch_21","#102A3A"]
  ]);
  // Matplotlib can leave standalone white rectangles for the legend/badge in older SVG assets.
  // Convert only white-filled SVG shapes to the same dark report palette; text remains untouched.
  svg.querySelectorAll("rect,path,polygon").forEach(shape=>{
    const fill=(shape.getAttribute("fill")||"").trim().toLowerCase();
    const style=(shape.getAttribute("style")||"").toLowerCase();
    const isWhite=fill==="white"||fill==="#fff"||fill==="#ffffff"||fill==="rgb(255,255,255)"||/fill\\s*:\\s*(#fff|#ffffff|white|rgb\\(255,255,255\\))/.test(style);
    if(isWhite){
      shape.style.setProperty("fill","#153448","important");
      shape.style.setProperty("stroke","#36586C","important");
      shape.style.setProperty("opacity","0.98","important");
    }
  });
  fills.forEach((fill,id)=>{
    const group=svg.querySelector("#"+id);
    if(!group)return;
    group.querySelectorAll("path,rect,polygon").forEach(shape=>{
      shape.style.setProperty("fill",fill,"important");
      if(id==="patch_2"||id==="patch_3"||id==="patch_4"||id==="patch_5"){
        shape.style.setProperty("stroke","#416174","important");
      }
    });
  });
  const card=svg.closest(".notification-chart-only");
  if(card){
    card.style.setProperty("background","#0A1B29","important");
    card.style.setProperty("border-color","#17384A","important");
  }
}
function addMobileGfsCycleLabels(panelHost,panel,panelSvg){
  if(!panelHost||!panel)return;
  const series=Array.isArray(panel.series)?panel.series:[];
  if(!series.length)return;

  // The Cloudflare renderer writes the same run id onto the plotted SVG path
  // and the interaction metadata. Match by that id and read the actual stroke
  // painted by the graph. Never assign colors from a separate cycle palette.
  const plottedLines=new Map();
  if(panelSvg){
    panelSvg.querySelectorAll("[data-gfs-series-run-id]").forEach(line=>{
      const runId=String(line.getAttribute("data-gfs-series-run-id")||"");
      if(runId)plottedLines.set(runId,line);
    });
  }

  const cycles=series.map((item,index)=>{
    const label=String(item&&item.label||"");
    const match=label.match(/(00|06|12|18)Z/i);
    if(!match)return null;
    const runId=String(item&&item.run_id_utc||"");
    const plotted=plottedLines.get(runId);
    const actualStroke=plotted
      ? String(plotted.getAttribute("stroke")||"").trim()
      : "";
    const metadataColor=String(item&&item.color||"").trim();
    const color=/^#[0-9a-f]{6}$/i.test(actualStroke)
      ? actualStroke
      : (/^#[0-9a-f]{6}$/i.test(metadataColor)?metadataColor:"#8EAEB7");
    const runTime=Date.parse(runId);
    return {
      cycle:match[1].toUpperCase()+"Z",
      runId,
      runTime:Number.isFinite(runTime)?runTime:null,
      index,
      color
    };
  }).filter(Boolean);

  if(!cycles.length)return;

  // Newest -> oldest. The worker's series list is oldest -> newest, so the
  // index fallback also preserves the true graph chronology for legacy SVGs.
  cycles.sort((a,b)=>{
    if(a.runTime!==null&&b.runTime!==null)return b.runTime-a.runTime;
    return b.index-a.index;
  });

  const legend=document.createElement("div");
  legend.className="gfs-mobile-cycle-legend";
  legend.setAttribute("aria-label","GFS döngüleri · grafikteki çizgilerin renkleri");

  Object.assign(legend.style,{
    position:"absolute",
    top:"8px",
    left:"84px",
    right:"84px",
    zIndex:"1100",
    display:"flex",
    alignItems:"center",
    justifyContent:"center",
    gap:"9px",
    flexWrap:"nowrap",
    pointerEvents:"none",
    fontFamily:"inherit",
    lineHeight:"1",
    whiteSpace:"nowrap"
  });

  cycles.forEach(item=>{
    const entry=document.createElement("span");
    entry.setAttribute("aria-label",item.cycle);
    Object.assign(entry.style,{
      color:item.color,
      fontSize:"10px",
      fontWeight:"800",
      textShadow:"0 1px 2px rgba(0,0,0,.7)",
      display:"inline-flex",
      alignItems:"center",
      gap:"3px",
      flex:"0 0 auto"
    });
    const swatch=document.createElement("i");
    Object.assign(swatch.style,{
      display:"inline-block",
      width:"9px",
      height:"3px",
      borderRadius:"2px",
      backgroundColor:item.color,
      flex:"0 0 9px"
    });
    const text=document.createElement("span");
    text.textContent=item.cycle;
    entry.appendChild(swatch);
    entry.appendChild(text);
    legend.appendChild(entry);
  });

  panelHost.appendChild(legend);
}
function removeNativeMobileGfsLegend(svg){
  if(!svg)return;
  const wanted=["00Z","06Z","12Z","18Z"];
  const groups=Array.from(svg.querySelectorAll("g")).filter(group=>{
    const text=(group.textContent||"").replace(/\\s+/g," ").trim();
    return wanted.every(label=>text.includes(label));
  });
  if(!groups.length)return;
  groups.sort((a,b)=>(a.textContent||"").length-(b.textContent||"").length);
  groups[0].remove();
}
function buildMobileGfsPanelViews(sourceSvg,metadata){
  const fallbackPanels=[
    {id:"temperature",title:"Sıcaklık",unit:"°C",plot:{x:105,y:271,width:432,height:146}},
    {id:"temperature_850",title:"850 hPa sıcaklık",unit:"°C",plot:{x:642,y:271,width:432,height:146}},
    {id:"precipitation",title:"Yağış",unit:"mm / 3 saat",plot:{x:105,y:550,width:432,height:146}},
    {id:"wind_10m",title:"10 m rüzgâr hızı",unit:"km/sa",plot:{x:642,y:550,width:432,height:146}}
  ];
  const panels=Array.isArray(metadata && metadata.panels)&&metadata.panels.length===4?metadata.panels:fallbackPanels;
  const views=[];
  panels.forEach((panel,index)=>{
    const plot=panel.plot||{};
    const padX=34;
    const padTop=48;
    const padBottom=34;
    const minX=Math.max(0,Number(plot.x||0)-padX);
    const minY=Math.max(0,Number(plot.y||0)-padTop);
    const maxX=Number(plot.x||0)+Number(plot.width||0)+padX;
    const maxY=Number(plot.y||0)+Number(plot.height||0)+padBottom;
    const cropWidth=Math.max(1,maxX-minX);
    const cropHeight=Math.max(1,maxY-minY);
    const clone=sourceSvg.cloneNode(true);
    clone.classList.add("gfs-interactive-svg","gfs-mobile-panel-svg");
    clone.setAttribute("viewBox",minX+" "+minY+" "+cropWidth+" "+cropHeight);
    clone.setAttribute("width",String(cropWidth));
    clone.setAttribute("height",String(cropHeight));
    clone.setAttribute("preserveAspectRatio","none");
    clone.setAttribute("role","group");
    clone.setAttribute("aria-label",panel.title+" · mobil görünüm");
    
    clone.querySelectorAll(".gfs-panel-interaction").forEach(group=>{
      if(group.getAttribute("data-panel-id")!==panel.id)group.remove();
    });
    views.push({svg:clone,metadata:{version:metadata.version||1,panels:[panel]},index});
  });
  return views;
}

async function loadInteractiveGfsCharts(root){
  const hosts=Array.from(root.querySelectorAll(".gfs-interactive-chart[data-svg-src]:not([data-loaded])"));
  await Promise.all(hosts.map(async host=>{
    host.dataset.loaded="true";
    const source=host.dataset.svgSrc;
    try{
      const response=await fetch(source,{cache:"no-store",credentials:"same-origin"});
      if(!response.ok)throw new Error("SVG HTTP "+response.status);
      let sourceText=await response.text();
      sourceText=sourceText.replace(/^\s*<\?xml[^>]*\?>\s*/i,"").replace(/<!DOCTYPE[\s\S]*?>/i,"");
      const parsed=new DOMParser().parseFromString(sourceText,"image/svg+xml");
      if(parsed.querySelector("parsererror"))throw new Error("SVG parse edilemedi");
      const svg=parsed.documentElement;
      if(svg.localName!=="svg")throw new Error("SVG kök öğesi bulunamadı");
      /* Masaüstündeki yatay genişletilmiş görünümde SVG içeriğini kutuya tam yay. */
      svg.setAttribute("preserveAspectRatio","none");
      svg.querySelectorAll("script,foreignObject").forEach(node=>node.remove());
      svg.querySelectorAll("*").forEach(node=>{
        Array.from(node.attributes).forEach(attribute=>{
          if(/^on/i.test(attribute.name))node.removeAttribute(attribute.name);
        });
      });
      const manifestNode=svg.querySelector("#gfs-interactive-data");
      let metadata={};
      if(manifestNode){
        try{metadata=JSON.parse(manifestNode.textContent||"{}");}catch(_){metadata={};}
        manifestNode.remove();
      }
      if(!Array.isArray(metadata.panels)||metadata.panels.length!==4){
        metadata={version:1,panels:[
          {id:"temperature",title:"Sıcaklık",unit:"°C",plot:{x:105,y:271,width:432,height:146}},
          {id:"temperature_850",title:"850 hPa sıcaklık",unit:"°C",plot:{x:642,y:271,width:432,height:146}},
          {id:"precipitation",title:"Yağış",unit:"mm / 3 saat",plot:{x:105,y:550,width:432,height:146}},
          {id:"wind_10m",title:"10 m rüzgâr hızı",unit:"km/sa",plot:{x:642,y:550,width:432,height:146}}
        ]};
      }
      svg.classList.add("gfs-interactive-svg");
      forceDarkGfsSvg(svg);
      host.style.setProperty("background","#0A1B29","important");
      host.closest(".notification-image-item") && host.closest(".notification-image-item").style.setProperty("background","#0A1B29","important");
      host.closest(".notification-images") && host.closest(".notification-images").style.setProperty("background","#0A1B29","important");
      svg.setAttribute("role","group");
      svg.setAttribute("aria-label",host.dataset.chartLabel||"İstanbul GFS dört panelli etkileşimli valid-time karşılaştırması");
      svg.setAttribute("focusable","true");
      (host.querySelector(".gfs-chart-loading") && host.querySelector(".gfs-chart-loading").remove());
      if(isMobileGfsLayout()){
        const mobileViews=buildMobileGfsPanelViews(svg,metadata);
        if(mobileViews){
          host.dataset.mobilePanels="true";
          host.classList.add("gfs-mobile-panel-stack");
          host.style.setProperty("display","grid","important");
          host.style.setProperty("grid-template-columns","minmax(0,1fr)","important");
          host.style.setProperty("grid-auto-flow","row","important");
          host.style.setProperty("gap","12px","important");
          mobileViews.forEach(({svg:panelSvg,metadata:panelMetadata})=>{
            const panelHost=document.createElement("div");
            panelHost.className="gfs-mobile-panel-host";
            forceDarkGfsSvg(panelSvg);
            removeNativeMobileGfsLegend(panelSvg);
            panelHost.style.setProperty("background","#0A1B29","important");
            // The panel SVG uses a cropped viewBox. Clip everything outside that
            // viewport so the report header and neighboring panels cannot bleed
            // into this card on mobile.
            panelHost.style.setProperty("overflow","hidden","important");
            panelHost.style.setProperty("position","relative","important");
            addMobileGfsCycleLabels(panelHost,panelMetadata.panels && panelMetadata.panels[0],panelSvg);
            panelSvg.style.setProperty("overflow","hidden","important");
            panelHost.appendChild(panelSvg);
            host.appendChild(panelHost);
            const syncGroup=host.__gfsMobileSyncGroup||(host.__gfsMobileSyncGroup={members:[]});
            attachGfsSvgInteractions(panelHost,panelSvg,panelMetadata,syncGroup);
          });
        }else{
          host.appendChild(svg);
          attachGfsSvgInteractions(host,svg,metadata);
        }
      }else{
        host.appendChild(svg);
        // Desktop report: retain synchronized panel tooltips but show only
        // the newest GFS run in each tooltip.
        attachGfsSvgInteractions(host,svg,metadata,null,true);
      }
    }catch(error){
      console.error("[GFS SVG TOOLTIP]",error);
      host.innerHTML="";
      const fallback=document.createElement("a");
      fallback.href=source;
      fallback.target="_blank";
      fallback.rel="noopener";
      fallback.className="gfs-svg-static-fallback";
      fallback.style.setProperty("background","#0A1B29","important");
      host.style.setProperty("background","#0A1B29","important");
      const image=document.createElement("img");
      image.src=source;
      image.alt="Köy GFS dört döngü karşılaştırması";
      image.loading="eager";
      image.decoding="async";
      image.style.cssText="display:block;width:100%;height:auto;max-width:100%;";
      fallback.appendChild(image);
      host.appendChild(fallback);
      const note=document.createElement("div");
      note.className="gfs-chart-error";
      note.textContent="Etkileşimli araç yüklenemedi; grafik statik olarak gösteriliyor."+
        (error&&error.message?" ("+error.message+")":"");
      host.appendChild(note);
      image.addEventListener("error",()=>{
        note.textContent="SVG dosyası alınamadı ("+(error&&error.message?error.message:"yükleme hatası")+"). Dosya adresi: "+source;
        fallback.removeAttribute("href");
      },{once:true});
    }
  }));
}
if(!window.__gfsTooltipDocumentListener){
  window.__gfsTooltipDocumentListener=true;
  document.addEventListener("pointerdown",event=>{
    if(event.target.closest(".gfs-interactive-chart"))return;
    document.querySelectorAll(".gfs-interactive-chart[data-pinned]").forEach(host=>host.gfsHideTooltip && host.gfsHideTooltip());
  });
}
