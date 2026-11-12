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
    const timeline=commonTimeline(runs);
    if(!timeline.length) throw new Error("ECMWF döngülerinin ortak geçerlilik saatleri bulunamadı.");

    const W=1152,H=838,panelWidth=505,panelHeight=250;
    const panelLeft=[55,592],panelTop=[214,493];
    const specs=[
      {id:"temperature",title:"2 m Sıcaklık",unit:"°C",field:"temperature"},
      {id:"temperature_850",title:"850 hPa Sıcaklık",unit:"°C",field:"temperature_850"},
      {id:"precipitation",title:"6 Saatlik Yağış",unit:"mm",field:"precipitation"},
      {id:"wind_10m",title:"10 m Rüzgâr",unit:"km/sa",field:"wind"}
    ];

    const offsets=timeline.map((_,i)=>i);
    const xRatio=i => 0.03 + (i/Math.max(1,timeline.length-1))*0.94;
    const panels=[];
    let body="";
    body+='<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" role="img" aria-labelledby="ecmwf-svg-title ecmwf-svg-desc">';
    body+='<title id="ecmwf-svg-title">İstanbul ECMWF · dört döngü valid-time karşılaştırması</title>';
    body+='<desc id="ecmwf-svg-desc">Son dört ECMWF döngüsü aynı geçerlilik saatlerinde karşılaştırılır. 2 metre sıcaklık, 850 hPa sıcaklık, yağış ve 10 metre rüzgâr.</desc>';
    body+='<rect id="patch_1" x="0" y="0" width="'+W+'" height="'+H+'" rx="13" fill="#0A1B29"/>';
    body+='<text x="55" y="42" fill="#7DD3D7" font-size="12" font-weight="700" letter-spacing="1.5" font-family="DM Sans,Arial,sans-serif">ECMWF IFS · İSTANBUL</text>';
    body+='<text x="55" y="76" fill="#FFFFFF" font-size="27" font-weight="750" font-family="Manrope,Arial,sans-serif">Son ECMWF raporu · '+runs.length+' döngü karşılaştırması</text>';
    body+='<text x="55" y="108" fill="#E7F2F6" font-size="14" font-family="DM Sans,Arial,sans-serif">Aynı geçerlilik saatleri (TSİ) üst üste karşılaştırılır.</text>';
    body+='<rect x="830" y="20" width="267" height="36" rx="11" fill="#0A1B29" stroke="#416174" stroke-width="1"/>';
    body+='<text x="963.5" y="43" text-anchor="middle" fill="#B8D7DF" font-size="12" font-family="DM Sans,Arial,sans-serif">'+runs.length+' ECMWF döngüsü karşılaştırılıyor</text>';

    runs.slice().reverse().forEach((run,i)=>{
      const x=360+(i%2)*260,y=148+Math.floor(i/2)*26;
      const latest=i===0;
      body+='<line x1="'+x+'" y1="'+y+'" x2="'+(x+36)+'" y2="'+y+'" stroke="'+COLORS[runs.length-1-i]+'" stroke-width="'+(latest?3.2:1.8)+'"'+(latest?'':' stroke-dasharray="4 3"')+' stroke-linecap="round"/>';
      body+='<text x="'+(x+47)+'" y="'+(y+4)+'" fill="#FFFFFF" font-size="12" font-weight="'+(latest?'700':'500')+'" font-family="DM Sans,Arial,sans-serif">ECMWF · '+new Date(run.run_id_utc).toISOString().slice(11,13)+'Z</text>';
    });

    specs.forEach((spec,pi)=>{
      const col=pi%2,row=Math.floor(pi/2),px=panelLeft[col],py=panelTop[row];
      const plotX=px+50,plotY=py+57,plotWidth=panelWidth-73,plotHeight=146;
      const series=runs.map(run=>timeline.map(t=>fieldValue(t.points[runs.indexOf(run)],spec.field)));
      const a=axis(spec.field,series);
      const xPositions=offsets.map(i=>plotX+xRatio(i)*plotWidth);
      const yFor=v=>plotY+(a.high-v)*plotHeight/(a.high-a.low);
      const panelMeta={
        id:spec.id,title:spec.title,unit:spec.unit,
        plot:{x:plotX,y:plotY,width:plotWidth,height:plotHeight},
        x_positions:xPositions,
        valid_times:timeline.map(t=>({localKey:t.key,label:tsLabel(t.key),utcLabel:utcLabel(t.key)})),
        series:[]
      };

      body+='<g id="patch_'+(pi===0?6:pi===1?11:pi===2?16:21)+'"><rect x="'+px+'" y="'+py+'" width="'+panelWidth+'" height="'+panelHeight+'" rx="13" fill="#102A3A" stroke="#416174" stroke-width="1"/></g>';
      body+='<g id="ecmwf-panel-'+spec.id+'">';
      body+='<text x="'+(px+18)+'" y="'+(py+31)+'" fill="#FFFFFF" font-size="18" font-weight="700" font-family="DM Sans,Arial,sans-serif">'+esc(spec.title)+'</text>';
      body+='<text x="'+(px+panelWidth-17)+'" y="'+(py+30)+'" text-anchor="end" fill="#E7F2F6" font-size="12" font-weight="650" font-family="DM Sans,Arial,sans-serif">'+esc(spec.unit)+'</text>';

      a.ticks.slice().reverse().forEach(v=>{
        const y=yFor(v);
        body+='<line x1="'+plotX+'" y1="'+y+'" x2="'+(plotX+plotWidth)+'" y2="'+y+'" stroke="#456579" stroke-width="1" stroke-dasharray="2 4" opacity=".65"/>';
        body+='<text x="'+(plotX-10)+'" y="'+(y+4)+'" text-anchor="end" fill="#E7F2F6" font-size="11" font-weight="600" font-family="DM Sans,Arial,sans-serif">'+v+'</text>';
      });

      const tickIndexes=[];
      timeline.forEach((t,i)=>{
        const hour=new Date(t.key).getUTCHours();
        if(i===0 || hour===0 || hour===12)tickIndexes.push(i);
      });
      if(tickIndexes[tickIndexes.length-1]!==timeline.length-1)tickIndexes.push(timeline.length-1);
      tickIndexes.forEach(i=>{
        const d=new Date(timeline[i].key);
        const day=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit"}).format(d);
        const weekday=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",weekday:"short"}).format(d);
        const anchor=i===0?"start":i===timeline.length-1?"end":"middle";
        body+='<text x="'+xPositions[i]+'" y="'+(plotY+plotHeight+19)+'" text-anchor="'+anchor+'" fill="#E7F2F6" font-size="10" font-weight="650" font-family="DM Sans,Arial,sans-serif"><tspan x="'+xPositions[i]+'">'+day+'</tspan><tspan x="'+xPositions[i]+'" dy="13">'+weekday+'</tspan></text>';
      });

      runs.forEach((run,si)=>{
        const values=series[si];
        const yPositions=values.map(v=>num(v)?Number(yFor(v).toFixed(3)):null);
        const leadHours=timeline.map(t=>Number(t.points[si].forecast_hour));
        const directions=timeline.map(t=>spec.field==="wind"?t.points[si].wind_direction_10m_deg:null);
        const color=COLORS[si];
        let path="",open=false;
        values.forEach((v,i)=>{
          if(!num(v)){open=false;return;}
          path+=(open?" L ":" M ")+xPositions[i].toFixed(3)+" "+yPositions[i];
          open=true;
        });
        const latest=si===runs.length-1;
        body+='<path id="gfs-series-'+spec.id+'-'+si+'" data-gfs-series-run-id="'+esc(run.run_id_utc)+'" d="'+path+'" fill="none" stroke="'+color+'" stroke-width="'+(latest?3.2:1.8)+'"'+(latest?'':' stroke-dasharray="4 3"')+' stroke-linecap="round" stroke-linejoin="round" opacity="'+(latest?"1":".94")+'"/>';
        if(latest){
          values.forEach((v,i)=>{
            if(num(v))body+='<circle cx="'+xPositions[i].toFixed(3)+'" cy="'+yPositions[i]+'" r="2.8" fill="'+color+'"/>';
          });
        }
        panelMeta.series.push({
          label:"ECMWF · "+new Date(run.run_id_utc).toISOString().slice(11,13)+"Z",
          run_id_utc:run.run_id_utc,color,lead_hours:leadHours,values,y_positions:yPositions,directions_deg:directions
        });
      });

      body+='<g class="gfs-panel-interaction" data-panel-id="'+spec.id+'"><line class="gfs-tooltip-crosshair" x1="'+xPositions[0]+'" x2="'+xPositions[0]+'" y1="'+plotY+'" y2="'+(plotY+plotHeight)+'" stroke="#E8FBF7" stroke-width="1" stroke-dasharray="3 4" opacity=".78" visibility="hidden"/><g class="gfs-tooltip-markers"></g></g>';
      body+='</g>';
      panels.push(panelMeta);
    });

    body+='<text x="63" y="810" fill="#E7F2F6" font-size="11" font-family="DM Sans,Arial,sans-serif">Aynı geçerlilik saatleri (TSİ) · '+timeline.length+' ortak nokta · '+runs.length+' döngü</text>';
    body+='<text x="1090" y="810" text-anchor="end" fill="#E7F2F6" font-size="10" font-family="DM Sans,Arial,sans-serif">Kaynak: MeteoPT ECMWF · İstanbul 41.0901°N 28.9436°E</text>';
    const meta=JSON.stringify({version:1,renderer:"cloudflare-js-v9-homepage-identical-ecmwf",panels}).replace(/\]\]>/g,"]]\\u003e");
    body+='<metadata id="gfs-interactive-data"><![CDATA['+meta+']]></metadata></svg>';
    return body;
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