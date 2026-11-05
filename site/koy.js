(() => {
"use strict";
const BASE="./koy-data/gfs/", MGM_BASE="./koy-data/mgm/", COLORS=["#7dd3d7","#8abce8","#f1c98b","#b38be8"];
const $=id=>document.getElementById(id);
const num=v=>v==null||v===""||!Number.isFinite(Number(v))?null:Number(v);
const fmt=(v,d=1)=>v==null?"—":Number(v).toLocaleString("tr-TR",{minimumFractionDigits:d,maximumFractionDigits:d});
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const ts=v=>{if(!v)return "—";const d=new Date(v);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}).format(d)+" TSİ":"—"};
const dayKey=v=>{const d=new Date(v);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit"}).format(d):"—"};
const dayLabel=k=>{const p=k.split("-");return p[2]+"."+p[1]};
let busy=false, f72=null, comparison=null, stationHistory=null;
async function get(path){const url=path.startsWith("./")?path:BASE+path;const r=await fetch(url+"?v="+Date.now(),{cache:"no-store"});if(!r.ok)throw Error("HTTP "+r.status+" · "+url);return r.json()}
function pointsOf(run,max=180){return (run?.forecast_6_hourly||[]).filter(p=>Number(p.forecast_hour)>0&&Number(p.forecast_hour)<=max).sort((a,b)=>Number(a.forecast_hour)-Number(b.forecast_hour))}
function svgLine(runs,metric,title,unit,maxHour=72){
 const usable=runs.map((r,runIndex)=>({run:r,runIndex,points:pointsOf(r,maxHour).map(p=>({h:Number(p.forecast_hour),v:num(p[metric]),validTime:p.valid_time_utc})).filter(p=>p.v!=null)})).filter(x=>x.points.length);
 if(!usable.length)return '<div class="chart-empty">Tahmin verisi bekleniyor…</div>';
 const hours=[...new Set(usable.flatMap(x=>x.points.map(p=>p.h)))].sort((a,b)=>a-b);
 const values=usable.flatMap(x=>x.points.map(p=>p.v));let lo=Math.min(...values),hi=Math.max(...values);
 if(metric.includes("temperature")){lo=Math.floor((lo-2)/2)*2;hi=Math.ceil((hi+2)/2)*2}else{lo=Math.min(0,lo);hi=Math.max(1,Math.ceil(hi*1.15))}
 if(hi===lo)hi=lo+1;
 const W=760,H=190,L=45,R=12,T=20,B=28,PW=W-L-R,PH=H-T-B;
 const x=h=>L+(hours.length===1?PW/2:(h-hours[0])/(hours[hours.length-1]-hours[0]||1))*PW;
 const y=v=>T+(hi-v)*PH/(hi-lo);
 let s='<svg class="koy-svg" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(title)+'">';
 for(let j=0;j<=3;j++){const v=lo+(hi-lo)*j/3,yy=y(v);s+='<line x1="'+L+'" y1="'+yy+'" x2="'+(W-R)+'" y2="'+yy+'" stroke="#294253" stroke-dasharray="3 5"/><text x="'+(L-7)+'" y="'+(yy+3)+'" text-anchor="end" fill="#91aab8" font-size="10">'+fmt(v,0)+'</text>'}
 hours.forEach(h=>{if(h%12!==0&&h!==hours[hours.length-1])return;s+='<text x="'+x(h)+'" y="'+(H-7)+'" text-anchor="middle" fill="#91aab8" font-size="10">'+(h===hours[0]?"Şimdi":"+"+h+"s")+'</text>'});
 const lookup=usable.map(x=>new Map(x.points.map(p=>[p.h,p.v])));
 const upper=[],lower=[];
 hours.forEach((h,i)=>{const vals=lookup.map(m=>m.get(h)).filter(v=>v!=null);if(vals.length){upper.push([x(h),y(Math.max(...vals))]);lower.push([x(h),y(Math.min(...vals))])}});
 if(upper.length>1){const band=upper.concat(lower.reverse()).map(p=>p.join(",")).join(" ");s+='<polygon points="'+band+'" fill="#75b9c8" opacity=".16"/>'}
 usable.forEach(item=>{
  const i=item.runIndex,color=COLORS[i%COLORS.length],latest=i===0;
  const path=item.points.map((p,j)=>(j?"L":"M")+x(p.h)+" "+y(p.v)).join(" ");
  s+='<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="'+(latest?3:1.8)+'" '+(latest?'':'stroke-dasharray="5 4"')+' stroke-linecap="round" stroke-linejoin="round"/>';
  if(latest)item.points.forEach(p=>{
   s+='<circle cx="'+x(p.h)+'" cy="'+y(p.v)+'" r="2.5" fill="'+color+'"><title>F'+p.h+' · '+fmt(p.v)+' '+unit+'</title></circle>';
  });
  item.points.forEach(p=>{
   s+='<circle class="gfs-point-target" cx="'+x(p.h)+'" cy="'+y(p.v)+'" r="0" data-run="'+esc(gfsRunLabel(item.run))+'" data-current="'+(latest?"true":"false")+'" data-valid="'+esc(ts(p.validTime))+'" data-step="'+esc("+"+p.h+" saat")+'" data-value="'+esc(fmt(p.v,1))+'" data-unit="'+esc(unit)+'" data-color="'+color+'" aria-hidden="true"/>';
  });
 });
 s+='</svg>';return s;
}
let activeGfsTooltip=null;
document.addEventListener("pointerdown",event=>{
 if(activeGfsTooltip&&!activeGfsTooltip.host.contains(event.target))activeGfsTooltip.hide();
},true);
function bindGfsChartTooltip(containerId){
 const host=$(containerId),svg=host?.querySelector("svg.koy-svg");
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
 function nearestPoint(event,maxDistance){
  const matrix=svg.getScreenCTM();
  if(!matrix)return null;
  let nearest=null,best=maxDistance;
  const point=svg.createSVGPoint();
  for(const target of targets){
   point.x=Number(target.getAttribute("cx"));
   point.y=Number(target.getAttribute("cy"));
   const screen=point.matrixTransform(matrix);
   const distance=Math.hypot(event.clientX-screen.x,event.clientY-screen.y);
   if(distance<best){best=distance;nearest=target}
  }
  return nearest;
 }
 function latestPointAtSameTime(hit){
  if(!hit||!currentTargets.length)return null;
  const hoveredX=Number(hit.getAttribute("cx"));
  let nearest=null,best=Infinity;
  for(const target of currentTargets){
   const distance=Math.abs(Number(target.getAttribute("cx"))-hoveredX);
   if(distance<best){best=distance;nearest=target}
  }
  return nearest;
 }
 function hide(){
  tooltip.hidden=true;
  pinned=false;
  if(activeGfsTooltip?.tooltip===tooltip)activeGfsTooltip=null;
 }
 function show(target,event,lock=false){
  if(!target)return;
  const run=target.dataset.run||"GFS döngüsü";
  const valid=target.dataset.valid||"—";
  const step=target.dataset.step||"";
  const value=target.dataset.value||"—";
  const unit=target.dataset.unit||"";
  const color=target.dataset.color||"#7dd3d7";
  tooltip.innerHTML='<div class="gfs-point-tooltip-head"><i style="background:'+color+'"></i><strong>Güncel GFS tahmini</strong></div><div class="gfs-point-tooltip-time">Döngü · '+esc(run)+'<br>Geçerlilik · '+esc(valid)+'</div><div class="gfs-point-tooltip-value">'+esc(value)+' <small>'+esc(unit)+'</small></div><div class="gfs-point-tooltip-meta">Tahmin adımı '+esc(step)+'</div>';
  tooltip.hidden=false;
  pinned=lock;
  const box=host.getBoundingClientRect();
  const tx=event.clientX-box.left;
  const ty=event.clientY-box.top;
  const tw=tooltip.offsetWidth,th=tooltip.offsetHeight;
  const left=Math.max(6,Math.min(host.clientWidth-tw-6,tx+14));
  let top=ty-th-13;
  if(top<6)top=ty+13;
  top=Math.max(6,Math.min(host.clientHeight-th-6,top));
  tooltip.style.left=left+"px";
  tooltip.style.top=top+"px";
  if(lock)activeGfsTooltip={host,tooltip,hide};
 }
 svg.addEventListener("pointermove",event=>{
  if(event.pointerType==="touch"||pinned)return;
  const hit=nearestPoint(event,28);
  const target=latestPointAtSameTime(hit);
  if(target)show(target,event,false);
  else hide();
 });
 svg.addEventListener("pointerleave",()=>{
  if(!pinned)hide();
 });
 svg.addEventListener("pointerdown",event=>{
  if(event.pointerType!=="touch"&&event.pointerType!=="pen")return;
  const hit=nearestPoint(event,44);
  const target=latestPointAtSameTime(hit);
  if(target){event.preventDefault();show(target,event,true)}
  else hide();
 });
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
function feelsLike(t,rh,wind){const T=Number(t),H=Number(rh),W=Number(wind);if(!Number.isFinite(T)||!Number.isFinite(H))return null;if(T>=20)return -8.784+1.611*T+2.338*H-0.146*T*H-0.0123*T*T-0.0164*H*H+0.00221*T*T*H+0.000725*T*H*H-0.00000358*T*T*H*H;if(T<=10&&Number.isFinite(W))return 13.12+0.6215*T-11.37*Math.pow(W,0.16)+0.3965*T*Math.pow(W,0.16);return T}
function dewpoint(t,rh){const T=Number(t),H=Number(rh);if(!Number.isFinite(T)||!Number.isFinite(H)||H<=0)return null;const a=17.62,b=243.12,g=Math.log(H/100)+a*T/(b+T);return b*g/(a-g)}
function renderMgmObservation(o,history,f72){
 if(!o)return;
 const t=num(o.temperature_2m_c),rh=num(o.humidity_percent),wind=num(o.wind_speed_10m_kmh),rain=num(o.precipitation_1h_mm),press=num(o.pressure_hpa);
 $("temperature").textContent=fmt(t)+"°";
 $("station-observation-meta").textContent="Son ölçüm · "+ts(o.observed_at_utc)+" · MGM Çanakçı";
 $("freshness").textContent="CANLI ÖLÇÜM";
 $("feels-like").innerHTML=fmt(feelsLike(t,rh,wind))+'<span class="unit">°</span>';
 $("wind").innerHTML=fmt(wind,1)+'<span class="unit">km/sa</span>';
 $("wind-direction").textContent=windDir(o.wind_direction_deg);
 $("humidity").innerHTML=fmt(rh,0)+'<span class="unit">%</span>';
 $("dewpoint-value").innerHTML=fmt(dewpoint(t,rh))+'<span class="unit">°</span>';
 $("rain").innerHTML=fmt(rain)+'<span class="unit">mm</span>';
 $("rain-detail").textContent="Son 1 saat";
 $("pressure").innerHTML=fmt(press,1)+'<span class="unit">hPa</span>';
 const samples=Array.isArray(history?.samples)?history.samples:[];
 const temps=samples.map(x=>num(x.temperature_2m_c)).filter(v=>v!=null);
 if(temps.length){const min=Math.min(...temps),max=Math.max(...temps),d=t!=null?t-temps[0]:null;const diff=t!=null?t-min:null;$("station-24h-diff").textContent="Son 24 saatte "+(diff>=0?fmt(diff)+"° daha sıcak":fmt(Math.abs(diff))+"° daha soğuk");}
 if(rain!=null&&rain>0)$("rain-brief-current").textContent="MGM Çanakçı ölçümüne göre şu anda yağış var ("+fmt(rain)+" mm/son 1 saat).";else $("rain-brief-current").textContent="MGM Çanakçı ölçümüne göre şu anda anlamlı yağış yok.";
 const pts=pointsOf(f72||{},72),future=pts.filter(p=>num(p.precipitation_6h_mm)>0.1);
 $("rain-brief-forecast").textContent=future.length?"MeteoPT GFS tahminine göre ilk anlamlı yağış: "+ts(future[0].valid_time_utc)+" TSİ.":"MeteoPT GFS tahmininde önümüzdeki 72 saatte anlamlı yağış görünmüyor.";
}
function meteoptTableBand(field,value){
 if(value==null)return "";
 const v=Number(value);
 if(!Number.isFinite(v))return "";
 if(field==="wind")return v<10?"mt-blue":v<20?"mt-green":v<30?"mt-yellow":v<45?"mt-orange":v<60?"mt-red":"mt-purple";
 if(field==="precip")return Number(v.toFixed(1))===0?"mt-gray":v<.1?"mt-blue":v<1?"mt-green":v<2.5?"mt-yellow":v<5?"mt-orange":v<10?"mt-red":"mt-purple";
 if(field==="t2m")return v<0?"mt-blue":v<8?"mt-green":v<16?"mt-yellow":v<24?"mt-orange":v<32?"mt-red":"mt-purple";
 if(field==="t850")return v< -10?"mt-blue":v< -2?"mt-green":v<6?"mt-yellow":v<14?"mt-orange":v<22?"mt-red":"mt-purple";
 return "";
}
function meteoptTableValue(value,field,digits=1){
 if(value==null)return '<span class="meteopt-value">—</span>';
 const band=meteoptTableBand(field,value);
 return '<span class="meteopt-value '+band+'">'+fmt(value,digits)+'</span>';
}
function renderF72(d){
 const pts=pointsOf(d,72);
 const body=$("meteopt-table-body");
 body.innerHTML=pts.length?pts.map(p=>'<tr><td>F'+p.forecast_hour+'</td><td>'+ts(p.valid_time_utc)+'</td><td>'+meteoptTableValue(num(p.wind_speed_10m_kmh),"wind",0)+'</td><td>'+meteoptTableValue(num(p.wind_speed_850hpa_kmh),"wind",0)+'</td><td>'+meteoptTableValue(num(p.precipitation_6h_mm),"precip")+'</td><td>'+meteoptTableValue(num(p.temperature_2m_c),"t2m")+'</td><td>'+meteoptTableValue(num(p.temperature_850hpa_c),"t850")+'</td></tr>').join(""):'<tr><td colspan="7" class="meteopt-table-empty">F72 adımları henüz yok.</td></tr>';
 $("meteopt-table-status").textContent=pts.length+" / 24 adım";
 $("meteopt-table-run").textContent="Model döngüsü: "+ts(d.run_id_utc);
 $("meteopt-table-updated").textContent="Yayın: "+ts(d.published_at_utc);
 const first=pts[0];
 if(first) $("report-summary").textContent="MGM Çanakçı gerçek istasyon ölçümü ile MeteoPT GFS model tahmini ayrı kaynaklardır. İlk GFS tahmin adımı: "+ts(first.valid_time_utc)+" · "+fmt(num(first.temperature_2m_c))+" °C · yağış "+fmt(num(first.precipitation_6h_mm))+" mm / 6 saat.";
}
function svgStationHistory(samples,metric,title,unit){
 const now=Date.now(),from=now-24*3600000;
 const hourly=metric==="precipitation_1h_mm";
 const step=hourly?3600000:1800000;
 const bins=[];
 for(let t=from;t<now;t+=step)bins.push({start:t,values:[]});
 (Array.isArray(samples)?samples:[]).forEach(s=>{
   const t=Date.parse(s.observed_at_utc||s.logged_at_utc||""),v=num(s[metric]);
   if(!Number.isFinite(t)||t<from||t>now||v==null)return;
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
 const x=t=>L+(t-from)/86400000*PW,y=v=>T+(hi-v)*PH/(hi-lo),xb=p=>x(p.start+900000);
 let s='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="'+esc(title)+'">';
 for(let j=0;j<=4;j++){const v=lo+(hi-lo)*j/4,yy=y(v);s+='<line x1="'+L+'" y1="'+yy+'" x2="'+(W-R)+'" y2="'+yy+'" stroke="rgba(190,218,228,.17)" stroke-dasharray="3 5"/><text x="'+(L-9)+'" y="'+(yy+3.5)+'" fill="#a8bfca" font-size="10" text-anchor="end">'+fmt(v,metric==="temperature_2m_c"?1:1)+'</text>'}
 bins.forEach((b,i)=>{if(i%4&&i!==bins.length-1)return;s+='<text x="'+x(b.start)+'" y="'+(H-8)+'" fill="#a8bfca" font-size="10" text-anchor="middle">'+new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit"}).format(new Date(b.start))+'</text>'});
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
 const host=$(containerId),svg=host?.querySelector("svg");
 if(!host||!svg)return;
 const targets=[...svg.querySelectorAll(".station-point-target")];
 if(!targets.length)return;
 const tooltip=document.createElement("div");
 tooltip.className="station-history-tooltip";
 tooltip.hidden=true;
 tooltip.setAttribute("role","status");
 tooltip.setAttribute("aria-live","polite");
 host.appendChild(tooltip);
 let pinned=false;
 function nearestByTime(event,maxDistance){
  const matrix=svg.getScreenCTM();
  if(!matrix)return null;
  let nearest=null,best=maxDistance;
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
  tooltip.hidden=true;
  pinned=false;
  if(activeStationTooltip?.tooltip===tooltip)activeStationTooltip=null;
 }
 function show(target,event,lock=false){
  if(!target)return;
  tooltip.innerHTML='<div class="station-history-tooltip-time">MGM Çanakçı · Gerçek ölçüm<br>'+esc(target.dataset.period||"—")+'</div><div class="station-history-tooltip-value">'+esc(target.dataset.value||"—")+' <small>'+esc(target.dataset.unit||"")+'</small></div><div class="station-history-tooltip-detail">'+esc(target.dataset.detail||"")+'</div>';
  tooltip.hidden=false;
  pinned=lock;
  const box=host.getBoundingClientRect();
  const tx=event.clientX-box.left,ty=event.clientY-box.top;
  const tw=tooltip.offsetWidth,th=tooltip.offsetHeight;
  const left=Math.max(5,Math.min(host.clientWidth-tw-5,tx+12));
  let top=ty-th-12;
  if(top<5)top=ty+14;
  top=Math.max(5,Math.min(host.clientHeight-th-5,top));
  tooltip.style.left=left+"px";
  tooltip.style.top=top+"px";
  if(lock)activeStationTooltip={host,tooltip,hide};
 }
 svg.addEventListener("pointermove",event=>{
  if(event.pointerType==="touch"||pinned)return;
  const target=nearestByTime(event,48);
  if(target)show(target,event,false);
  else hide();
 });
 svg.addEventListener("pointerleave",()=>{if(!pinned)hide()});
 svg.addEventListener("pointerdown",event=>{
  if(event.pointerType!=="touch"&&event.pointerType!=="pen")return;
  const target=nearestByTime(event,54);
  if(target){event.preventDefault();show(target,event,true)}
  else hide();
 });
}
function renderStationHistory(doc){
 const samples=Array.isArray(doc?.samples)?doc.samples:[];
 $("station-trend-meta").textContent="Çanakçı · MGM · "+samples.length+" kayıt · 30 dk ortalama / min–maks";
 $("station-rain-meta").textContent="Çanakçı · MGM · saatlik gösterim · kayan 1 saatlik toplam";
 $("history-source-note").textContent="Sıcaklık ve yağış: MGM Çanakçı gerçek istasyon ölçümleri.";
 $("station-temperature-trend").innerHTML=svgStationHistory(samples,"temperature_2m_c","Çanakçı sıcaklık","°C");
 $("station-rain-trend").innerHTML=svgStationHistory(samples,"precipitation_1h_mm","Çanakçı yağış","mm");
 bindStationHistoryTooltip("station-temperature-trend");
 bindStationHistoryTooltip("station-rain-trend");
}
function gfsRunLabel(run){
 const date=new Date(run?.run_id_utc||"");
 if(!Number.isFinite(date.getTime()))return "GFS döngüsü";
 const day=new Intl.DateTimeFormat("tr-TR",{timeZone:"UTC",day:"2-digit",month:"short"}).format(date).replace(/\./g,"");
 return day+" · "+String(date.getUTCHours()).padStart(2,"0")+"Z";
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
function renderRuns(d,f72){
 const runs=(d?.runs||[]).slice(0,4);
 $("report-meta").textContent=runs.length?"Son döngü: "+ts(runs[0].run_id_utc)+" · "+runs.length+" çıktı hazır":"Son model döngüsü bekleniyor";
 const pngMetrics=[
  ["chart-temp","temperature","2 m sıcaklık · son 4 GFS döngüsü"],
  ["chart-t850","temperature_850","850 hPa sıcaklık · son 4 GFS döngüsü"],
  ["chart-rain","precipitation","6 saatlik yağış · son 4 GFS döngüsü"],
  ["chart-wind","wind_10m","10 m rüzgâr · son 4 GFS döngüsü"]
 ];
 const runStamp=runs[0]?.run_id_utc?(()=>{const d=new Date(runs[0].run_id_utc);return d.getUTCFullYear()+String(d.getUTCMonth()+1).padStart(2,"0")+String(d.getUTCDate()).padStart(2,"0")+"T"+String(d.getUTCHours()).padStart(2,"0")+"Z";})():null;
 pngMetrics.forEach(([id,metric,alt])=>{
  const holder=$(id);
  if(!holder)return;
  if(!runStamp){holder.innerHTML='<div class="chart-empty">PNG raporu bekleniyor…</div>';return;}
  const src=`./koy-data/gfs/media/koy-gfs-${runStamp}-${metric}.png?v=${encodeURIComponent(runs[0].run_id_utc||"")}`;
  holder.innerHTML='<a class="notification-image-link" href="'+src+'" target="_blank" rel="noopener"><img class="notification-image" src="'+src+'" alt="'+esc(alt)+'"></a>';
 });
 const source=runs.length?runs:(f72?[f72]:[]);
 renderRunLegend(source);
 $("next-72h-meta").textContent=source.length?source.length+" GFS döngüsü karşılaştırılıyor":"Model verisi bekleniyor";
 $("next72-temperature").innerHTML=svgLine(source,"temperature_2m_c","2 m sıcaklık","°C",72);
 $("next72-precipitation").innerHTML=svgLine(source,"precipitation_6h_mm","6 saatlik yağış","mm / 6 saat",72);
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
   $("brief-temperature-trend").textContent=[...daily.entries()].slice(0,5).map(([k,v])=>dayLabel(k)+": "+fmt(Math.min(...v))+"–"+fmt(Math.max(...v))+"°C").join(" · ");
   const rainy=p.filter(x=>num(x.precipitation_6h_mm)>0.1);
   $("brief-rain-lines").textContent=rainy.length?rainy.slice(0,6).map(x=>ts(x.valid_time_utc)+" · "+fmt(num(x.precipitation_6h_mm))+" mm / 6 saat").join("  |  "):"Modelde anlamlı yağış görünmüyor.";
   const dailyItems=[...daily.entries()].slice(0,8).map(([k,v])=>({date_istanbul:k,temperature_min_c:Math.min(...v),temperature_max_c:Math.max(...v),precipitation_total_mm:p.filter(x=>dayKey(x.valid_time_utc)===k).reduce((a,x)=>a+(num(x.precipitation_6h_mm)||0),0),wind_speed_max_10m_kmh:Math.max(...p.filter(x=>dayKey(x.valid_time_utc)===k).map(x=>num(x.wind_speed_10m_kmh)||0))}));
   $("daily-grid").innerHTML=dailyItems.map(item=>'<article class="day"><div class="day-name">'+dayLabel(item.date_istanbul)+'</div><div class="day-icon">'+(item.precipitation_total_mm>=5?"🌧️":item.precipitation_total_mm>=1?"🌦️":"⛅")+'</div><div class="day-range">'+fmt(item.temperature_max_c,0)+'° <span>'+fmt(item.temperature_min_c,0)+'°</span></div><div class="day-rain">☂ '+fmt(item.precipitation_total_mm,1)+' mm</div><div class="day-wind">↗ '+fmt(item.wind_speed_max_10m_kmh,0)+' km/sa</div></article>').join("");
 }
}
async function refresh(){if(busy)return;busy=true;
 const results=await Promise.allSettled([get("f72/latest.json"),get("comparison.json"),get(MGM_BASE+"history.json"),get(MGM_BASE+"observation.json")]);
 if(results[0].status==="fulfilled"){f72=results[0].value;renderF72(f72)}else{}
 if(results[1].status==="fulfilled")comparison=results[1].value;else comparison=null;
 if(results[2].status==="fulfilled"){stationHistory=results[2].value;renderStationHistory(stationHistory)}else{stationHistory=null;$("station-temperature-trend").innerHTML="<div class=\"station-trend-empty\">MGM istasyon geçmişi bekleniyor…</div>";$("station-rain-trend").innerHTML="<div class=\"station-trend-empty\">MGM istasyon geçmişi bekleniyor…</div>"}
 if(results[3].status==="fulfilled"){renderMgmObservation(results[3].value,stationHistory,f72); const o=results[3].value; $("mgm-status-date").textContent=ts(o.observed_at_utc); $("mgm-source-temp").innerHTML=fmt(o.temperature_2m_c)+"<small>°C</small>"; $("mgm-source-status").textContent="Canlı MGM ölçümü · son 1 saat yağış "+fmt(o.precipitation_1h_mm)+" mm"; $("mgm-source-fill").style.width=Math.min(100,Math.max(0,(num(o.precipitation_1h_mm)||0)*8))+"%"} renderRuns(comparison,f72);
 busy=false;
}
refresh();setInterval(()=>{if(document.visibilityState!=="hidden")refresh()},60000);
})();