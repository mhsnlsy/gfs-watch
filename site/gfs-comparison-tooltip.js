function escapeGfsTooltip(value){
  return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
}
function formatGfsTooltipNumber(value){
  if(value===null||value===undefined||!Number.isFinite(Number(value)))return "—";
  return new Intl.NumberFormat("tr-TR",{minimumFractionDigits:1,maximumFractionDigits:1}).format(Number(value));
}
function gfsWindCardinal(degrees){
  if(degrees===null||degrees===undefined||!Number.isFinite(Number(degrees)))return "";
  const names=["K","KD","D","GD","G","GB","B","KB"];
  return names[Math.round((Number(degrees)%360)/45)%8];
}
function buildGfsTooltipMarkup(panel,index,validTime){
  const rows=(panel.series||[]).slice().reverse().map(series=>{
    const value=series.values?.[index];
    const lead=series.lead_hours?.[index];
    const direction=series.directions_deg?.[index];
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
  return '<div class="gfs-chart-tooltip-head"><div><div class="gfs-chart-tooltip-title">'+escapeGfsTooltip(panel.title)+'</div>'+
    '<div class="gfs-chart-tooltip-time">'+escapeGfsTooltip(String(validTime.label||"").replace(/\s*UTC\b/g,""))+'</div></div></div>'+
    rows+'<div class="gfs-chart-tooltip-hint">Dört döngü · aynı geçerlilik anı · TSİ</div>';
}
function positionGfsTooltip(host,tooltip,clientX,clientY,bounds){
  if(!Number.isFinite(clientX)||!Number.isFinite(clientY))return;
  tooltip.hidden=false;
  tooltip.style.position="absolute";
  tooltip.style.zIndex="40";
  tooltip.style.pointerEvents="none";
  tooltip.style.left="0px";
  tooltip.style.top="0px";
  const margin=8,gap=12;
  const width=tooltip.offsetWidth,height=tooltip.offsetHeight;
  const hostRect=host.getBoundingClientRect();
  const x=clientX-hostRect.left;
  const y=clientY-hostRect.top;
  const minLeft=margin;
  const maxLeft=Math.max(minLeft,hostRect.width-width-margin);
  const left=Math.max(minLeft,Math.min(maxLeft,x-width/2));
  const minTop=margin;
  const maxTop=Math.max(minTop,hostRect.height-height-margin);
  let top=y-height-gap;
  if(top<minTop)top=minTop;
  if(top>maxTop)top=maxTop;
  tooltip.style.left=Math.round(left)+"px";
  tooltip.style.top=Math.round(top)+"px";
}
function getGfsPanelClientBounds(host,svg,panel){
  // On mobile each panel has its own host; on desktop derive the panel
  // rectangle from the SVG viewBox so each tooltip remains in its own chart.
  const hostRect=host.getBoundingClientRect();
  const panelCount=(metadata?.panels||[]).length;
  if(panelCount===1)return hostRect;
  const rect=svg.getBoundingClientRect();
  const vb=svg.viewBox.baseVal;
  const plot=panel?.plot||{};
  const x=Number(plot.x||0),y=Number(plot.y||0),w=Number(plot.width||0),h=Number(plot.height||0);
  if(!rect.width||!rect.height||!vb.width||!vb.height||!w||!h)return hostRect;
  const sx=rect.width/vb.width,sy=rect.height/vb.height;
  return {
    left:rect.left+(x-vb.x)*sx,
    top:rect.top+(y-vb.y)*sy,
    right:rect.left+(x+w-vb.x)*sx,
    bottom:rect.top+(y+h-vb.y)*sy
  };
}
function attachGfsSvgInteractions(host,svg,metadata){
  const tooltip=document.createElement("div");
  tooltip.className="gfs-chart-tooltip";
  tooltip.hidden=true;
  tooltip.setAttribute("role","status");
  tooltip.setAttribute("aria-live","polite");
  tooltip.setAttribute("aria-atomic","true");
  host.appendChild(tooltip);
  const panels=new Map((metadata.panels||[]).map(panel=>[panel.id,panel]));
  const panelList=Array.from(panels.values());
  const activeIndexes=new Map();
  function hide(){
    tooltip.hidden=true;
    host.removeAttribute("data-pinned");
    svg.querySelectorAll(".gfs-tooltip-crosshair").forEach(line=>line.setAttribute("visibility","hidden"));
    svg.querySelectorAll(".gfs-tooltip-markers").forEach(group=>group.replaceChildren());
  }
  function panelAtEvent(event){
    const rect=svg.getBoundingClientRect();
    const sx=Number(svg.viewBox?.baseVal?.width||0);
    const sy=Number(svg.viewBox?.baseVal?.height||0);
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
  function show(panel,index,event){
    if(!panel||!panel.valid_times?.[index])return;
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
    markerGroup.replaceChildren();
    (panel.series||[]).forEach(series=>{
      const y=series.y_positions?.[index];
      const value=series.values?.[index];
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
    tooltip.innerHTML=buildGfsTooltipMarkup(panel,index,validTime);
    positionGfsTooltip(host,tooltip,event?.clientX,event?.clientY);
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
    show(panel,nearest,event);
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
    const touch=event.touches?.[0];
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
    if(event.pointerType==="touch")hide();
  });
  svg.addEventListener("pointercancel",event=>{
    if(event.pointerType==="touch")hide();
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
    const current=activeIndexes.get(panel.id)??0;
    const next=Math.max(0,Math.min(panel.valid_times.length-1,current+(event.key==="ArrowRight"?1:-1)));
    show(panel,next,{clientX:svg.getBoundingClientRect().left+svg.getBoundingClientRect().width/2,clientY:svg.getBoundingClientRect().top+40});
  });
  host.gfsHideTooltip=hide;
}
function isMobileGfsLayout(){
  const viewportWidth=Math.min(
    Number(window.innerWidth||0),
    Number(document.documentElement?.clientWidth||0)||Infinity
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
function buildMobileGfsPanelViews(sourceSvg,metadata){
  const fallbackPanels=[
    {id:"temperature",title:"Sıcaklık",unit:"°C",plot:{x:105,y:271,width:432,height:146}},
    {id:"temperature_850",title:"850 hPa sıcaklık",unit:"°C",plot:{x:642,y:271,width:432,height:146}},
    {id:"precipitation",title:"Yağış",unit:"mm / 3 saat",plot:{x:105,y:550,width:432,height:146}},
    {id:"wind_10m",title:"10 m rüzgâr hızı",unit:"km/sa",plot:{x:642,y:550,width:432,height:146}}
  ];
  const panels=Array.isArray(metadata?.panels)&&metadata.panels.length===4?metadata.panels:fallbackPanels;
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
      host.closest(".notification-image-item")?.style.setProperty("background","#0A1B29","important");
      host.closest(".notification-images")?.style.setProperty("background","#0A1B29","important");
      svg.setAttribute("role","group");
      svg.setAttribute("aria-label",host.dataset.chartLabel||"İstanbul GFS dört panelli etkileşimli valid-time karşılaştırması");
      svg.setAttribute("focusable","true");
      host.querySelector(".gfs-chart-loading")?.remove();
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
            panelHost.style.setProperty("background","#0A1B29","important");
            panelHost.appendChild(panelSvg);
            host.appendChild(panelHost);
            attachGfsSvgInteractions(panelHost,panelSvg,panelMetadata);
          });
        }else{
          host.appendChild(svg);
          attachGfsSvgInteractions(host,svg,metadata);
        }
      }else{
        host.appendChild(svg);
        attachGfsSvgInteractions(host,svg,metadata);
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
    document.querySelectorAll(".gfs-interactive-chart[data-pinned]").forEach(host=>host.gfsHideTooltip?.());
  });
}
