(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const num = v => typeof v === "number" && Number.isFinite(v);
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
  const fmt = (v, d=1) => num(v)
    ? Number(v).toLocaleString("tr-TR",{minimumFractionDigits:d,maximumFractionDigits:d})
    : "—";

  const COLORS = ["#8ABCE8","#55D6C2","#F5B942","#C084FC"];

  function tsLabel(utc) {
    const d = new Date(utc);
    const day = new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"2-digit"}).format(d);
    const weekday = new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",weekday:"long"}).format(d);
    const clock = new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(d);
    return day+" "+weekday+" · "+clock+" TSİ";
  }
  function utcLabel(utc) {
    const d = new Date(utc);
    const day = new Intl.DateTimeFormat("tr-TR",{timeZone:"UTC",day:"2-digit",month:"2-digit",year:"numeric"}).format(d);
    const clock = new Intl.DateTimeFormat("tr-TR",{timeZone:"UTC",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(d);
    return day+" "+clock+" UTC";
  }
  function shortRun(utc) {
    return new Intl.DateTimeFormat("tr-TR",{timeZone:"UTC",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(utc));
  }

  function dewPointFromTempRh(t, rh) {
    if(!num(t) || !num(rh) || rh <= 0) return null;
    const a=17.62,b=243.12;
    const gamma=Math.log(rh/100)+(a*t)/(b+t);
    return b*gamma/(a-gamma);
  }

  function commonTimeline(runs) {
    const maps=runs.map(run => new Map(
      (Array.isArray(run.forecasts)?run.forecasts:[])
        .filter(p=>p && p.valid_time_utc)
        .map(p=>[new Date(p.valid_time_utc).toISOString(),p])
    ));
    if(!maps.length)return [];
    const keys=[...maps[0].keys()].filter(key=>maps.every(m=>m.has(key)));
    return keys.sort().map(key=>({key,points:maps.map(m=>m.get(key))}));
  }

  function axis(field, series) {
    const values=series.flat().filter(num);
    const latest=series[series.length-1]||[];
    const latestValues=latest.filter(num);
    let step=field==="precipitation"?((Math.max(...values,0)>16)?2:1):(field==="wind"?10:5);
    let low=0, high=step;
    if(field==="temperature"||field==="temperature_850"){
      const source=values.length?values:latestValues;
      low=Math.floor(Math.min(...source)/step)*step-step;
      high=Math.ceil(Math.max(...source)/step)*step;
      if(high-low<step)high=low+step;
    } else {
      high=Math.ceil(Math.max(...values,0)/step)*step||step;
    }
    if(field==="temperature"||field==="temperature_850"){
      const latestPeak=latestValues.length?Math.max(...latestValues):null;
      if(latestPeak!==null && high-latestPeak<=step*.25)high+=step;
    }
    const ticks=[];
    for(let v=low;v<=high+1e-9;v+=step)ticks.push(Math.round(v));
    return {low,high,ticks,step};
  }

  function fieldValue(point, field) {
    if(field==="temperature")return point.temperature_2m_c;
    if(field==="precipitation")return point.precipitation_interval_mm;
    if(field==="temperature_850")return point.temperature_850hpa_c;
    if(field==="wind")return point.wind_speed_10m_kmh;
    return null;
  }

  function buildSvg(runs) {
    const ordered = (Array.isArray(runs) ? runs : []).filter(Boolean).slice().sort((a,b)=>Date.parse(a.run_id_utc)-Date.parse(b.run_id_utc)).slice(-4);
    if (!ordered.length) throw new Error("ECMWF döngüsü bulunamadı.");

    const series = ordered.map((run,index) => ({
      run,
      color: COLORS.slice(-ordered.length)[index],
      points: new Map((Array.isArray(run.forecasts)?run.forecasts:[])
        .filter(p=>p && p.valid_time_utc)
        .map(p=>[new Date(p.valid_time_utc).toISOString().slice(0,16),p]))
    }));
    let common=[...series[series.length-1].points.keys()];
    for(const item of series.slice(0,-1)) common=common.filter(k=>item.points.has(k));
    common.sort();
    if(common.length<2) throw new Error("ECMWF döngülerinin ortak geçerlilik saatleri bulunamadı.");
    const firstMs=Date.parse(common[0]+":00Z");
    const validKeys=common.filter(k=>Date.parse(k+":00Z")<=firstMs+180*3600000);
    const pointsBySeries=series.map(s=>validKeys.map(k=>s.points.get(k)));
    const dates=validKeys.map(k=>new Date(k+":00Z"));
    const offsets=dates.map(d=>(d.getTime()-firstMs)/3600000);
    const localLabels=dates.map(utc=>({
      label:tsLabel(utc.toISOString()),
      utcLabel:utcLabel(utc.toISOString())
    }));

    const W=1152,H=838,panelWidth=505,panelHeight=250;
    const panelLeft=[55,592],panelTop=[214,493];
    const firstOffset=offsets[0];
    const spanHours=offsets[offsets.length-1]-firstOffset;
    const xMin=-1,xMax=spanHours+Math.max(1,spanHours*.015);
    const xRatio=v=>(v-xMin)/(xMax-xMin);
    const FONT="system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
    const specs=[
      {id:"temperature",field:"temperature_2m_c",title:"Sıcaklık",unit:"°C"},
      {id:"temperature_850",field:"temperature_850hpa_c",title:"850 hPa sıcaklık",unit:"°C"},
      {id:"precipitation",field:"precipitation_interval_mm",title:"Yağış",unit:"mm / 3 saat"},
      {id:"wind_10m",field:"wind_speed_10m_kmh",title:"10 m rüzgâr hızı",unit:"km/sa"}
    ];
    const escXml=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));
    const numeric=v=>v===null||v===undefined||v===""?null:(Number.isFinite(Number(v))?Number(v):null);
    const axis=(field,valuesBySeries)=>{
      const latest=(valuesBySeries[valuesBySeries.length-1]||[]).filter(v=>v!==null);
      const all=valuesBySeries.flat().filter(v=>v!==null);
      const step=field==="precipitation_interval_mm"?(Math.max(...all,0)>16?2:1):(field==="wind_speed_10m_kmh"?10:5);
      let low=0,high=step;
      const temp=field==="temperature_2m_c"||field==="temperature_850hpa_c";
      if(temp){
        const source=all.length?all:latest;
        low=Math.floor(Math.min(...source)/step)*step;
        high=Math.ceil(Math.max(...source)/step)*step;
      }else high=Math.ceil(Math.max(0,...all)/step)*step||step;
      const peak=latest.length?Math.max(...latest):null;
      if((temp||field==="precipitation_interval_mm")&&peak!==null&&high-peak<=step*.25)high+=step;
      if(!Number.isFinite(low)||!Number.isFinite(high)||high<=low){low=0;high=step;}
      const ticks=[];for(let v=low;v<=high+1e-9;v+=step)ticks.push(Math.round(v));
      return {low,high,ticks,latestPeak:peak};
    };

    const parts=[
      '<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" role="img" aria-labelledby="ecmwf-svg-title ecmwf-svg-desc">',
      '<title id="ecmwf-svg-title">İstanbul ECMWF · dört döngü valid-time karşılaştırması</title>',
      '<desc id="ecmwf-svg-desc">Dört İstanbul ECMWF tahmin döngüsü aynı geçerlilik saatlerinde hizalanmıştır. Sıcaklık, 850 hPa sıcaklığı, yağış ve 10 metre rüzgârı karşılaştırılır.</desc>',
      '<g id="patch_1"><rect x="0" y="0" width="1152" height="838" style="fill: #0a1b29"/></g>',
      '<text x="63" y="34" fill="#7DD3D7" font-size="12" font-weight="700" letter-spacing="1.5" font-family="'+FONT+'">ECMWF IFS · İSTANBUL</text>',
      '<text x="1090" y="34" text-anchor="end" fill="#8EAEB7" font-size="8" font-weight="500" font-family="'+FONT+'">İstanbul Havası v1.5.0</text>',
      '<text x="63" y="76" fill="#FFFFFF" font-size="27" font-weight="750" font-family="'+FONT+'">Son ECMWF raporu · '+series.length+' döngü karşılaştırması</text>',
      '<text x="63" y="108" fill="#E7F2F6" font-size="14" font-family="'+FONT+'">Mevcut ECMWF çıktıları aynı geçerlilik saatlerinde (TSİ) üst üste karşılaştırılır.</text>',
      '<rect x="850" y="20" width="245" height="36" rx="11" fill="#0A1B29" stroke="#416174" stroke-width="1"/>',
      '<text x="972.5" y="43" text-anchor="middle" fill="#B8D7DF" font-size="12" font-family="'+FONT+'">'+series.length+' ECMWF döngüsü karşılaştırılıyor</text>'
    ];

    series.slice().reverse().forEach((item,index)=>{
      const column=index%2,row=Math.floor(index/2),x=335+column*290,y=148+row*26,latest=item===series[series.length-1];
      const d=new Date(item.run.run_id_utc);
      const label=(latest?"YENİ · ":"")+String(d.getUTCHours()).padStart(2,"0")+"Z | "+String(d.getUTCDate()).padStart(2,"0")+"."+String(d.getUTCMonth()+1).padStart(2,"0")+" "+String(d.getUTCHours()).padStart(2,"0")+":00";
      parts.push('<line x1="'+x+'" y1="'+y+'" x2="'+(x+38)+'" y2="'+y+'" stroke="'+item.color+'" stroke-width="'+(latest?3.2:1.8)+'"'+(latest?'':' stroke-dasharray="4 3"')+' stroke-linecap="round"/>',
        '<text x="'+(x+49)+'" y="'+(y+4)+'" fill="#FFFFFF" font-size="12" font-weight="'+(latest?"700":"500")+'" font-family="'+FONT+'">'+escXml("ECMWF · "+label)+'</text>');
    });

    const metadata=[];
    specs.forEach((spec,pi)=>{
      const col=pi%2,row=Math.floor(pi/2),px=panelLeft[col],py=panelTop[row];
      const plotX=px+50,plotY=py+57,plotWidth=panelWidth-73,plotHeight=146;
      const valuesBySeries=pointsBySeries.map(points=>points.map(p=>numeric(p?.[spec.field])));
      const a=axis(spec.field,valuesBySeries);
      const xPositions=offsets.map(v=>plotX+xRatio(v)*plotWidth);
      const yFor=v=>plotY+(a.high-v)*plotHeight/(a.high-a.low);
      const patchId=["patch_6","patch_11","patch_16","patch_21"][pi];
      parts.push('<g id="'+patchId+'"><rect x="'+px+'" y="'+py+'" width="'+panelWidth+'" height="'+panelHeight+'" rx="13" style="fill: #102a3a" stroke="#416174" stroke-width="1"/></g>',
        '<g id="ecmwf-panel-'+spec.id+'">',
        '<text x="'+(px+18)+'" y="'+(py+31)+'" fill="#FFFFFF" font-size="18" font-weight="700" font-family="'+FONT+'">'+escXml(spec.title)+'</text>',
        '<text x="'+(px+panelWidth-17)+'" y="'+(py+30)+'" text-anchor="end" fill="#E7F2F6" font-size="12" font-weight="650" font-family="'+FONT+'">'+escXml(spec.unit)+'</text>');
      a.ticks.slice().reverse().forEach(v=>{
        const y=yFor(v);
        parts.push('<line x1="'+plotX+'" y1="'+y+'" x2="'+(plotX+plotWidth)+'" y2="'+y+'" stroke="#456579" stroke-width="1" stroke-dasharray="2 4" opacity=".65"/>',
          '<text x="'+(plotX-10)+'" y="'+(y+4)+'" text-anchor="end" fill="#E7F2F6" font-size="11" font-weight="600" font-family="'+FONT+'" data-axis-tick="true">'+v+'</text>');
      });
      const tickIndexes=[];offsets.forEach((offset,i)=>{if(i===0||Math.abs(offset%12)<.01)tickIndexes.push(i);});
      if(tickIndexes[tickIndexes.length-1]!==offsets.length-1)tickIndexes.push(offsets.length-1);
      tickIndexes.forEach(i=>{
        const d=new Date(dates[i].getTime()+3*3600000),day=String(d.getUTCDate()).padStart(2,"0"),wd=["Paz","Pzt","Sal","Çar","Per","Cum","Cmt"][d.getUTCDay()];
        const anchor=i===0?"start":i===offsets.length-1?"end":"middle";
        parts.push('<text x="'+xPositions[i]+'" y="'+(plotY+plotHeight+19)+'" text-anchor="'+anchor+'" fill="#E7F2F6" font-size="10" font-weight="650" font-family="'+FONT+'"><tspan x="'+xPositions[i]+'">'+day+'</tspan><tspan x="'+xPositions[i]+'" dy="13">'+wd+'</tspan></text>');
      });

      const panelSeries=[];
      series.forEach((item,si)=>{
        const values=valuesBySeries[si];
        const plotValues=values.map(v=>v===null||v<a.low||v>a.high?null:v);
        const yPositions=plotValues.map(v=>v===null?null:Number(yFor(v).toFixed(3)));
        const leadHours=pointsBySeries[si].map(p=>numeric(p?.forecast_hour));
        const directions=pointsBySeries[si].map(p=>spec.field==="wind_speed_10m_kmh"?numeric(p?.wind_direction_10m_deg):null);
        let path="",open=false;plotValues.forEach((v,i)=>{if(v===null){open=false;return;}path+=(open?" L ":" M ")+xPositions[i].toFixed(3)+" "+yPositions[i];open=true;});
        const latest=si===series.length-1;
        parts.push('<path id="gfs-series-'+spec.id+'-'+si+'" data-gfs-series-run-id="'+escXml(item.run.run_id_utc)+'" d="'+path+'" fill="none" stroke="'+item.color+'" stroke-width="'+(latest?3.2:1.8)+'"'+(latest?'':' stroke-dasharray="4 3"')+' stroke-linecap="round" stroke-linejoin="round" opacity="'+(latest?"1":".94")+'"/>');
        if(latest)values.forEach((v,i)=>{if(v!==null)parts.push('<circle cx="'+xPositions[i].toFixed(3)+'" cy="'+yPositions[i]+'" r="2.8" fill="'+item.color+'"/>');});
        panelSeries.push({label:"ECMWF · "+String(new Date(item.run.run_id_utc).getUTCHours()).padStart(2,"0")+"Z",run_id_utc:item.run.run_id_utc,color:item.color,lead_hours:leadHours,values,y_positions:yPositions,directions_deg:directions});
      });
      parts.push('<g class="gfs-panel-interaction" data-panel-id="'+spec.id+'"><rect class="gfs-hit-area" data-panel-id="'+spec.id+'" x="'+plotX+'" y="'+plotY+'" width="'+plotWidth+'" height="'+plotHeight+'" fill="transparent" pointer-events="all" tabindex="0" role="group" aria-label="'+escXml(spec.title)+' grafiği; ok tuşlarıyla geçerlilik saatleri arasında gezinin"/><line class="gfs-tooltip-crosshair" x1="'+xPositions[0]+'" x2="'+xPositions[0]+'" y1="'+plotY+'" y2="'+(plotY+plotHeight)+'" stroke="#EAF5F8" stroke-width="1.1" stroke-dasharray="4 4" opacity=".78" visibility="hidden" pointer-events="none"/><g class="gfs-tooltip-markers" pointer-events="none"></g></g>');
      parts.push("</g>");
      metadata.push({id:spec.id,title:spec.title,unit:spec.unit,plot:{x:plotX,y:plotY,width:plotWidth,height:plotHeight},x_positions:xPositions.map(v=>Number(v.toFixed(3))),valid_times:localLabels.map(x=>({local_key:x.label,label:x.label,utc_label:x.utcLabel})),series:panelSeries});
    });
    const metadataText=JSON.stringify({version:1,renderer:"cloudflare-js-v3-ecmwf-clone",panels:metadata}).replace(/\]\]>/g,"]]\\u003e");
    parts.push('<text x="63" y="810" fill="#E7F2F6" font-size="11" font-family="'+FONT+'">Aynı geçerlilik saatleri (TSİ) · '+validKeys.length+' ortak nokta · '+series.length+' döngü</text>',
      '<text x="1090" y="810" text-anchor="end" fill="#E7F2F6" font-size="10" font-family="'+FONT+'">Kaynak: MeteoPT ECMWF · İstanbul nokta tahmini</text>',
      '<metadata id="gfs-renderer-version">cloudflare-js-v3-ecmwf-clone</metadata>',
      '<metadata id="gfs-interactive-data"><![CDATA['+metadataText+']]></metadata></svg>');
    return parts.join("");
  }
  function renderSvg(runs) {
    const host=$("ecmwf-gfs-comparison-container");
    if(!host)return;
    const chart=host.querySelector(".gfs-interactive-chart");
    if(!chart)return;
    chart.innerHTML="";
    const svgText=buildSvg(runs);
    const doc=new DOMParser().parseFromString(svgText,"image/svg+xml");
    const svg=doc.documentElement;
    chart.appendChild(document.importNode(svg,true));
    const liveSvg=chart.querySelector("svg");
    const metadataNode=liveSvg&&liveSvg.querySelector("#gfs-interactive-data");
    if(!liveSvg||!metadataNode)return;
    let metadata;
    try{metadata=JSON.parse(metadataNode.textContent||"{}");}catch(_){return;}
    if(typeof attachGfsSvgInteractions==="function"){
      attachGfsSvgInteractions(chart,liveSvg,metadata,null,isMobileGfsLayout());
    }
  }

  function renderTable(doc) {
    const body=$("meteopt-table-body");
    if(!body)return;
    const rows=Array.isArray(doc.forecasts)?doc.forecasts:[];
    if(!rows.length){
      body.innerHTML='<tr><td colspan="10" class="meteopt-table-empty">ECMWF F180 tahmin adımları henüz yok.</td></tr>';
      return;
    }
    body.innerHTML=rows.map(p=>{
      const t850=p.temperature_850hpa&&p.temperature_850hpa.mean_c;
      const w850=p.wind_850hpa&&p.wind_850hpa.mean_kmh;
      const direction10=p.wind_direction_10m_deg;
      const direction850=p.wind_direction_850hpa_deg;
      return '<tr>'+
        '<td>F'+esc(p.forecast_hour)+'</td>'+
        '<td>'+esc(tsLabel(p.valid_time_utc))+'</td>'+
        '<td>'+fmt(p.temperature_2m_c)+'°</td>'+
        '<td>'+fmt(p.precipitation_interval_mm)+' mm</td>'+
        '<td>'+fmt(p.wind_speed_10m_kmh,0)+' km/sa'+(num(direction10)?' · '+Math.round(direction10)+'°':'')+'</td>'+
        '<td>'+fmt(t850)+'°</td>'+
        '<td>'+fmt(w850,0)+' km/sa'+(num(direction850)?' · '+Math.round(direction850)+'°':'')+'</td>'+
        '<td>—</td><td>—</td><td>—</td>'+
      '</tr>';
    }).join("");
  }

  async function load() {
    const status=$("ecmwf-table-status");
    try{
      const response=await fetch("/api/ecmwf/latest?t="+Date.now(),{cache:"no-store"});
      if(!response.ok)throw new Error("HTTP "+response.status);
      const doc=await response.json();
      if(!doc||doc.schema!=="gfs-watch.ecmwf-eps.v1"||doc.status!=="ready")throw new Error("ECMWF veri paketi hazır değil.");
      const runs=(Array.isArray(doc.comparison_runs)?doc.comparison_runs:[]).filter(Boolean).slice(-4);
      const allRuns=runs.length?[...runs].sort((a,b)=>Date.parse(a.run_id_utc)-Date.parse(b.run_id_utc)):[doc];
      renderSvg(allRuns);
      renderTable(doc);
      $("ecmwf-run-meta").textContent="Döngü: "+shortRun(doc.run_id_utc)+" UTC · Geçerlilik: +"+doc.forecast_horizon_hours+" saat";
      $("ecmwf-updated").textContent="Yayınlandı: "+shortRun(doc.updated_at_utc)+" TSİ";
      $("ecmwf-table-run").textContent="Döngü: "+shortRun(doc.run_id_utc)+" UTC";
      $("ecmwf-table-updated").textContent="Yayınlandı: "+shortRun(doc.updated_at_utc)+" TSİ";
      status.textContent="Güncel · MeteoPT ECMWF";
    }catch(error){
      status.textContent="ECMWF verisi alınamadı · "+(error.message||"geçici bağlantı sorunu");
    }
  }

  load();
  window.setInterval(load,300000);
})();