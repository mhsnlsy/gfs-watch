(function(){
  if(!Promise.allSettled){
    Promise.allSettled=function(items){
      return Promise.all(items.map(function(item){
        return Promise.resolve(item).then(function(value){
          return {status:"fulfilled",value:value};
        },function(reason){
          return {status:"rejected",reason:reason};
        });
      }));
    };
  }
  if(!Array.prototype.flatMap){
    Array.prototype.flatMap=function(fn){
      var out=[];
      for(var i=0;i<this.length;i++){
        var v=fn(this[i],i,this);
        if(Array.isArray(v)) out.push.apply(out,v); else out.push(v);
      }
      return out;
    };
  }
  if(!String.prototype.padStart){
    String.prototype.padStart=function(len,fill){
      var s=String(this),f=fill==null?" ":String(fill);
      while(s.length<len)s=f+s;
      return s.slice(-len);
    };
  }
})();

(() => {
"use strict";
const GFS_CYCLE_THEME=window.GFS_CYCLE_THEME;
const BASE=(window.GFS_WATCH_API_BASE||window.location.origin)+"/api/koy-gfs/", COLORS=GFS_CYCLE_THEME.colors;
const STATIONS_API=(window.GFS_WATCH_API_BASE||window.location.origin)+"/api";
const $=id=>document.getElementById(id);
const num=v=>v==null||v===""||!Number.isFinite(Number(v))?null:Number(v);
const fmt=(v,d=1)=>v==null?"—":Number(v).toLocaleString("tr-TR",{minimumFractionDigits:d,maximumFractionDigits:d});
const esc=s=>String(s == null ? "" : s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const ts=v=>{if(!v)return "—";const d=new Date(v);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}).format(d)+" TSİ":"—"};
const tsGfsValid=v=>{if(!v)return "—";const d=new Date(v);if(!Number.isFinite(d.getTime()))return "—";const date=new Intl.DateTimeFormat("en-GB",{timeZone:"UTC",day:"2-digit",month:"2-digit"}).format(d);const weekday=new Intl.DateTimeFormat("en-GB",{timeZone:"UTC",weekday:"short"}).format(d);const clock=new Intl.DateTimeFormat("en-GB",{timeZone:"UTC",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(d);return date+" "+weekday+" · "+clock+" TSİ"};
const dayKey=v=>{const d=new Date(v);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat("en-CA",{timeZone:"UTC",year:"numeric",month:"2-digit",day:"2-digit"}).format(d):"—"};
const dayLabel=k=>{const p=k.split("-");return p[2]+"."+p[1]};
let busy=false, f180=null, comparison=null, stationHistory=null, rainHistory=null, evObservation=null, evHistory=null, stationMode="home";
// Köy Ev is the only initial state. Do not derive the initial station from DOM, cache, or prior UI state.
window.__KOY_DEFAULT_STATION="home";
async function get(path){const url=BASE+path;const r=await fetch(url+"?v="+Date.now(),{cache:"no-store"});if(!r.ok)throw Error("HTTP "+r.status+" · "+url);return r.json()}
async function getStation(path){
 const url=STATIONS_API+path+(path.includes("?")?"&":"?")+"v="+Date.now();
 const r=await fetch(url,{cache:"no-store"});
 if(!r.ok)throw Error("HTTP "+r.status+" · "+url);
 const doc=await r.json();
 if(path.includes("/history/")&&Array.isArray(doc.samples)){
  doc.samples=doc.samples.map(s=>({...s,
   temperature_2m_c:s.temperature_2m_c == null ? s.temperature_c : s.temperature_2m_c,
   humidity_percent:s.humidity_percent,
   pressure_hpa:s.pressure_hpa,
   wind_speed_10m_kmh:s.wind_speed_10m_kmh == null ? s.wind_speed_kmh : s.wind_speed_10m_kmh,
   wind_direction_deg:s.wind_direction_deg == null ? s.wind_direction : s.wind_direction_deg,
   precipitation_1h_mm:s.precipitation_1h_mm == null ? s.rain_1h_mm : s.precipitation_1h_mm,
   precipitation_10m_mm:s.precipitation_10m_mm == null ? s.rain_10m_mm : s.precipitation_10m_mm,
   precipitation_6h_mm:s.precipitation_6h_mm == null ? s.rain_6h_mm : s.precipitation_6h_mm,
   precipitation_12h_mm:s.precipitation_12h_mm == null ? s.rain_12h_mm : s.precipitation_12h_mm,
   precipitation_24h_mm:s.precipitation_24h_mm == null ? s.rain_24h_mm : s.precipitation_24h_mm
  }));
 }
 if(path==="/stations/canakci"&&doc.station){
  const s=doc.station;
  doc.station={...s,
   temperature_2m_c:s.temperature_2m_c == null ? s.temperature_c : s.temperature_2m_c,
   humidity_percent:s.humidity_percent,
   pressure_hpa:s.pressure_hpa,
   wind_speed_10m_kmh:s.wind_speed_10m_kmh == null ? s.wind_speed_kmh : s.wind_speed_10m_kmh,
   wind_direction_degrees:s.wind_direction_degrees == null ? s.wind_direction : s.wind_direction_degrees,
   precipitation_1h_mm:s.precipitation_1h_mm == null ? s.rain_1h_mm : s.precipitation_1h_mm,
   precipitation_10m_mm:s.precipitation_10m_mm == null ? s.rain_10m_mm : s.precipitation_10m_mm,
   precipitation_6h_mm:s.precipitation_6h_mm == null ? s.rain_6h_mm : s.precipitation_6h_mm,
   precipitation_12h_mm:s.precipitation_12h_mm == null ? s.rain_12h_mm : s.precipitation_12h_mm,
   precipitation_24h_mm:s.precipitation_24h_mm == null ? s.rain_24h_mm : s.precipitation_24h_mm
  };
 }
 return doc;
}
function pointsOf(run,max=180){return (run && run.forecast_6_hourly||[]).filter(p=>{const h=Number(p.forecast_hour);return Number.isFinite(h)&&h>=3&&h<=max&&h%3===0}).sort((a,b)=>Number(a.forecast_hour)-Number(b.forecast_hour))}
const HOME_ELEVATION_M=363;
const MGM_STATION_ELEVATION_M=146;
const HOME_DELTA_M=HOME_ELEVATION_M-MGM_STATION_ELEVATION_M;
const HOME_STANDARD_LAPSE_K_PER_KM=6.5;
const HOME_GFS_TEMP_CORRECTION_C=HOME_DELTA_M/1000*HOME_STANDARD_LAPSE_K_PER_KM;

function buildVirtualHomeObservation(source){
 if(!source)return null;
 const t=num(source.temperature_2m_c),rh=num(source.humidity_percent),wind=num(source.wind_speed_10m_kmh);
 if(t==null)return null;
 const correctedT=Number((t-HOME_GFS_TEMP_CORRECTION_C).toFixed(1));
 const p=num(source.pressure_hpa);
 let correctedP=null;
 if(p!=null){
  const tk=t+273.15,tev=correctedT+273.15,L=HOME_STANDARD_LAPSE_K_PER_KM/1000;
  correctedP=Number((p*Math.pow(tev/tk,9.80665/(287.05*L))).toFixed(1));
 }
 return {...source,schema:"koy-mgm.virtual-home-observation.v1",station_id:"KOY-EV-363M",station_name:"Köy Ev",elevation_m:HOME_ELEVATION_M,source_station_name:"Çanakçı",source_station_elevation_m:MGM_STATION_ELEVATION_M,elevation_delta_m:HOME_DELTA_M,virtual_station:true,adjustment_method:"6.5 K/km environmental lapse rate",temperature_2m_c:correctedT,pressure_hpa:correctedP,feels_like_c:feelsLike(correctedT,rh,wind)};
}
function buildVirtualHomeHistory(source){
 if(!source||!Array.isArray(source.samples))return null;
 const samples=source.samples.map(s=>{
  const t=num(s.temperature_2m_c),rh=num(s.humidity_percent),wind=num(s.wind_speed_10m_kmh);
  if(t==null)return null;
  const correctedT=Number((t-HOME_GFS_TEMP_CORRECTION_C).toFixed(1));
  const p=num(s.pressure_hpa);
  let correctedP=null;
  if(p!=null){const tk=t+273.15,tev=correctedT+273.15,L=HOME_STANDARD_LAPSE_K_PER_KM/1000;correctedP=Number((p*Math.pow(tev/tk,9.80665/(287.05*L))).toFixed(1));}
  return {...s,temperature_2m_c:correctedT,pressure_hpa:correctedP,feels_like_c:feelsLike(correctedT,rh,wind)};
 }).filter(Boolean);
 const recent=samples.filter(s=>{const stamp=Date.parse(s.observed_at_utc||s.logged_at_utc||"");return Number.isFinite(stamp)&&stamp>=Date.now()-24*3600000;});
 const feels=recent.map(s=>num(s.feels_like_c)).filter(v=>v!=null);
 return {...source,schema:"koy-mgm.virtual-home-history.v1",station_id:"KOY-EV-363M",station_name:"Köy Ev",source_station_name:"Çanakçı",source_station_elevation_m:MGM_STATION_ELEVATION_M,elevation_m:HOME_ELEVATION_M,elevation_delta_m:HOME_DELTA_M,adjustment_method:"6.5 K/km environmental lapse rate",feels_like_24h_min_c:feels.length?Number(Math.min(...feels).toFixed(1)):null,feels_like_24h_max_c:feels.length?Number(Math.max(...feels).toFixed(1)):null,samples};
}
function adjustGfsPointForHome(point){
 const copy={...point};
 const t=num(copy.temperature_2m_c);
 if(t!=null)copy.temperature_2m_c=Number((t-HOME_GFS_TEMP_CORRECTION_C).toFixed(1));
 copy.virtual_station="Köy Ev";
 copy.elevation_m=HOME_ELEVATION_M;
 copy.elevation_delta_m=HOME_DELTA_M;
 copy.adjustment_method="6.5 K/km environmental lapse rate";
 return copy;
}
function homeGfsDocument(doc){
 if(!doc||!Array.isArray(doc.forecast_6_hourly))return doc;
 return {...doc,location:{...(doc.location||{}),name:"Giresun / Çanakçı · Köy Ev 363 m"},
   virtual_station:"Köy Ev",elevation_m:HOME_ELEVATION_M,elevation_delta_m:HOME_DELTA_M,
   adjustment_method:"6.5 K/km environmental lapse rate",
   forecast_6_hourly:doc.forecast_6_hourly.map(adjustGfsPointForHome)};
}
function homeGfsComparison(doc){
 if(!doc||!Array.isArray(doc.runs))return doc;
 return {...doc,location:{...(doc.location||{}),name:"Giresun / Çanakçı · Köy Ev 363 m"},
   virtual_station:"Köy Ev",elevation_m:HOME_ELEVATION_M,elevation_delta_m:HOME_DELTA_M,
   adjustment_method:"6.5 K/km environmental lapse rate",
   runs:doc.runs.map(homeGfsDocument)};
}
function realizedErrorStats(runs,samples,metric){
 if(!samples||metric!=="temperature_2m_c")return null;
 const obs=Array.isArray(samples.samples)?samples.samples:[];
 if(!obs.length)return null;
 const errors=[],byHour=new Map(),now=Date.now();
 for(const run of runs||[]){
  for(const p of pointsOf(run,72)){
   const t=Date.parse(p.valid_time_utc||"");
   if(!Number.isFinite(t)||t>now)continue;
   let best=null,bestGap=Infinity;
   for(const s of obs){
    const st=Date.parse(s.observed_at_utc||s.logged_at_utc||"");
    if(!Number.isFinite(st))continue;
    const gap=Math.abs(st-t);
    if(gap<bestGap){best=s;bestGap=gap}
   }
   if(!best||bestGap>45*60*1000)continue;
   const forecast=num(p[metric]),observed=num(best.temperature_2m_c);
   if(forecast==null||observed==null)continue;
   const error=forecast-observed;
   errors.push(error);
   const h=Number(p.forecast_hour);
   if(!byHour.has(h))byHour.set(h,[]);
   byHour.get(h).push(error);
  }
 }
 if(errors.length<2)return null;
 const mean=errors.reduce((a,v)=>a+v,0)/errors.length;
 const sigma=Math.sqrt(errors.reduce((a,v)=>a+(v-mean)**2,0)/errors.length);
 const sigmaByHour=new Map();
 for(const [h,vals] of byHour){
  if(vals.length<2)continue;
  const m=vals.reduce((a,v)=>a+v,0)/vals.length;
  sigmaByHour.set(h,Math.sqrt(vals.reduce((a,v)=>a+(v-m)**2,0)/vals.length));
 }
 return {sigma, count:errors.length, sigmaByHour};
}
function svgLine(runs,metric,title,unit,maxHour=180,verification=null){
 // The newest run defines the valid-time axis. Each archived cycle is sampled
 // at those exact UTC instants, regardless of its own forecast-hour number.
 const reference=pointsOf(runs[0],maxHour)
  .map(p=>({...p,stamp:Date.parse(p.valid_time_utc||"")}))
  .filter(p=>Number.isFinite(p.stamp))
  .sort((a,b)=>a.stamp-b.stamp);
 if(!reference.length)return '<div class="chart-empty">Tahmin verisi bekleniyor…</div>';
 const startTime=reference[0].stamp;
 const timeline=reference.map((p,index)=>({
  index,
  stamp:p.stamp,
  elapsed:(p.stamp-startTime)/3600000,
  validTime:p.valid_time_utc
 }));
 const usable=runs.map((run,runIndex)=>{
  // Do not apply maxHour to the older runs: matching the newest run's 72-hour
  // window may require F75, F81, F87… from older cycles.
  const byValidTime=new Map();
  (run && run.forecast_6_hourly||[]).forEach(p=>{
   const stamp=Date.parse(p.valid_time_utc||"");
   if(Number.isFinite(stamp))byValidTime.set(stamp,p);
  });
  const points=timeline.map(target=>{
   const p=byValidTime.get(target.stamp);
   const value=num(p == null ? void 0 : p[metric]);
   if(value==null)return null;
   return {
    index:target.index,
    h:target.elapsed,
    lead:Number(p.forecast_hour),
    v:value,
    validTime:p.valid_time_utc,
    stamp:target.stamp
   };
  });
  return {run,runIndex,points:points.filter(Boolean)};
 }).filter(item=>item.points.length);
 if(!usable.length)return '<div class="chart-empty">Tahmin verisi bekleniyor…</div>';
 const values=usable.flatMap(item=>item.points.map(p=>p.v));
 let lo=Math.min(...values),hi=Math.max(...values);
 if(metric.includes("temperature")){
  lo=Math.floor((lo-2)/2)*2;
  hi=Math.ceil((hi+2)/2)*2;
 }else{
  lo=Math.min(0,lo);
  hi=Math.max(1,Math.ceil(hi*1.15));
 }
 if(hi===lo)hi=lo+1;
 const chartHost=$(metric==="temperature_2m_c"?"next72-temperature":"next72-precipitation");
 const W=1000;
 const boxWidth=Math.max(320,chartHost && chartHost.clientWidth||1000);
 const boxHeight=Math.max(180,chartHost && chartHost.clientHeight||280);
 const H=W*boxHeight/boxWidth;
 const L=78,R=16,T=34,B=60,PW=W-L-R,PH=H-T-B;
 const x=h=>L+(timeline.length===1?PW/2:(h-timeline[0].elapsed)/(timeline[timeline.length-1].elapsed-timeline[0].elapsed||1))*PW;
 const y=v=>T+(hi-v)*PH/(hi-lo);
 const axisLabel=stamp=>new Intl.DateTimeFormat("tr-TR",{
  timeZone:"Europe/Istanbul",day:"2-digit"
 }).format(new Date(stamp));
 let s='<svg class="koy-svg" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet" text-rendering="optimizeLegibility" role="img" aria-label="'+esc(title)+'">';
 for(let j=0;j<=3;j++){
  const v=lo+(hi-lo)*j/3,yy=y(v);
  s+='<line x1="'+L+'" y1="'+yy+'" x2="'+(W-R)+'" y2="'+yy+'" stroke="#355064" stroke-dasharray="3 5"/><text x="'+(L-8)+'" y="'+(yy+5)+'" text-anchor="end" fill="#d0dde4" font-size="20" font-weight="600" font-family="system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">'+fmt(v,1)+'</text>';
 }
 timeline.forEach((point,index)=>{
  if(point.elapsed!==0&&point.elapsed%12!==0&&index!==timeline.length-1)return;
  const anchor=index===0?"start":index===timeline.length-1?"end":"middle";
  s+='<text x="'+x(point.elapsed)+'" y="'+(H-8)+'" text-anchor="'+anchor+'" fill="#c5d3dc" font-size="18" font-weight="500" font-family="system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">'+esc(axisLabel(point.stamp))+'</text>';
 });
 usable.forEach(item=>{
  const i=item.runIndex,color=COLORS[i%COLORS.length],latest=i===0;
  const groups=[];
  item.points.forEach(point=>{
   const group=groups[groups.length-1];
   if(!group||point.index!==group[group.length-1].index+1)groups.push([point]);
   else group.push(point);
  });
  groups.forEach(group=>{
   const path=group.map((p,j)=>(j?"L":"M")+x(p.h)+" "+y(p.v)).join(" ");
   s+='<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="'+(latest?GFS_CYCLE_THEME.latestStrokeWidth:GFS_CYCLE_THEME.previousStrokeWidth)+'" '+(latest?'':'stroke-dasharray="'+GFS_CYCLE_THEME.previousStrokeDasharray+'"')+' stroke-linecap="round" stroke-linejoin="round"/>';
  });
  if(latest)item.points.forEach(p=>{
   s+='<circle cx="'+x(p.h)+'" cy="'+y(p.v)+'" r="3.5" fill="'+color+'"><title>F'+p.lead+' · '+esc(tsGfsValid(p.validTime))+' · '+fmt(p.v)+' '+unit+'</title></circle>';
  });
  item.points.forEach(p=>{
   s+='<circle class="gfs-point-target" cx="'+x(p.h)+'" cy="'+y(p.v)+'" r="0" data-run="'+esc(gfsRunLabel(item.run))+'" data-current="'+(latest?"true":"false")+'" data-validkey="'+p.stamp+'" data-valid="'+esc(tsGfsValid(p.validTime))+'" data-step="'+esc("F"+p.lead+" saat")+'" data-value="'+esc(fmt(p.v,1))+'" data-unit="'+esc(unit)+'" data-color="'+color+'" aria-hidden="true"/>';
  });
 });
 s+='</svg>';
 return s;
}
let activeGfsTooltip=null;
document.addEventListener("pointerdown",event=>{
 if(activeGfsTooltip&&!activeGfsTooltip.host.contains(event.target))activeGfsTooltip.hide();
},true);
function bindGfsChartTooltip(containerId){
 const host=$(containerId),svg=host && host.querySelector("svg.koy-svg");
 if(!host||!svg)return;
 const tooltip=document.createElement("div");
 tooltip.className="gfs-point-tooltip";
 tooltip.hidden=true;
 tooltip.setAttribute("role","status");
 tooltip.setAttribute("aria-live","polite");
 host.appendChild(tooltip);
 let pinned=false;
 const targets=[...svg.querySelectorAll(".gfs-point-target")];
 const currentTargets=targets.filter(target=>target.dataset.current==="true");
 const currentByTime=new Map(currentTargets.map(target=>[target.dataset.validkey,target]));
 let currentXs=[];
 const refreshScreenXs=()=>{
  const matrix=svg.getScreenCTM();
  if(!matrix){currentXs=[];return;}
  currentXs=currentTargets.map(target=>{
   const point=svg.createSVGPoint();
   point.x=Number(target.getAttribute("cx"));
   point.y=Number(target.getAttribute("cy"));
   return {target,x:point.matrixTransform(matrix).x};
  }).filter(item=>Number.isFinite(item.x)).sort((a,b)=>a.x-b.x);
 };
 refreshScreenXs();
 function hide(){
  tooltip.hidden=true;
  pinned=false;
  if(activeGfsTooltip && activeGfsTooltip.tooltip===tooltip)activeGfsTooltip=null;
 }
 function positionTooltipAbove(event){
  const rect=host.getBoundingClientRect();
  tooltip.style.position="absolute";
  tooltip.style.zIndex="2147483647";
  tooltip.style.pointerEvents="none";
  tooltip.style.left="0px";
  tooltip.style.top="0px";
  const tw=tooltip.offsetWidth,th=tooltip.offsetHeight;
  const gap=12;
  const x=event.clientX-rect.left;
  const y=event.clientY-rect.top;
  const maxLeft=Math.max(8,rect.width-tw-8);
  const maxTop=Math.max(8,rect.height-th-8);
  const left=Math.max(8,Math.min(maxLeft,x-tw/2));
  const top=Math.max(8,Math.min(maxTop,y-th-gap));
  tooltip.style.left=Math.round(left)+"px";
  tooltip.style.top=Math.round(top)+"px";
 }
 function nearestPoint(event){
  if(!currentXs.length)refreshScreenXs();
  if(!currentXs.length)return null;
  const x=event.clientX;
  let lo=0,hi=currentXs.length-1;
  while(lo<hi){const mid=(lo+hi)>>1;if(currentXs[mid].x<x)lo=mid+1;else hi=mid;}
  let best=currentXs[lo];
  if(lo>0&&Math.abs(currentXs[lo-1].x-x)<Math.abs(best.x-x))best=currentXs[lo-1];
  return best.target;
 }
 function latestPointAtSameTime(hit){
  return hit?currentByTime.get(hit.dataset.validkey)||hit:null;
 }
 function show(target,event,lock=false){
  if(!target)return;
  const run=target.dataset.run||"GFS döngüsü";
  const valid=target.dataset.valid||"—";
  const step=target.dataset.step||"";
  const value=target.dataset.value||"—";
  const unit=target.dataset.unit||"";
  const color=target.dataset.color||GFS_CYCLE_THEME.colors[0];
  tooltip.innerHTML='<div class="gfs-point-tooltip-head"><i style="background:'+color+'"></i><strong>Güncel GFS tahmini</strong></div><div class="gfs-point-tooltip-time">Döngü · '+esc(run)+'<br>Geçerlilik · '+esc(valid)+'</div><div class="gfs-point-tooltip-value">'+esc(value)+' <small>'+esc(unit)+'</small></div><div class="gfs-point-tooltip-meta">Tahmin adımı '+esc(step)+'</div>';
  tooltip.hidden=false;
  pinned=lock;
  positionTooltipAbove(event);
  if(lock)activeGfsTooltip={host,tooltip,hide};
 }
 const updateTouch=event=>{
  if(!event||!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY))return;
  pinned=true;
  const hit=nearestPoint(event),target=latestPointAtSameTime(hit);
  if(target)show(target,event,true);else hide();
 };
 svg.style.touchAction="pan-y";
 svg.style.webkitTapHighlightColor="transparent";
 svg.addEventListener("pointermove",event=>{
  if(event.pointerType==="touch"){updateTouch(event);return;}
  if(pinned)return;
  const hit=nearestPoint(event),target=latestPointAtSameTime(hit);
  if(target)show(target,event,false);else hide();
 });
 svg.addEventListener("pointerrawupdate",event=>{if(event.pointerType==="touch")updateTouch(event);},{passive:true});
 svg.addEventListener("touchmove",event=>{
  const touch=event.touches && event.touches[0];if(!touch)return;
  updateTouch({clientX:touch.clientX,clientY:touch.clientY});
 },{passive:true});
 svg.addEventListener("pointerleave",()=>{if(!pinned)hide();});
 svg.addEventListener("pointerdown",event=>{
  if(event.pointerType!=="touch"&&event.pointerType!=="pen")return;
  if(event.pointerType==="touch"){pinned=true;try{svg.setPointerCapture(event.pointerId);}catch(_){}}
  const hit=nearestPoint(event),target=latestPointAtSameTime(hit);
  if(target)show(target,event,true);else hide();
 });
 svg.addEventListener("pointerup",event=>{if(event.pointerType==="touch")hide();});
 svg.addEventListener("pointercancel",event=>{if(event.pointerType==="touch")hide();});
 svg.addEventListener("lostpointercapture",event=>{if(event.pointerType==="touch")hide();});
 window.addEventListener("scroll",hide,{passive:true,capture:true});
 window.addEventListener("resize",()=>{refreshScreenXs();hide();},{passive:true});
}

function svgDaily(runs,metric,title,unit,mode){
 const rows=runs.map((run,ri)=>({run,ri,points:pointsOf(run).map(p=>({...p,day:dayKey(p.valid_time_utc),v:num(p[metric])})).filter(p=>p.v!=null)}));
 const keys=[...new Set(rows.flatMap(r=>r.points.map(p=>p.day)))].sort();
 const values=rows.flatMap(r=>r.points.map(p=>p.v));if(!keys.length||!values.length)return '<div class="chart-empty">Karşılaştırma verisi bekleniyor…</div>';
 let lo=Math.min(...values),hi=Math.max(...values);if(metric.includes("temperature")){lo=Math.floor((lo-2)/2)*2;hi=Math.ceil((hi+2)/2)*2}else{lo=Math.min(0,lo);hi=Math.max(1,Math.ceil(hi*1.15))}
 if(hi===lo)hi=lo+1;
 const W=760,H=225,L=48,R=12,T=20,B=34,PW=W-L-R,PH=H-T-B;
 const x=i=>L+(keys.length===1?PW/2:i*PW/(keys.length-1)),y=v=>T+(hi-v)*PH/(hi-lo);
 let s='<svg class="koy-svg" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(title)+'">';
 for(let j=0;j<=4;j++){const v=lo+(hi-lo)*j/4,yy=y(v);s+='<line x1="'+L+'" y1="'+yy+'" x2="'+(W-R)+'" y2="'+yy+'" stroke="#294253"/><text x="'+(L-7)+'" y="'+(yy+3)+'" text-anchor="end" fill="#91aab8" font-size="10">'+fmt(v,0)+'</text>'}
 keys.forEach((k,i)=>{s+='<text x="'+x(i)+'" y="'+(H-8)+'" text-anchor="middle" fill="#91aab8" font-size="10">'+dayLabel(k)+'</text>'});
 const group=Math.min(34,PW/Math.max(1,keys.length)*.72),slot=group/Math.max(1,runs.length);
 keys.forEach((k,i)=>rows.forEach((r)=>{const vals=r.points.filter(p=>p.day===k).map(p=>p.v);if(!vals.length)return;const a=Math.min(...vals),b=Math.max(...vals),xx=x(i)+(r.ri-(runs.length-1)/2)*slot,c=COLORS[r.ri];s+='<line x1="'+xx+'" y1="'+y(b)+'" x2="'+xx+'" y2="'+y(a)+'" stroke="'+c+'" stroke-width="2"/><line x1="'+(xx-2)+'" y1="'+y(b)+'" x2="'+(xx+2)+'" y2="'+y(b)+'" stroke="'+c+'" stroke-width="2"/><line x1="'+(xx-2)+'" y1="'+y(a)+'" x2="'+(xx+2)+'" y2="'+y(a)+'" stroke="'+c+'" stroke-width="2"/>';if(mode==="candle"){const valsByTime=r.points.filter(p=>p.day===k).sort((a,b)=>a.forecast_hour-b.forecast_hour),first=valsByTime[0].v,last=valsByTime[valsByTime.length-1].v,top=Math.min(y(first),y(last)),height=Math.max(3,Math.abs(y(first)-y(last)));s+='<rect x="'+(xx-Math.max(2,slot*.28))+'" y="'+top+'" width="'+Math.max(4,slot*.56)+'" height="'+height+'" fill="'+c+'" opacity=".88"><title>'+esc(r.run.run_id_utc)+' · '+k+' · min '+fmt(a)+' / max '+fmt(b)+'</title></rect>'}else s+='<circle cx="'+xx+'" cy="'+y((a+b)/2)+'" r="2.2" fill="'+c+'"><title>'+esc(r.run.run_id_utc)+' · min '+fmt(a)+' / max '+fmt(b)+'</title></circle>'}));
 s+='</svg>';return s;
}
function windDir(deg){const n=Number(deg);if(!Number.isFinite(n))return "—";const dirs=["K","KKD","KD","DKD","D","DGD","GD","GBD","B","GBB","KB","KKB"];return dirs[Math.round(n/30)%12]||"—"}
function feelsLike(t,rh,wind){const T=Number(t),H=Number(rh),W=Number(wind);if(!Number.isFinite(T)||!Number.isFinite(H))return null;if(T>=20)return Number((-8.784+1.611*T+2.338*H-0.146*T*H-0.0123*T*T-0.0164*H*H+0.00221*T*T*H+0.000725*T*H*H-0.00000358*T*T*H*H).toFixed(1));if(T<=10&&Number.isFinite(W)){if(W<=4.8)return Number(T.toFixed(1));return Number((13.12+0.6215*T-11.37*Math.pow(W,0.16)+0.3965*T*Math.pow(W,0.16)).toFixed(1));}return Number(T.toFixed(1));}
function dewpoint(t,rh){const T=Number(t),H=Number(rh);if(!Number.isFinite(T)||!Number.isFinite(H)||H<=0)return null;const a=17.62,b=243.12,g=Math.log(H/100)+a*T/(b+T);return b*g/(a-g)}
function renderMgmObservation(o,history,f180){
 if(!o)return;
 const isHome=stationMode==="home";
 const stationName=isHome?"Köy Ev":"Çanakçı MGM";
 const stationElevation=isHome?"363 m":(o && o.elevation_m!=null?fmt(o.elevation_m,0)+" m":"");
 const t=num(o.temperature_2m_c),rh=num(o.humidity_percent),wind=num(o.wind_speed_10m_kmh),rain=num(o.precipitation_1h_mm),press=num(o.pressure_hpa);
 // Rain is always sourced from the real Çanakçı MGM station observation.
 // For Köy Ev, use the displayed elevation-corrected temperature to choose rain vs snow.
 const mgmObservation=window.__koyMgmObservation||o;
 const mgmRain=num((mgmObservation && mgmObservation.precipitation_1h_mm != null ? mgmObservation.precipitation_1h_mm : (mgmObservation && mgmObservation.rain_1h_mm != null ? mgmObservation.rain_1h_mm : rain)));
 const precipitationPhase=mgmRain!=null&&mgmRain>0
  ? (t!=null&&t<2.0?"snow":"rain")
  : "none";
 const weatherSymbol=$("weather-symbol");
 if(weatherSymbol){
  weatherSymbol.textContent=precipitationPhase==="snow"?"🌨️":precipitationPhase==="rain"?"🌧️":"☁️";
  weatherSymbol.title=precipitationPhase==="snow"?"Kar yağışı · Çanakçı MGM gözlemi"
   :precipitationPhase==="rain"?"Yağmur · Çanakçı MGM gözlemi":"Şu anda yağış tespit edilmedi";
 }
 $("temperature").textContent=fmt(t)+"°";
 const cachedObservation=o.fetch_status==="stale_cached";
 const observedAt=o.observed_at_utc||o.fetched_at_utc||o.last_attempt_utc;
 const observedMs=Date.parse(observedAt||"");
 const observedText=Number.isFinite(observedMs)?new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(observedMs)):"zaman bilinmiyor";
 const ageMinutes=Number.isFinite(observedMs)?Math.max(0,Math.floor((Date.now()-observedMs)/60000)):null;
 const ageText=ageMinutes===null?"":ageMinutes<60?ageMinutes+" dk önce":(ageMinutes/60).toFixed(1).replace(".",",")+" saat önce";
 $("station-observation-meta").textContent="Son ölçüm · "+observedText+" TSİ · "+ageText;
 $("freshness").textContent=cachedObservation?"MGM YANITI BEKLENİYOR":"CANLI ÖLÇÜM";
 $("freshness").classList.toggle("stale",cachedObservation);
 const currentFeels=num(o.feels_like_c)!=null?num(o.feels_like_c):feelsLike(t,rh,wind);
 $("feels-like").innerHTML=fmt(currentFeels)+'<span class="unit">°</span>';
 const feelsRangeEl=$("feels-like-24h");
 if(feelsRangeEl){
  const now=Date.now(),cutoff=now-24*3600000;
  const values=(Array.isArray(history && history.samples)?history.samples:[]).filter(s=>{
   const stamp=Date.parse(s.observed_at_utc||s.logged_at_utc||"");
   return Number.isFinite(stamp)&&stamp>=cutoff&&stamp<=now+300000;
  }).map(s=>{
   const stored=num(s.feels_like_c);
   return stored!=null?stored:feelsLike(num(s.temperature_2m_c),num(s.humidity_percent),num(s.wind_speed_10m_kmh));
  }).filter(v=>v!=null);
  const min24=values.length?Math.min(...values):null;
  const max24=values.length?Math.max(...values):null;
  if(min24!=null&&max24!=null){
   feelsRangeEl.hidden=false;
   feelsRangeEl.textContent="24 sa · min "+fmt(min24,1)+"° · maks "+fmt(max24,1)+"°";
  }else{
   feelsRangeEl.hidden=true;
   feelsRangeEl.textContent="";
  }
 }
 $("wind").innerHTML=fmt(wind,1)+'<span class="unit">km/sa</span>';
 $("wind-direction").textContent=windDir(o.wind_direction_deg);
 $("humidity").innerHTML=fmt(rh,0)+'<span class="unit">%</span>';
 $("dewpoint-value").innerHTML=fmt(dewpoint(t,rh))+'<span class="unit">°</span>';
 $("rain").innerHTML=fmt(rain)+'<span class="unit">mm</span>';
 $("rain-detail").textContent="Son 1 saat";
 $("pressure").innerHTML=fmt(press,1)+'<span class="unit">hPa</span>';
 const validationEl=$("station-alert");
 if(validationEl){
  const v=o && o.validation;
  validationEl.classList.toggle("station-alert-ok",isHome&&v && v.status==="PASS");
  if(isHome&&v && v.status==="FAIL"){
   validationEl.hidden=false;
   validationEl.textContent="Köy Ev hesap kontrolü: "+(Array.isArray(v.checks)?v.checks.join(", "):"tutarsızlık")+" · değerler yeniden hesaplanmalı.";
  }else if(isHome&&v && v.status==="PASS"){
   validationEl.hidden=false;
   validationEl.textContent="✓ Köy Ev hesap doğrulandı · +217 m rakım · hissedilen ve basınç tutarlı";
  }else{
   validationEl.hidden=true;
   validationEl.textContent="";
  }
 }
 const samples=Array.isArray(history && history.samples)?history.samples:[];
 const temps=samples.map(x=>num(x.temperature_2m_c)).filter(v=>v!=null);
 if(temps.length){const min=Math.min(...temps),max=Math.max(...temps),d=t!=null?t-temps[0]:null;const diff=t!=null?t-min:null;$("station-24h-diff").textContent="Son 24 saatte "+(diff>=0?fmt(diff)+"° daha sıcak":fmt(Math.abs(diff))+"° daha soğuk");}
 if(precipitationPhase==="snow")$("rain-brief-current").textContent="Kar yağışı tespit edildi · Çanakçı MGM ("+fmt(mgmRain)+" mm/son 1 saat).";
 else if(precipitationPhase==="rain")$("rain-brief-current").textContent="Yağışlı.";
 else $("rain-brief-current").textContent="Çanakçı MGM ölçümünde son 1 saatte yağış yok.";
 const pts=pointsOf(f180||{},72),future=pts.filter(p=>num(p.precipitation_6h_mm)>0.1);
 if(future.length){
  const firstRainIndex=pts.findIndex(p=>num(p.precipitation_6h_mm)>0.1);
  const firstDry=pts.slice(firstRainIndex+1).find(p=>{const rain=num(p.precipitation_6h_mm);return rain!=null&&Number(rain.toFixed(1))===0;});
  $("rain-brief-forecast").textContent=firstDry
   ?"MeteoPT GFS tahminine göre ilk kuru zaman: "+tsGfsValid(firstDry.valid_time_utc)+"."
   :"MeteoPT GFS tahminine göre yağış tahmin süresinin sonuna kadar devam ediyor.";
 }else{
  $("rain-brief-forecast").textContent="MeteoPT GFS tahmininde önümüzdeki 72 saatte anlamlı yağış görünmüyor.";
 }
 $("history-station-source").textContent=isHome?"KÖY EV · 363 M · RAKIM DÜZELTMELİ":"ÇANAKÇI · GERÇEK ÖLÇÜMLER";
 $("station-trend-meta").textContent=isHome?"Köy Ev · 363 m · rakım düzeltilmiş arşiv":"Çanakçı MGM ölçüm geçmişi";
 $("history-source-note").textContent=isHome?"Köy Ev değerleri Çanakçı MGM ölçümlerinden +217 m rakım düzeltmesiyle türetilir.":"Sıcaklık ve yağış: MGM Çanakçı gerçek istasyon ölçümleri.";
}
function meteoptTableBand(field,value){
 if(value==null)return "";
 const v=Number(value);
 if(!Number.isFinite(v))return "";
 if(field==="wind")return v<10?"mt-blue":v<20?"mt-green":v<30?"mt-yellow":v<45?"mt-orange":v<60?"mt-red":"mt-purple";
 if(field==="precip")return Number(v.toFixed(1))===0?"mt-gray":v<.1?"mt-blue":v<1?"mt-green":v<2.5?"mt-yellow":v<5?"mt-orange":v<10?"mt-red":"mt-purple";
 if(field==="rh2m")return v<30?"rh2m-warm-1":v<45?"rh2m-warm-2":v<60?"rh2m-warm-3":v<75?"rh2m-cool-1":v<90?"rh2m-cool-2":"rh2m-cool-3";
 if(field==="t2m"||field==="dewpoint")return v<0?"mt-blue":v<8?"mt-green":v<16?"mt-yellow":v<24?"mt-orange":v<32?"mt-red":"mt-purple";
 if(field==="t850")return v< -10?"mt-blue":v< -2?"mt-green":v<6?"mt-yellow":v<14?"mt-orange":v<22?"mt-red":"mt-purple";
 if(field==="snowln")return v<1000?"mt-blue":v<1500?"mt-green":v<2000?"mt-yellow":v<2500?"mt-orange":v<3000?"mt-red":"mt-purple";
 return "";
}
function meteoptTableValue(value,field,digits=1){
 if(value==null)return '<span class="meteopt-value">—</span>';
 const band=meteoptTableBand(field,value);
 return '<span class="meteopt-value '+band+'">'+fmt(value,digits)+'</span>';
}
function renderF180(d){
 const pts=pointsOf(d,180);
 const body=$("meteopt-table-body");
 body.innerHTML=pts.length?pts.map(p=>'<tr><td>F'+p.forecast_hour+'</td><td>'+tsGfsValid(p.valid_time_utc)+'</td><td>'+meteoptTableValue(num(p.temperature_2m_c),"t2m")+'</td><td>'+meteoptTableValue(num(p.precipitation_6h_mm),"precip")+'</td><td>'+meteoptTableValue(num(p.wind_speed_10m_kmh),"wind",0)+'</td><td>'+meteoptTableValue(num(p.temperature_850hpa_c),"t850")+'</td><td>'+meteoptTableValue(num(p.wind_speed_850hpa_kmh),"wind",0)+'</td><td>'+meteoptTableValue(num(p.humidity_2m_percent),"rh2m",0)+'</td><td>'+meteoptTableValue(dewpoint(num(p.temperature_2m_c),num(p.humidity_2m_percent)),"dewpoint")+'</td><td>'+meteoptTableValue(num(p.snowln),"snowln",0)+'</td></tr>').join(""):'<tr><td colspan="10" class="meteopt-table-empty">F180 tahmin adımları henüz yok.</td></tr>';
 const intervals=Array.from(new Set(pts.slice(1).map((point,index)=>Number(point.forecast_hour)-Number(pts[index].forecast_hour)).filter(value=>Number.isFinite(value)&&value>0))).sort((a,b)=>a-b);
 const cadence=intervals.length?intervals.map(value=>value+" saat").join("/"):"model";
 $("meteopt-table-status").textContent=pts.length+" adım · "+cadence+" aralıklı · 180. saate kadar";
 $("meteopt-table-run").textContent="Model döngüsü: "+ts(d.run_id_utc);
 $("meteopt-table-updated").textContent="Yayın: "+ts(d.published_at_utc);
}
function svgStationHistory(samples,metric,title,unit){
 const now=Date.now();
 const hourly=metric==="precipitation_1h_mm";
 const step=hourly?3600000:1800000;
 // Rainfall uses completed, Istanbul-hour-aligned bins. The 24-hour
 // window therefore advances only at HH:00 rather than following refresh minute.
 const chartEnd=hourly?Math.floor(now/step)*step:now;
 const from=hourly?chartEnd-24*step:now-24*3600000;
 const bins=[];
 for(let t=from;t<chartEnd;t+=step)bins.push({start:t,values:[]});
 (Array.isArray(samples)?samples:[]).forEach(s=>{
   const t=Date.parse(s.observed_at_utc||s.logged_at_utc||""),v=num(s[metric]);
   if(!Number.isFinite(t)||t<from||t>=chartEnd||v==null)return;
   const i=Math.floor((t-from)/step);if(i>=0&&i<bins.length)bins[i].values.push({t,v});
 });
 const data=bins.map((b,i)=>{
   if(!b.values.length)return null;
   if(hourly){
     const latest=b.values.sort((a,z)=>a.t-z.t)[b.values.length-1];
     return {index:i,start:b.start,count:b.values.length,min:latest.v,max:latest.v,mean:latest.v};
   }
   return {index:i,start:b.start,count:b.values.length,min:Math.min(...b.values.map(x=>x.v)),max:Math.max(...b.values.map(x=>x.v)),mean:b.values.reduce((a,x)=>a+x.v,0)/b.values.length};
 }).filter(Boolean);
 const holder=metric==="temperature_2m_c"?"station-temperature-trend":"station-rain-trend";
 if(data.length<1)return '<div class="station-trend-empty">MGM Çanakçı istasyon verisi bekleniyor.</div>';
 let lo=Math.min(...data.map(p=>p.min)),hi=Math.max(...data.map(p=>p.max));
 if(metric==="temperature_2m_c"){lo=Math.floor(lo-.5);hi=Math.ceil(hi+.5)}else{lo=0;hi=Math.max(1,Math.ceil(hi+1))}
 if(hi<=lo)hi=lo+1;
 const W=560,H=200,L=44,R=14,T=15,B=29,PW=W-L-R,PH=H-T-B;
 const x=t=>L+(t-from)/86400000*PW,y=v=>T+(hi-v)*PH/(hi-lo),xb=p=>x(p.start+step/2);
 let s='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="'+esc(title)+'">';
 for(let j=0;j<=4;j++){const v=lo+(hi-lo)*j/4,yy=y(v);s+='<line x1="'+L+'" y1="'+yy+'" x2="'+(W-R)+'" y2="'+yy+'" stroke="rgba(190,218,228,.17)" stroke-dasharray="3 5"/><text x="'+(L-9)+'" y="'+(yy+3.5)+'" fill="#a8bfca" font-size="10" text-anchor="end">'+fmt(v,metric==="temperature_2m_c"?1:1)+'</text>'}
 bins.forEach((b,i)=>{
  if(hourly){
   // Match the temperature chart: one time label every 2 hours.
   if(i%2&&i!==bins.length-1)return;
   const hh=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(b.start));
   s+='<text x="'+x(b.start)+'" y="'+(H-8)+'" fill="#a8bfca" font-size="10" text-anchor="middle"><title>'+hh+' TSİ</title>'+hh+'</text>';
   return;
  }
  if(i%4&&i!==bins.length-1)return;
  s+='<text x="'+x(b.start)+'" y="'+(H-8)+'" fill="#a8bfca" font-size="10" text-anchor="middle">'+new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit"}).format(new Date(b.start))+'</text>';
 });
 const groups=[];data.forEach(p=>{const g=groups[groups.length-1];if(!g||p.index!==g[g.length-1].index+1)groups.push([p]);else g.push(p)});
 const line=groups.map(g=>g.map((p,i)=>(i?"L":"M")+xb(p).toFixed(1)+" "+y(p.mean).toFixed(1)).join(" ")).join(" ");
 const area=groups.filter(g=>g.length>1).map(g=>g.map((p,i)=>(i?"L":"M")+xb(p).toFixed(1)+" "+y(p.mean).toFixed(1)).join(" ")+" L "+xb(g[g.length-1])+" "+(H-B)+" L "+xb(g[0])+" "+(H-B)+" Z").join(" ");
 const ranges=data.map(p=>{const xx=xb(p),a=y(p.max),b=y(p.min),c=4.5;return '<path d="M'+xx+' '+a+'V'+b+' M'+(xx-c)+' '+a+'h'+(2*c)+' M'+(xx-c)+' '+b+'h'+(2*c)+'" stroke="rgba(125,211,215,.78)" stroke-width="1.7" fill="none"/>'}).join("");
 s+='<path d="'+area+'" fill="rgba(125,211,215,.10)" stroke="none"/>'+ranges+'<path d="'+line+'" fill="none" stroke="#8edbd2" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>';
 const last=data[data.length-1];s+='<circle cx="'+xb(last)+'" cy="'+y(last.mean)+'" r="6" fill="#f1fff9" stroke="#a4e7d5" stroke-width="1.5"/>';
 data.forEach(p=>{
  const period=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit"}).format(new Date(p.start))+"–"+new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit"}).format(new Date(p.start+step))+" TSİ";
  const detail=hourly?"Kayan 1 saatlik toplam · "+p.count+" kayıt":"30 dk ortalama · min "+fmt(p.min)+" / maks "+fmt(p.max)+" °C · "+p.count+" kayıt";
  s+='<circle class="station-point-target" cx="'+xb(p)+'" cy="'+y(p.mean)+'" r="0" data-period="'+esc(period)+'" data-value="'+esc(fmt(p.mean))+'" data-unit="'+esc(unit)+'" data-detail="'+esc(detail)+'" data-color="#8edbd2" aria-hidden="true"/>';
 });
 s+='</svg>';return s;
}
let activeStationTooltip=null;
document.addEventListener("pointerdown",event=>{
 if(activeStationTooltip&&!activeStationTooltip.host.contains(event.target))activeStationTooltip.hide();
},true);
function bindStationHistoryTooltip(containerId){
 const host=$(containerId),svg=host && host.querySelector("svg");
 if(!host||!svg)return;
 const targets=[...svg.querySelectorAll(".station-point-target")];
 if(!targets.length)return;
 const tooltip=document.createElement("div");
 tooltip.className="station-history-tooltip";
 tooltip.hidden=true;
 tooltip.setAttribute("role","status");
 tooltip.setAttribute("aria-live","polite");
 document.body.appendChild(tooltip);
 tooltip.style.position="fixed";
 tooltip.style.zIndex="2147483647";
 tooltip.style.pointerEvents="none";
 let pinned=false;
 let touchHideTimer=null;
 function scheduleTouchHide(){
  if(touchHideTimer!==null)window.clearTimeout(touchHideTimer);
  touchHideTimer=window.setTimeout(()=>{touchHideTimer=null;hide()},2800);
 }
 function nearestByTime(event,maxDistance){
  const matrix=svg.getScreenCTM();
  if(!matrix)return null;
  let nearest=null,best=Number.isFinite(maxDistance)?maxDistance:Infinity;
  const point=svg.createSVGPoint();
  for(const target of targets){
   point.x=Number(target.getAttribute("cx"));
   point.y=Number(target.getAttribute("cy"));
   const screen=point.matrixTransform(matrix);
   const distance=Math.abs(event.clientX-screen.x);
   if(distance<best){best=distance;nearest=target}
  }
  return nearest;
 }
 function hide(){
  if(touchHideTimer!==null)window.clearTimeout(touchHideTimer);
  touchHideTimer=null;
  tooltip.hidden=true;
  pinned=false;
  if(activeStationTooltip && activeStationTooltip.tooltip===tooltip)activeStationTooltip=null;
 }
 function show(target,event,lock=false){
  if(!target)return;
  tooltip.innerHTML='<div class="station-history-tooltip-time">'+esc(stationMode==="home"?"Köy Ev · 363 m · Rakım düzeltilmiş":"MGM Çanakçı · Gerçek ölçüm")+'<br>'+esc(target.dataset.period||"—")+'</div><div class="station-history-tooltip-value">'+esc(target.dataset.value||"—")+' <small>'+esc(target.dataset.unit||"")+'</small></div><div class="station-history-tooltip-detail">'+esc(target.dataset.detail||"")+'</div>';
  tooltip.hidden=false;
  pinned=lock;
  const tw=tooltip.offsetWidth,th=tooltip.offsetHeight;
  const margin=8;
  const left=Math.max(margin,Math.min(window.innerWidth-tw-margin,event.clientX+12));
  const top=Math.max(margin,event.clientY-th-14);
  tooltip.style.left=left+"px";
  tooltip.style.top=top+"px";
  if(lock)activeStationTooltip={host,tooltip,hide};
 }
 svg.style.touchAction="pan-y";
 const handleTouchMove=event=>{
  if(event.pointerType&&event.pointerType!=="touch")return;
  if(event.cancelable)event.preventDefault();
  pinned=true;
  const target=nearestByTime(event,64);
  if(target){
   show(target,event,true);
   scheduleTouchHide();
  }else hide();
 };
 svg.addEventListener("pointermove",event=>{
  if(event.pointerType==="touch"){
   handleTouchMove(event);
   return;
  }
  if(pinned)return;
  const target=nearestByTime(event,48);
  if(target)show(target,event,false);
  else hide();
 });
 svg.addEventListener("pointerrawupdate",handleTouchMove,{passive:false});
 svg.addEventListener("touchmove",event=>{
  const touch=event.touches && event.touches[0];
  if(!touch)return;
  handleTouchMove({clientX:touch.clientX,clientY:touch.clientY,pointerType:"touch"});
 },{passive:false});
 svg.addEventListener("pointerleave",()=>{if(!pinned)hide()});
 svg.addEventListener("pointerdown",event=>{
  if(event.pointerType!=="touch"&&event.pointerType!=="pen")return;
  const target=nearestByTime(event,64);
  if(target){
   event.preventDefault();
   if(event.pointerType==="touch")try{svg.setPointerCapture(event.pointerId)}catch(_){}
   show(target,event,true);
   if(event.pointerType==="touch")scheduleTouchHide();
  }else hide();
 });
 svg.addEventListener("pointerup",event=>{
  if(event.pointerType==="touch")scheduleTouchHide();
 });
 svg.addEventListener("pointercancel",event=>{
  if(event.pointerType==="touch")hide();
 });
}
function renderStationHistory(doc,rainDoc){
 const isHome=stationMode==="home";
 const samples=Array.isArray(doc && doc.samples)?doc.samples:[];
 const rainSamples=Array.isArray(rainDoc && rainDoc.samples)?rainDoc.samples:samples;
 const stationLabel=isHome?"Köy Ev · 363 m":"Çanakçı · MGM";
 const tempTitle=isHome?"Köy Ev sıcaklık":"Çanakçı sıcaklık";
 const rainTitle=isHome?"Köy Ev yağış":"Çanakçı yağış";
 $("station-trend-meta").textContent=stationLabel+" · "+samples.length+" kayıt · 30 dk ortalama / min–maks";
 $("station-rain-meta").textContent=stationLabel+" · "+rainSamples.length+" kayıt · 72 saatlik arşiv · saatlik kayan 1 saat toplam";
 $("history-source-note").textContent=isHome?"Sıcaklık ve yağış: Çanakçı MGM gerçek ölçümlerinden +217 m rakım düzeltmesiyle türetilmiş Köy Ev sanal istasyonu.":"Sıcaklık: MGM Çanakçı gözlem geçmişi. Yağış: bağımsız 72 saatlik MGM yağış arşivi.";
 $("station-temperature-trend").innerHTML=svgStationHistory(samples,"temperature_2m_c",tempTitle,"°C");
 $("station-rain-trend").innerHTML=svgStationHistory(rainSamples,"precipitation_1h_mm",rainTitle,"mm");
 const now=Date.now(),hour=3600000,end=Math.floor(now/hour)*hour,start=end-24*hour;
 const byHour=new Map();
 rainSamples.forEach(sample=>{
  const time=Date.parse(sample.observed_at_utc||sample.logged_at_utc||""),value=num(sample.precipitation_1h_mm);
  if(!Number.isFinite(time)||time<start||time>=end||value==null)return;
  const bucket=Math.floor(time/hour),previous=byHour.get(bucket);
  if(!previous||time>previous.time)byHour.set(bucket,{time,value});
 });
 const hourlyRain=[...byHour.values()].sort((a,b)=>a.time-b.time);
 const maxPoint=hourlyRain.reduce((best,p)=>!best||p.value>best.value?p:best,null);
 const maxBadge=$("station-rain-max");
 if(maxBadge){
  if(maxPoint){maxBadge.hidden=false;maxBadge.textContent="24 saatte max "+fmt(maxPoint.value)+" mm / 1 sa";maxBadge.title="En yüksek kayan 1 saatlik yağış · "+ts(maxPoint.time);}
  else{maxBadge.hidden=true;maxBadge.textContent="";maxBadge.removeAttribute("title");}
 }
 bindStationHistoryTooltip("station-temperature-trend");
 bindStationHistoryTooltip("station-rain-trend");
}
function gfsRunLabel(run){
 const date=new Date(run && run.run_id_utc||"");
 if(!Number.isFinite(date.getTime()))return "GFS döngüsü";
 const utcHour=String(date.getUTCHours()).padStart(2,"0")+"Z";
 return ts(date.toISOString())+" · "+utcHour;
}
function renderRunLegend(source){
 const host=$("next-72h-legend");
 if(!host)return;
 if(!source.length){
  host.innerHTML='<span class="next-72h-legend-loading">GFS döngü bilgisi bekleniyor…</span>';
  return;
 }
 host.innerHTML=source.slice(0,4).map((run,index)=>{
  const latest=index===0,color=COLORS[index%COLORS.length];
  return '<span class="next-72h-legend-item'+(latest?' is-latest':'')+'" role="listitem"><i class="next-72h-legend-line" style="--run-color:'+color+'" aria-hidden="true"></i><span>'+esc(gfsRunLabel(run))+'</span>'+(latest?'<b class="next-72h-legend-tag">EN GÜNCEL</b>':'')+'</span>';
 }).join("");
}
function renderRuns(d,f180){
 const historyRuns=(Array.isArray(d && d.runs)?d.runs:[])
  .filter(run=>run&&Array.isArray(run.forecast_6_hourly)&&run.forecast_source==="meteopt")
  .sort((a,b)=>Date.parse(b.run_id_utc||"")-Date.parse(a.run_id_utc||""))
  .slice(0,4);
 const tableRun=f180&&Array.isArray(f180.forecast_6_hourly)&&f180.forecast_source==="meteopt"?f180:null;
 // The latest F180-ready series is the exact same object used by renderF180() for the MeteoPT table.
 // Older lines come from the archived MeteoPT comparison bundle.
 const source=tableRun
  ? [tableRun,...historyRuns.filter(run=>run.run_id_utc!==tableRun.run_id_utc)].slice(0,4)
  : historyRuns;
 const runs=historyRuns;
 const svgContainer=$("koy-gfs-comparison-container");
 if(svgContainer){
  const svgRuns=historyRuns.slice(0,4);
  if(svgRuns.length<4){
   svgContainer.dataset.svgSrc="";
   svgContainer.innerHTML='<div class="gfs-chart-loading">Dört tam Köy GFS döngüsü karşılaştırma için bekleniyor ('+svgRuns.length+'/4).</div>';
  }else{
   const latestSvgRun=svgRuns[0];
   const runDate=new Date(latestSvgRun.run_id_utc);
   const runStamp=runDate.getUTCFullYear()+String(runDate.getUTCMonth()+1).padStart(2,"0")+String(runDate.getUTCDate()).padStart(2,"0")+"T"+String(runDate.getUTCHours()).padStart(2,"0")+"Z";
   const version=encodeURIComponent((d && d.updated_at_utc||latestSvgRun.published_at_utc||latestSvgRun.run_id_utc)+"|koy-svg-absolute-path-v5");
   const assetRoot=window.location.pathname.startsWith("/gfs-watch/")?"/gfs-watch/":"/";
   const svgPath=assetRoot+"koy-data/gfs/media/koy-gfs-"+runStamp+"-comparison.svg";
   const svgUrl=new URL(svgPath,window.location.origin).href+"?v="+version;
   if(svgContainer.dataset.svgSrc!==svgUrl){
    svgContainer.dataset.svgSrc=svgUrl;
    svgContainer.innerHTML="";
    const chart=document.createElement("div");
    chart.className="gfs-interactive-chart";
    chart.dataset.svgSrc=svgUrl;
    chart.dataset.chartLabel="Köy GFS · Giresun / Çanakçı dört panelli etkileşimli valid-time karşılaştırması";
    const loading=document.createElement("div");
    loading.className="gfs-chart-loading";
    loading.textContent="Köy GFS etkileşimli SVG raporu yükleniyor…";
    chart.appendChild(loading);
    svgContainer.appendChild(chart);
    if(typeof loadInteractiveGfsCharts==="function")loadInteractiveGfsCharts(svgContainer);
   }
  }
 }
 renderRunLegend(source);
 const next72Meta=$("next-72h-meta");
 if(next72Meta)next72Meta.textContent=source.length?source.length+" GFS döngüsü · F180'e kadar karşılaştırılıyor":"MeteoPT GFS verisi bekleniyor";
 // Both charts align all four MeteoPT runs by exact valid_time_utc; older cycles may use different F-hour numbers.
 const chartSource=source;
 const realized=realizedErrorStats(runs,stationHistory,"temperature_2m_c");
 $("next72-temperature").innerHTML=svgLine(chartSource,"temperature_2m_c","2 m sıcaklık · aynı geçerlilik saatleri TSİ","°C",180,realized);
 $("next72-precipitation").innerHTML=svgLine(chartSource,"precipitation_6h_mm","3 saatlik yağış · aynı geçerlilik saatleri TSİ","mm / 3 saat",180);
 bindGfsChartTooltip("next72-temperature");
 bindGfsChartTooltip("next72-precipitation");
 const first=source[0],p=first?pointsOf(first,180):[];
 if(p.length){
   $("gfs-daily-cycle-chip").textContent="GFS döngüsü: "+ts(first.run_id_utc);
   $("gfs-daily-updated-chip").textContent="Yayın: "+ts(first.published_at_utc);
 } else {
   $("gfs-daily-cycle-chip").textContent="GFS döngüsü bekleniyor";
   $("gfs-daily-updated-chip").textContent="Yayın zamanı bekleniyor";
 }
 if(p.length){
   const daily=new Map();
   p.forEach(x=>{const k=dayKey(x.valid_time_utc);if(!daily.has(k))daily.set(k,[]);const v=num(x.temperature_2m_c);if(v!=null)daily.get(k).push(v)});
   // Sentence-based briefing for the Koy panel.
   const fiveDays=[...daily.entries()].slice(0,5);
   const allFiveTemps=fiveDays.flatMap(([,values])=>values);
   const tempMin=allFiveTemps.length?Math.min(...allFiveTemps):null;
   const tempMax=allFiveTemps.length?Math.max(...allFiveTemps):null;
   const tempSpread=tempMin!=null&&tempMax!=null?tempMax-tempMin:null;
   let tempSentence="Önümüzdeki beş gün için sıcaklık tahmini bekleniyor.";
   if(tempMin!=null&&tempMax!=null){
    const stability=tempSpread<=2?"belirgin değişim göstermeden stabil seyrediyor":tempSpread<=4?"hafif dalgalanarak seyrediyor":"belirgin değişimler gösteriyor";
    const nowTemp=num(window.__koyCurrentTemp);
    tempSentence="Önümüzdeki beş gün boyunca sıcaklık "+stability+", "+fmt(tempMin,1)+"–"+fmt(tempMax,1)+"°C aralığında.";
    if(nowTemp!=null)tempSentence+=" Çanakçı şu an "+fmt(nowTemp,1)+"°C.";
   }
   $("brief-temperature-trend").textContent=tempSentence;
   const rainy=p.filter(x=>num(x.precipitation_6h_mm)>0.1);
   const rainGroups=[];
   for(const point of rainy){
    const day=dayKey(point.valid_time_utc);
    const value=num(point.precipitation_6h_mm);
    const existing=rainGroups.find(g=>g.day===day);
    if(existing){
     existing.last=point;
     existing.total+=value||0;
    }else{
     rainGroups.push({day,first:point,last:point,total:value||0});
    }
   }
   const rainByDay=new Map(rainGroups.map(group=>[group.day,group]));
   const rainDays=fiveDays.map(([day])=>{
    const group=rainByDay.get(day);
    const dayDate=new Date(day+"T12:00:00Z");
    const dayName=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",weekday:"long"}).format(dayDate);
    const label=dayName.charAt(0).toUpperCase()+dayName.slice(1);
    if(!group)return label+" · yağış yok";
    const firstDate=new Date(group.first.valid_time_utc),lastDate=new Date(group.last.valid_time_utc);
    const start=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(firstDate);
    const end=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(lastDate);
    const part=firstDate.getUTCHours()<12?"öğleden önce":"öğleden sonra";
    const windowText=start===end?start:start+"–"+end;
    return label+" · "+windowText+" · "+part+" · "+fmt(group.total,1)+" mm";
   });
   $("brief-rain-lines").innerHTML='<div class="brief-rain-days">'+rainDays.map(line=>'<div class="brief-rain-day">'+esc(line)+'</div>').join("")+'</div>';
   const dailyItems=[...daily.entries()].slice(0,8).map(([k,v])=>({date_istanbul:k,temperature_min_c:Math.min(...v),temperature_max_c:Math.max(...v),precipitation_total_mm:p.filter(x=>dayKey(x.valid_time_utc)===k).reduce((a,x)=>a+(num(x.precipitation_6h_mm)||0),0),wind_speed_max_10m_kmh:Math.max(...p.filter(x=>dayKey(x.valid_time_utc)===k).map(x=>num(x.wind_speed_10m_kmh)||0))}));
   $("daily-grid").innerHTML=dailyItems.map(item=>'<article class="day"><div class="day-name">'+dayLabel(item.date_istanbul)+'</div><div class="day-icon">'+(item.precipitation_total_mm>=5?"🌧️":item.precipitation_total_mm>=1?"🌦️":"⛅")+'</div><div class="day-range">'+fmt(item.temperature_max_c,0)+'° <span>'+fmt(item.temperature_min_c,0)+'°</span></div><div class="day-rain">☂ '+fmt(item.precipitation_total_mm,1)+' mm</div><div class="day-wind">↗ '+fmt(item.wind_speed_max_10m_kmh,0)+' km/sa</div></article>').join("");
 }
}
async function refresh(){if(busy)return;busy=true;
 const results=await Promise.allSettled([
  get("comparison"),getStation("/history/canakci?hours=72"),
  getStation("/stations/canakci")
 ]);
 if(results[0].status==="fulfilled")comparison=results[0].value;
 const archivedF180=(comparison&&Array.isArray(comparison.runs)?comparison.runs:[])
  .filter(run=>{
   if(!run||run.forecast_source!=="meteopt"||!Array.isArray(run.forecast_6_hourly))return false;
   const pts=pointsOf(run,180);
   return pts.length>=30&&pts.some(point=>Number(point.forecast_hour)>=180);
  })
  .sort((a,b)=>Date.parse(b.run_id_utc||"")-Date.parse(a.run_id_utc||""));
 f180=archivedF180[0]||null;
 if(f180){
  renderF180(stationMode==="home"?homeGfsDocument(f180):f180);
 }else{
  const body=$("meteopt-table-body");
  if(body)body.innerHTML='<tr><td colspan="10" class="meteopt-table-empty">F180 tamamlanmış MeteoPT GFS döngüsü bekleniyor.</td></tr>';
  $("meteopt-table-status").textContent="F180 çıktısı bekleniyor";
  $("meteopt-table-run").textContent="F180 döngüsü bekleniyor";
  $("meteopt-table-updated").textContent="180. saat tamamlanınca yayınlanacak";
 }
 if(results[1].status==="fulfilled")stationHistory=results[1].value;else stationHistory=null;
 // The MGM history is the canonical source for both temperature and rainfall.
 // Keep a single request so the page cannot render two different history snapshots.
 rainHistory=stationHistory;
 evHistory=null;
 evObservation=null;
 // During the publish gap, derive the same virtual station locally from the canonical MGM payload.
 if(!evHistory&&stationHistory)evHistory=buildVirtualHomeHistory(stationHistory);
 const initialHistory=stationMode==="home"?evHistory:stationHistory;
 const initialRainHistory=stationMode==="home"?evHistory:rainHistory;
 if(initialHistory){
  renderStationHistory(initialHistory,initialRainHistory);
 }else{
  $("station-temperature-trend").innerHTML='<div class="station-trend-empty">'+(stationMode==="home"?"Köy Ev sanal istasyon geçmişi bekleniyor…":"MGM istasyon geçmişi bekleniyor…")+'</div>';
  $("station-rain-trend").innerHTML='<div class="station-trend-empty">'+(stationMode==="home"?"Köy Ev sanal yağış arşivi bekleniyor…":"MGM yağış arşivi bekleniyor…")+'</div>';
 }
 if(results[2].status==="fulfilled"&&results[2].value && results[2].value.station){
  window.__koyMgmObservation=results[2].value.station;
  if(!evObservation)evObservation=buildVirtualHomeObservation(window.__koyMgmObservation);
  window.__koyCurrentTemp=num(results[2].value.station.temperature_c == null ? results[2].value.station.temperature_2m_c : results[2].value.station.temperature_c);
  const o=window.__koyMgmObservation;
  $("mgm-status-date").textContent=ts(o.last_attempt_utc||o.fetched_at_utc||o.observed_at_utc);
  $("mgm-source-temp").innerHTML=fmt(o.temperature_2m_c)+"<small>°C</small>";
  $("mgm-source-status").textContent="Canlı MGM ölçümü · son 1 saat yağış "+fmt(o.precipitation_1h_mm)+" mm";
  $("mgm-source-fill").style.width=Math.min(100,Math.max(0,(num(o.precipitation_1h_mm)||0)*8))+"%";
 }
 // Render the selected station independently from the MGM fetch result.
 // This is important for Köy Ev: its derived payload is a separate artifact.
 const selectedObservation=stationMode==="home"?evObservation:window.__koyMgmObservation;
 const selectedHistory=stationMode==="home"?evHistory:stationHistory;
 if(selectedObservation)renderMgmObservation(selectedObservation,selectedHistory,f180);
 renderRuns(stationMode==="home"?homeGfsComparison(comparison):comparison,stationMode==="home"?homeGfsDocument(f180):f180);
 busy=false;
}
function setStationMode(mode){
 stationMode=mode==="home"?"home":"mgm";
 $("station-enka-button") && $("station-enka-button").classList.toggle("active",stationMode==="mgm");
 $("station-home-button") && $("station-home-button").classList.toggle("active",stationMode==="home");
 $("station-enka-button") && $("station-enka-button").setAttribute("aria-pressed",stationMode==="mgm"?"true":"false");
 $("station-home-button") && $("station-home-button").setAttribute("aria-pressed",stationMode==="home"?"true":"false");
 const o=stationMode==="home"?evObservation:window.__koyMgmObservation;
 const h=stationMode==="home"?evHistory:stationHistory;
 if(h)renderStationHistory(h,stationMode==="home"?h:rainHistory);
 if(o)renderMgmObservation(o,h,stationMode==="home"?homeGfsDocument(f180):f180);
 renderRuns(stationMode==="home"?homeGfsComparison(comparison):comparison,stationMode==="home"?homeGfsDocument(f180):f180);
}
$("station-enka-button") && $("station-enka-button").addEventListener("click",()=>setStationMode("mgm"));
$("station-home-button") && $("station-home-button").addEventListener("click",()=>setStationMode("home"));
// Köy Ev is the canonical default; only an explicit MGM selection may switch away from it.
setStationMode("home");
refresh();
setInterval(()=>{if(document.visibilityState!=="hidden")refresh()},60000);
})();