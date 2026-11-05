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
async function get(path){const url=path.startsWith("./")?path:BASE+path;const r=await fetch(url+"?v="+Date.now(),{cache:"no-store"});if(!r.ok)throw Error("HTTP "+r.status+" · "+url);return r.json()}
function pointsOf(run,max=180){return (run?.forecast_6_hourly||[]).filter(p=>Number(p.forecast_hour)>0&&Number(p.forecast_hour)<=max).sort((a,b)=>Number(a.forecast_hour)-Number(b.forecast_hour))}
function svgLine(runs,metric,title,unit,maxHour=72){
 const usable=runs.map(r=>({run:r,points:pointsOf(r,maxHour).map(p=>({h:Number(p.forecast_hour),v:num(p[metric])})).filter(p=>p.v!=null)})).filter(x=>x.points.length);
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
 usable.forEach((item,i)=>{const path=item.points.map((p,j)=>(j?"L":"M")+x(p.h)+" "+y(p.v)).join(" ");s+='<path d="'+path+'" fill="none" stroke="'+COLORS[i]+'" stroke-width="'+(i===0?3:1.8)+'" '+(i===0?'':'stroke-dasharray="5 4"')+' stroke-linecap="round" stroke-linejoin="round"/>';if(i===0)item.points.forEach(p=>{s+='<circle cx="'+x(p.h)+'" cy="'+y(p.v)+'" r="2.5" fill="'+COLORS[i]+'"><title>F'+p.h+' · '+fmt(p.v)+' '+unit+'</title></circle>'})});
 s+='</svg>';return s;
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
function renderF72(d){
 const pts=pointsOf(d,72);$("rows").innerHTML=pts.length?pts.map(p=>'<tr><td>F'+p.forecast_hour+'</td><td>'+ts(p.valid_time_utc)+'</td><td>'+fmt(num(p.wind_speed_10m_kmh),0)+'</td><td>'+fmt(num(p.wind_speed_850hpa_kmh),0)+'</td><td>'+fmt(num(p.precipitation_6h_mm))+'</td><td>'+fmt(num(p.temperature_2m_c))+'</td><td>'+fmt(num(p.temperature_850hpa_c))+'</td></tr>').join(""):'<tr><td colspan="7" class="meteopt-table-empty">F72 adımları henüz yok.</td></tr>';
 $("f72-chip").textContent="GFS · hazır";$("table-status").textContent=pts.length+" / 24 adım";$("table-run").textContent="Run: "+ts(d.run_id_utc);$("table-updated").textContent="Yayın: "+ts(d.published_at_utc);
 if(pts.length){const p=pts[0];$("current-temp").textContent=fmt(num(p.temperature_2m_c))+"°";$("current-step").textContent="F"+p.forecast_hour;$("current-valid").textContent=ts(p.valid_time_utc).replace(" TSİ","");$("current-t850").innerHTML=fmt(num(p.temperature_850hpa_c))+'<span class="unit">°C</span>';$("current-wind").innerHTML=fmt(num(p.wind_speed_10m_kmh),0)+'<span class="unit">km/sa</span>';$("current-wind850").innerHTML=fmt(num(p.wind_speed_850hpa_kmh),0)+'<span class="unit">km/sa</span>';$("current-rain").innerHTML=fmt(num(p.precipitation_6h_mm))+'<span class="unit">mm</span>';$("current-meta").textContent="İlk tahmin adımı · "+ts(p.valid_time_utc)+" · model tahmini, canlı ölçüm değil"}
 const rainy=pts.filter(p=>num(p.precipitation_6h_mm)>0.1);$("rain-times").textContent=rainy.length?rainy.slice(0,6).map(p=>ts(p.valid_time_utc)+" · "+fmt(num(p.precipitation_6h_mm))+" mm / 6 saat").join("  |  "):"İlk 72 saatlik model adımlarında anlamlı yağış görünmüyor.";
}
function svgStationHistory(samples,metric,title,unit){
 const now=Date.now(),from=now-24*3600000,bins=[];
 for(let t=from;t<now;t+=1800000)bins.push({start:t,values:[]});
 (Array.isArray(samples)?samples:[]).forEach(s=>{
   const t=Date.parse(s.observed_at_utc||s.logged_at_utc||""),v=num(s[metric]);
   if(!Number.isFinite(t)||t<from||t>now||v==null)return;
   const i=Math.floor((t-from)/1800000);if(i>=0&&i<bins.length)bins[i].values.push(v);
 });
 const data=bins.map((b,i)=>({index:i,start:b.start,count:b.values.length,min:b.values.length?Math.min(...b.values):null,max:b.values.length?Math.max(...b.values):null,mean:b.values.length?b.values.reduce((a,v)=>a+v,0)/b.values.length:null})).filter(x=>x.count);
 const holder=metric==="temperature_2m_c"?"station-temperature-trend":"station-rain-trend";
 if(data.length<2)return '<div class="station-trend-empty">Son 24 saatte yeterli MGM istasyon verisi yok.</div>';
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
 s+='</svg>';return s;
}
function renderStationHistory(doc){
 const samples=Array.isArray(doc?.samples)?doc.samples:[];
 $("history24-meta").textContent=samples.length+" MGM istasyon kaydı · son 24 saat";
 $("history24-temperature").innerHTML=svgStationHistory(samples,"temperature_2m_c","Çanakçı son 24 saat sıcaklık geçmişi","°C");
 $("history24-precipitation").innerHTML=svgStationHistory(samples,"precipitation_1h_mm","Çanakçı son 24 saat yağış birikimi","mm");
 $("station-trend-meta").textContent="Çanakçı · MGM · "+samples.length+" kayıt · 30 dk ortalama / min–maks";
 $("station-rain-meta").textContent="Çanakçı · MGM · son ölçüm · kayan 1 saatlik toplam";
 $("history-source-note").textContent="Sıcaklık ve yağış: MGM Çanakçı gerçek istasyon ölçümleri.";
}
function renderRuns(d,f72){
 const runs=(d?.runs||[]).slice(0,4);$("history24-meta").textContent=runs.length+" GFS döngüsünden geçmiş veriler";$("history24-temperature").innerHTML=svgHistory24(runs,"temperature_2m_c","Son 24 saat sıcaklık","°C");$("history24-precipitation").innerHTML=svgHistory24(runs,"precipitation_6h_mm","Son 24 saat yağış","mm");$("report-meta").textContent=runs.length?"Son döngü: "+ts(runs[0].run_id_utc)+" · "+runs.length+" çıktı hazır":"Son model döngüsü bekleniyor";
 $("run-list").textContent=runs.length?runs.map((r,i)=>(i+1)+". "+ts(r.run_id_utc)+" · "+pointsOf(r).length+" adım").join("   |   "):"Son dört döngü verisi bekleniyor…";
 $("chart-legend").innerHTML=runs.map((r,i)=>'<span><i style="background:'+COLORS[i]+'"></i>'+esc(ts(r.run_id_utc))+'</span>').join("");
 $("chart-temp").innerHTML=svgDaily(runs,"temperature_2m_c","2 m sıcaklık","°C","candle");
 $("chart-t850").innerHTML=svgDaily(runs,"temperature_850hpa_c","850 hPa sıcaklık","°C","range");
 $("chart-rain").innerHTML=svgLine(runs,"precipitation_6h_mm","6 saatlik yağış","mm",180);
 $("chart-wind").innerHTML=svgDaily(runs,"wind_speed_10m_kmh","10 m rüzgâr","km/sa","range");
 const source=runs.length?runs:f72?[f72]:[];
 $("next72-meta").textContent=source.length?source.length+" GFS döngüsü karşılaştırılıyor":"Model verisi bekleniyor";
 $("next72-temperature").innerHTML=svgLine(source,"temperature_2m_c","2 m sıcaklık","°C",72);
 $("next72-precipitation").innerHTML=svgLine(source,"precipitation_6h_mm","6 saatlik yağış","mm",72);
 if(source.length){const p=pointsOf(source[0],180),daily=new Map();p.forEach(x=>{const k=dayKey(x.valid_time_utc);if(!daily.has(k))daily.set(k,[]);if(num(x.temperature_2m_c)!=null)daily.get(k).push(num(x.temperature_2m_c))});const days=[...daily.entries()].slice(0,5);$("five-day-summary").textContent=days.map(([k,v])=>dayLabel(k)+": "+fmt(Math.min(...v))+"–"+fmt(Math.max(...v))+"°C").join(" · ")}
}
let f72=null,comparison=null,stationHistory=null,busy=false;
async function refresh(){if(busy)return;busy=true;const button=$("refresh");button.disabled=true;button.textContent="Yükleniyor…";
 const results=await Promise.allSettled([get("f72/latest.json"),get("comparison.json"),get(MGM_BASE+"history.json")]);
 if(results[0].status==="fulfilled"){f72=results[0].value;renderF72(f72)}else{$("f72-chip").textContent="Veri bekleniyor";$("table-status").textContent="F72 bekleniyor"}
 if(results[1].status==="fulfilled")comparison=results[1].value;else comparison=null;\n if(results[2].status==="fulfilled"){stationHistory=results[2].value;renderStationHistory(stationHistory)}else{stationHistory=null;$("history24-temperature").innerHTML="<div class=\"station-trend-empty\">MGM istasyon geçmişi bekleniyor…</div>";$("history24-precipitation").innerHTML="<div class=\"station-trend-empty\">MGM istasyon geçmişi bekleniyor…</div>"}
 renderRuns(comparison,f72);$("updated").textContent="Son kontrol: "+ts(new Date().toISOString());
 button.disabled=false;button.textContent="Verileri yenile";busy=false;
}
$("refresh").addEventListener("click",refresh);refresh();setInterval(()=>{if(document.visibilityState!=="hidden")refresh()},60000);
})();