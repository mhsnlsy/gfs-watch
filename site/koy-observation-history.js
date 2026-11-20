(() => {
"use strict";
const API=(window.GFS_WATCH_STATIONS_API||"https://gfs-watch-stations.muhsin-ulusoy.workers.dev")+"/api";
// Köy History v1.1 — published asset marker
const TZ="Europe/Istanbul";
const C={temperature:"#ef4444",dewPoint:"#3b82f6",precipitation1h:"#19a7e0",dailyPrecipitation:"#f97316",windChill:"#8b5cf6",heatIndex:"#eab308",humidity:"#16b981",windSpeed:"#10b981",windDirection:"#6366f1",pressure:"#f59e0b",precipitation10m:"#14b8a6",precipitation6h:"#8b5cf6",precipitation12h:"#ec4899",precipitation24h:"#f43f5e"};
const V=[
{id:"temperature",label:"Temperature",color:C.temperature,field:"temperature_c",unit:"°C",digits:1},
{id:"dewPoint",label:"Dew Point",color:C.dewPoint,field:"dew_point_c",unit:"°C",digits:1},
{id:"precipitation1h",label:"Precipitation 1h",color:C.precipitation1h,field:"rain_1h_mm",unit:"mm",digits:1,rain:true},
{id:"dailyPrecipitation",label:"Daily Precipitation",color:C.dailyPrecipitation,field:"rain_00_now_mm",unit:"mm",digits:1,rain:true},
{id:"windChill",label:"Wind Chill",color:C.windChill,field:"wind_chill_c",unit:"°C",digits:1},
{id:"heatIndex",label:"Heat Index",color:C.heatIndex,field:"heat_index_c",unit:"°C",digits:1},
{id:"humidity",label:"Relative Humidity",color:C.humidity,field:"humidity_percent",unit:"%",digits:0},
{id:"windSpeed",label:"Wind Speed",color:C.windSpeed,field:"wind_speed_kmh",unit:"km/h",digits:1},
{id:"windDirection",label:"Wind Direction",color:C.windDirection,field:"wind_direction",unit:"°",digits:0},
{id:"pressure",label:"Pressure",color:C.pressure,field:"pressure_hpa",unit:"hPa",digits:1},
{id:"precipitation10m",label:"Precipitation 10m",color:C.precipitation10m,field:"rain_10m_mm",unit:"mm",digits:1,rain:true},
{id:"precipitation6h",label:"Precipitation 6h",color:C.precipitation6h,field:"rain_6h_mm",unit:"mm",digits:1,rain:true},
{id:"precipitation12h",label:"Precipitation 12h",color:C.precipitation12h,field:"rain_12h_mm",unit:"mm",digits:1,rain:true},
{id:"precipitation24h",label:"Precipitation 24h",color:C.precipitation24h,field:"rain_24h_mm",unit:"mm",digits:1,rain:true}
];
const state={hours:24,zone:"local",selected:["temperature","dewPoint","precipitation1h","dailyPrecipitation"],cache:new Map(),opened:false,loading:new Set(),openPicker:false};
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const val=v=>v===null||v===undefined||v===""||!Number.isFinite(Number(v))?null:Number(v);
const fmt=(v,d)=>v===null||!Number.isFinite(v)?"—":v.toLocaleString("tr-TR",{minimumFractionDigits:d,maximumFractionDigits:d});
const tz=()=>TZ;
function dateLabel(v,hours,axis){const d=new Date(v);if(!Number.isFinite(d.getTime()))return "—";if(axis&&hours>48)return new Intl.DateTimeFormat("en-GB",{timeZone:tz(),weekday:"short",day:"2-digit",month:"short"}).format(d);if(axis)return new Intl.DateTimeFormat("en-GB",{timeZone:tz(),hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(d);return new Intl.DateTimeFormat("en-GB",{timeZone:tz(),weekday:"short",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(d);}
function injectStyle(){
 if($("koy-observation-history-style"))return;
 const style=document.createElement("style");style.id="koy-observation-history-style";
 style.textContent=[
 "#koy-observation-history{margin-top:22px;min-width:0}",
 "#koy-observation-history [hidden]{display:none!important}",
 "#koy-observation-history .oh-toggle{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border:1px solid rgba(125,211,215,.24);border-radius:14px;background:rgba(125,211,215,.07);color:#dbe9ed;font:700 12px DM Sans,sans-serif;cursor:pointer;text-align:left}",
 "#koy-observation-history .oh-toggle:active{background:rgba(125,211,215,.13)}",
 "#koy-observation-history .oh-toggle-icon{font-size:17px;color:#7dd3d7;transition:transform .18s ease}",
 "#koy-observation-history .oh-toggle[aria-expanded=true] .oh-toggle-icon{transform:rotate(180deg)}",
 "#koy-observation-history .oh-content{margin-top:12px}",
 "#koy-observation-history .oh-panel{background:#1b232f;border:1px solid rgba(204,225,239,.11);border-radius:21px;overflow:hidden;box-shadow:0 18px 55px rgba(0,0,0,.12)}",
 "#koy-observation-history .oh-head{padding:18px 20px 0}",
 "#koy-observation-history .oh-title{font:600 15px Manrope,sans-serif;color:#eef5f8}",
 "#koy-observation-history .oh-sub{font-size:10px;color:#8998a7;margin-top:4px}",
 "#koy-observation-history .oh-current-time{font-size:10px;color:#8d99a6;margin-top:17px}",
 "#koy-observation-history .oh-toggle-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:14px}",
 "#koy-observation-history .oh-segment,#koy-observation-history .oh-zone{display:flex;background:#111821;border:1px solid rgba(204,225,239,.08);border-radius:13px;padding:3px}",
 "#koy-observation-history button{font-family:DM Sans,sans-serif}",
 "#koy-observation-history .oh-segment button{border:0;background:transparent;color:#697786;font-size:10px;font-weight:700;padding:8px 17px;border-radius:10px;cursor:pointer}",
 "#koy-observation-history .oh-segment button.active{background:#202a38;color:#edf5f8;box-shadow:0 2px 10px rgba(0,0,0,.12)}",
 "#koy-observation-history .oh-zone button{border:0;background:transparent;color:#697786;font-size:10px;font-weight:700;padding:8px 15px;border-radius:10px;cursor:pointer}",
 "#koy-observation-history .oh-zone button.active{background:#202a38;color:#edf5f8}",
 "#koy-observation-history .oh-vars{display:flex;flex-wrap:wrap;gap:8px;padding:14px 20px 5px}",
 "#koy-observation-history .oh-chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--chip-color);color:#aeb7c2;background:rgba(255,255,255,.015);border-radius:999px;padding:7px 10px;font-size:10px;white-space:nowrap}",
 "#koy-observation-history .oh-chip-dot{width:8px;height:8px;border-radius:50%;background:var(--chip-color);flex:none}",
 "#koy-observation-history .oh-chip-x{border:0;background:transparent;color:#66727f;padding:0 0 0 2px;font-size:15px;line-height:1;cursor:pointer}",
 "#koy-observation-history .oh-add{margin:5px 20px 16px;border:1px dashed rgba(204,225,239,.14);background:#171e28;color:#8d98a6;border-radius:999px;padding:9px 14px;font-size:10px;font-weight:600;cursor:pointer}",
 "#koy-observation-history .oh-add:hover{color:#e7eef3;border-color:rgba(125,211,215,.3)}",
 "#koy-observation-history .oh-chart-list{display:grid;gap:8px;padding:0 20px 20px}",
 "#koy-observation-history .oh-chart{background:#202832;border-radius:17px;padding:17px 16px 13px;min-width:0}",
 "#koy-observation-history .oh-chart-head{display:flex;justify-content:space-between;gap:10px;align-items:center}",
 "#koy-observation-history .oh-chart-name{display:flex;align-items:center;gap:8px;color:#aeb7c2;font-size:12px}",
 "#koy-observation-history .oh-chart-dot{width:9px;height:9px;border-radius:50%;flex:none}",
 "#koy-observation-history .oh-value{font:700 15px Manrope,sans-serif;color:var(--chart-color);white-space:nowrap}",
 "#koy-observation-history .oh-graph{height:160px;margin-top:7px;touch-action:none}",
 "#koy-observation-history svg{width:100%;height:100%;display:block;overflow:visible}",
 "#koy-observation-history .oh-grid{stroke:rgba(200,220,235,.10);stroke-width:1}",
  "#koy-observation-history .oh-line{fill:none;stroke:var(--chart-color);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}",
  "#koy-observation-history .oh-point{fill:transparent;stroke:transparent;stroke-width:12;cursor:crosshair;pointer-events:none;vector-effect:non-scaling-stroke}",
  "#koy-observation-history .oh-point:hover{fill:transparent;stroke:transparent}",
 "#koy-observation-history .oh-crosshair{stroke:rgba(238,245,248,.42);stroke-width:1;stroke-dasharray:4 4;pointer-events:none;vector-effect:non-scaling-stroke}",
  "#koy-observation-history .oh-tooltip{position:fixed;z-index:100000;pointer-events:none;display:none;min-width:120px;max-width:190px;padding:8px 10px;border:1px solid rgba(204,225,239,.18);border-radius:9px;background:rgba(17,24,33,.96);box-shadow:0 8px 25px rgba(0,0,0,.35);color:#eef5f8;font:10px/1.45 DM Sans,sans-serif}",
  "#koy-observation-history .oh-tooltip strong{display:block;color:var(--chart-color);font-size:12px;margin-bottom:2px}",
  "#koy-observation-history .oh-tooltip span{display:block;color:#aeb7c2}",
 "#koy-observation-history .oh-range{font-size:9px;color:#8d99a6;margin-top:1px}",
 "#koy-observation-history .oh-axis{display:flex;justify-content:space-between;gap:5px;color:#7e8a98;font-size:8px;margin-top:7px}",
 "#koy-observation-history .oh-axis span{text-align:center;flex:1;white-space:nowrap}",
 "#koy-observation-history .oh-empty{padding:38px 8px;text-align:center;color:#8b98a6;font-size:11px}",
 "#koy-observation-history .oh-picker-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:99990;display:none}",
 "#koy-observation-history .oh-picker-backdrop.open{display:block}",
 "#koy-observation-history .oh-picker{position:fixed;left:0;right:0;bottom:0;z-index:99991;background:#1b232f;border-radius:25px 25px 0 0;border:1px solid rgba(204,225,239,.12);box-shadow:0 -25px 70px rgba(0,0,0,.45);max-height:78vh;overflow:auto;transform:translateY(100%);transition:transform .18s ease}",
 "#koy-observation-history .oh-picker.open{transform:translateY(0)}",
 "#koy-observation-history .oh-picker-head{padding:22px 24px 16px;border-bottom:1px solid rgba(204,225,239,.08);font:600 16px Manrope,sans-serif;color:#eef5f8}",
 "#koy-observation-history .oh-option{display:flex;align-items:center;gap:12px;width:100%;padding:15px 24px;border:0;border-bottom:1px solid rgba(204,225,239,.07);background:transparent;color:#e1e8ed;text-align:left;font-size:13px;cursor:pointer}",
 "#koy-observation-history .oh-option:last-child{border-bottom:0}",
 "#koy-observation-history .oh-option:disabled{color:#66727f;cursor:default}",
 "#koy-observation-history .oh-option-dot{width:10px;height:10px;border-radius:50%;background:var(--option-color);flex:none}",
 "@media(max-width:560px){#koy-observation-history{margin-top:18px}#koy-observation-history .oh-head{padding:17px 15px 0}#koy-observation-history .oh-toggle-row{align-items:stretch;flex-direction:column}#koy-observation-history .oh-segment,#koy-observation-history .oh-zone{width:100%}#koy-observation-history .oh-segment button,#koy-observation-history .oh-zone button{flex:1}#koy-observation-history .oh-vars{padding:12px 15px 4px}#koy-observation-history .oh-add{margin-left:15px;margin-right:15px}#koy-observation-history .oh-chart-list{padding-left:15px;padding-right:15px}#koy-observation-history .oh-chart{padding:15px 13px 12px;border-radius:15px}#koy-observation-history .oh-graph{height:145px}#koy-observation-history .oh-value{font-size:13px}}"
 ].join("\n");
 document.head.appendChild(style);
}
function build(){
 if($("koy-observation-history"))return;
 const panel=document.querySelector(".koy-climate-panel");if(!panel)return;
 const root=document.createElement("div");root.id="koy-observation-history";
 root.innerHTML=
 '<button type="button" class="oh-toggle" id="oh-toggle" aria-expanded="false" aria-controls="oh-content"><span>Geçmiş</span><span class="oh-toggle-icon" aria-hidden="true">⌄</span></button>'+
 '<section class="oh-content" id="oh-content" hidden aria-label="Observation History"><div class="oh-panel">'+
 '<div class="oh-head"><div class="oh-title">Observation History</div><div class="oh-sub">Çanakçı MGM · istasyon gözlemleri</div><div class="oh-current-time" id="oh-current-time">Son ölçüm zamanı bekleniyor</div>'+
 '<div class="oh-toggle-row"><div class="oh-segment" id="oh-window">'+
 '<button type="button" data-hours="24" class="active">24h</button><button type="button" data-hours="48">48h</button><button type="button" data-hours="168">7d</button><button type="button" data-hours="720">30d</button></div>'+
 '<div class="oh-zone" id="oh-zone"><button type="button" data-zone="local" class="active">Local</button><button type="button" data-zone="utc">UTC</button></div></div></div>'+
 '<div class="oh-vars" id="oh-vars"></div><button type="button" class="oh-add" id="oh-add">＋ Add variable</button>'+
 '<div class="oh-chart-list" id="oh-charts"><div class="oh-empty">Geçmiş veriler yükleniyor…</div></div></div></section>'+
 '<div class="oh-tooltip" id="oh-tooltip" role="status" aria-live="polite"></div><div class="oh-picker-backdrop" id="oh-backdrop"></div><div class="oh-picker" id="oh-picker" role="dialog" aria-modal="true" aria-label="Add variable"><div class="oh-picker-head">Add variable</div><div id="oh-options"></div></div>';
 panel.appendChild(root);
 bind();renderChips();renderCharts();
}
function bind(){
 $("oh-toggle").addEventListener("click",()=>{state.opened=!state.opened;$("oh-content").hidden=!state.opened;$("oh-toggle").setAttribute("aria-expanded",String(state.opened));if(state.opened){if(state.cache.has(state.hours))renderCharts();else load();}else if(state.openPicker)closePicker();});
 $("oh-window").addEventListener("click",e=>{const b=e.target.closest("button[data-hours]");if(!b)return;state.hours=Number(b.dataset.hours);$("oh-window").querySelectorAll("button").forEach(x=>x.classList.toggle("active",x===b));load();});
 $("oh-zone").addEventListener("click",e=>{const b=e.target.closest("button[data-zone]");if(!b)return;state.zone=b.dataset.zone;$("oh-zone").querySelectorAll("button").forEach(x=>x.classList.toggle("active",x===b));renderCharts();});
 $("oh-add").addEventListener("click",openPicker);$("oh-backdrop").addEventListener("click",closePicker);
 $("oh-options").addEventListener("click",e=>{const b=e.target.closest("button[data-variable]");if(!b||b.disabled)return;const id=b.dataset.variable;if(state.selected.includes(id))return;state.selected.push(id);closePicker();renderChips();renderCharts();});
 $("oh-vars").addEventListener("click",e=>{const b=e.target.closest("button[data-remove]");if(!b)return;state.selected=state.selected.filter(id=>id!==b.dataset.remove);renderChips();renderCharts();});
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&state.openPicker)closePicker();});
}
function openPicker(){
 $("oh-options").innerHTML=V.map(v=>{const disabled=state.selected.includes(v.id);return '<button type="button" class="oh-option" data-variable="'+v.id+'" '+(disabled?"disabled":"")+'><span class="oh-option-dot" style="--option-color:'+v.color+'"></span>'+esc(v.label)+'</button>';}).join("");
 $("oh-backdrop").classList.add("open");$("oh-picker").classList.add("open");state.openPicker=true;
}
function closePicker(){$("oh-backdrop").classList.remove("open");$("oh-picker").classList.remove("open");state.openPicker=false;}
function renderChips(){
 $("oh-vars").innerHTML=state.selected.map(id=>{const v=V.find(item=>item.id===id);if(!v)return "";return '<span class="oh-chip" style="--chip-color:'+v.color+'"><span class="oh-chip-dot"></span>'+esc(v.label)+'<button type="button" class="oh-chip-x" data-remove="'+v.id+'" aria-label="Remove '+esc(v.label)+'">×</button></span>';}).join("");
}
async function load(){
 const key=state.hours;if(state.cache.has(key)){renderCharts();return;}if(state.loading.has(key))return;
 state.loading.add(key);$("oh-charts").innerHTML='<div class="oh-empty">Geçmiş veriler yükleniyor…</div>';
 try{
  const bucket=key<=48?10:key<=168?30:60;
  const response=await fetch(API+"/history-graph/canakci?hours="+key+"&bucket="+bucket+"&v="+Date.now(),{cache:"no-store"});
  if(!response.ok)throw new Error("HTTP "+response.status);
  const data=await response.json();if(data.ok!==true||!Array.isArray(data.samples))throw new Error(data.error||"Invalid history payload");
  state.cache.set(key,data);renderCharts();
 }catch(error){if(state.hours===key)$("oh-charts").innerHTML='<div class="oh-empty">Geçmiş veriler şu anda alınamadı. Biraz sonra yeniden deneyebilirsin.</div>';console.error("Köy Observation History:",error);}
 finally{state.loading.delete(key);}
}
function showTooltipAtX(clientX,chartRect,html,color){const tip=$("oh-tooltip");if(!tip)return;tip.style.setProperty("--chart-color",color);tip.innerHTML=html;tip.style.display="block";const rect=tip.getBoundingClientRect(),m=10;let left=clientX-rect.width/2;let top=chartRect.top-rect.height-10;if(top<m)top=chartRect.top+10;if(left+rect.width>innerWidth-m)left=innerWidth-rect.width-m;if(left<m)left=m;tip.style.left=left+"px";tip.style.top=top+"px"}
function hideTooltip(){const tip=$("oh-tooltip");if(tip)tip.style.display="none"}
function localDailyPrecipitation(points){
 const out=[];
 let dayKey="",startRaw=null,carry=0,prevRaw=null;
 for(const p of points){
  const d=new Date(p.time);
  const localKey=new Date(d.getTime()+180*60000).toISOString().slice(0,10);
  if(localKey!==dayKey){
   dayKey=localKey;startRaw=Number(p.value)||0;carry=0;prevRaw=startRaw;
  }else if(prevRaw!==null && Number(p.value)<prevRaw-0.05){
   carry=Math.max(0,prevRaw-(startRaw||0));
  }
  const raw=Number(p.value)||0;
  const value=raw>=prevRaw-0.05 && carry===0 ? Math.max(0,raw-(startRaw||0)) : Math.max(0,carry+raw);
  out.push({time:p.time,value});
  prevRaw=raw;
 }
 return out;
}
function renderCharts(){
 if(!state.opened)return;
 const data=state.cache.get(state.hours);
 if(!data||!Array.isArray(data.samples)||!data.samples.length){$("oh-current-time").textContent="Bu dönem için kayıt bulunamadı";$("oh-charts").innerHTML='<div class="oh-empty">Bu dönem için kayıt bulunamadı.</div>';return;}
 const latest=data.samples[data.samples.length-1];$("oh-current-time").textContent=dateLabel(latest.latest_fetched_at_utc||latest.bucket_utc,state.hours,false);
 $("oh-charts").innerHTML=state.selected.map(id=>{const v=V.find(item=>item.id===id);if(!v)return "";let points=data.samples.map(s=>({time:s.bucket_utc,value:val(s[v.field])})).filter(p=>p.value!==null);if(v.id==="dailyPrecipitation")points=localDailyPrecipitation(points);return renderChart(v,points,state.hours);}).join("");bindChartTooltips();
}
function renderChart(v,points,hours){
 if(!points.length)return '<article class="oh-chart" style="--chart-color:'+v.color+'"><div class="oh-chart-name"><span class="oh-chart-dot" style="background:'+v.color+'"></span>'+esc(v.label)+'</div><div class="oh-empty">Bu değişken için ölçüm bulunmuyor.</div></article>';
 const width=1000,height=180,pad={l:8,r:8,t:8,b:25},values=points.map(p=>p.value),min=Math.min.apply(null,values),max=Math.max.apply(null,values);
 const low=v.rain?0:(max===min?min-.5:min),high=v.rain?Math.max(max,.5):(max===min?max+.5:max);
 const x=i=>pad.l+(i/Math.max(1,points.length-1))*(width-pad.l-pad.r),y=value=>pad.t+(1-(value-low)/(high-low))*(height-pad.t-pad.b);
 const path=points.map((p,i)=>(i?"L":"M")+x(i).toFixed(2)+" "+y(p.value).toFixed(2)).join(" ");
 const grid=[.25,.5,.75].map(f=>{const gy=(pad.t+f*(height-pad.t-pad.b)).toFixed(1);return '<line class="oh-grid" x1="'+pad.l+'" x2="'+(width-pad.r)+'" y1="'+gy+'" y2="'+gy+'"></line>';}).join("");
 const last=points[points.length-1],tickCount=Math.min(6,points.length),ticks=[];
 for(let i=0;i<tickCount;i++){const ix=Math.round(i*(points.length-1)/Math.max(1,tickCount-1));ticks.push(dateLabel(points[ix].time,hours,true));}
 return '<article class="oh-chart" style="--chart-color:'+v.color+'"><div class="oh-chart-head"><div class="oh-chart-name"><span class="oh-chart-dot" style="background:'+v.color+'"></span>'+esc(v.label)+'</div><div class="oh-value">'+fmt(last.value,v.digits)+' '+v.unit+'</div></div>'+
 '<div class="oh-graph"><svg viewBox="0 0 '+width+' '+height+'" preserveAspectRatio="none" role="img" aria-label="'+esc(v.label)+' history chart">'+grid+'<path class="oh-line" d="'+path+'"></path><line class="oh-crosshair" x1="0" y1="'+pad.t+'" x2="0" y2="'+(height-pad.b)+'" opacity="0"></line>'+points.map((p,i)=>{const px=x(i),py=y(p.value),time=dateLabel(p.time,hours,false),value=fmt(p.value,v.digits)+" "+v.unit;return '<circle class="oh-point" cx="'+px.toFixed(2)+'" cy="'+py.toFixed(2)+'" r="8" tabindex="0" data-time="'+esc(time)+'" data-value="'+esc(value)+'" aria-label="'+esc(time)+" · "+esc(value)+'"></circle>';}).join("")+'</svg></div>'+
 '<div class="oh-range">Lowest '+fmt(min,v.digits)+' · Highest '+fmt(max,v.digits)+' '+v.unit+'</div><div class="oh-axis">'+ticks.map(t=>'<span>'+esc(t)+'</span>').join("")+'</div></article>';
}
function bindChartTooltips(){
 document.querySelectorAll("#koy-observation-history .oh-chart").forEach(article=>{
  const svg=article.querySelector(".oh-graph svg");
  const points=Array.from(article.querySelectorAll(".oh-point"));
  const crosshair=svg?.querySelector(".oh-crosshair");
  if(!svg||!points.length||!crosshair)return;
  const label=article.querySelector(".oh-chart-name")?.textContent?.trim()||"";
  const color=article.style.getPropertyValue("--chart-color")||"";
  const nearest=e=>{
   const rect=svg.getBoundingClientRect();
   const sx=e.clientX;
   let best=null,bestD=Infinity;
   points.forEach(point=>{
    const px=rect.left+(Number(point.getAttribute("cx"))/1000)*rect.width;
    const d=Math.abs(sx-px);
    if(d<bestD){bestD=d;best=point;}
   });
   return best;
  };
  const show=e=>{
   const point=nearest(e);
   if(!point)return;
   const rect=svg.getBoundingClientRect();
   const px=Number(point.getAttribute("cx"));
   const clientX=rect.left+(px/1000)*rect.width;
   crosshair.setAttribute("x1",px.toFixed(2));
   crosshair.setAttribute("x2",px.toFixed(2));
   crosshair.setAttribute("y1","0");
   crosshair.setAttribute("y2","180");
   crosshair.setAttribute("opacity","1");
   const html="<strong>"+esc(label)+"</strong><span>"+esc(point.dataset.time||"—")+"</span><span>"+esc(point.dataset.value||"—")+"</span>";
   showTooltipAtX(clientX+8,rect,html,color);
  };
  const hide=()=>{hideTooltip();crosshair.setAttribute("opacity","0");};
  svg.addEventListener("pointerdown",e=>{svg.setPointerCapture?.(e.pointerId);show(e);});
  svg.addEventListener("pointermove",show);
  svg.addEventListener("pointerup",e=>{if(e.pointerType!=="mouse")hide();svg.releasePointerCapture?.(e.pointerId);});
  svg.addEventListener("pointercancel",hide);
  svg.addEventListener("pointerleave",e=>{if(e.pointerType==="mouse")hide();});
 });
}
function start(){injectStyle();build();}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();