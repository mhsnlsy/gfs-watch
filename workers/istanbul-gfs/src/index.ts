/**
 * İstanbul'un Havası — Cloudflare GFS publisher
 *
 * Source: MeteoPT GFS point forecast (41.014, 28.950).
 * Polls every 5 minutes, but publishes only when the newest cycle contains F180.
 * Cloudflare owns collection, history, report generation and Telegram delivery.
 */
const TZ_OFFSET_MS = 3 * 60 * 60 * 1000;
const LAT = 41.014;
const LON = 28.950;
const METEOPT = "https://api.meteopt.com/gfs/json";

export interface Env {
  GFS_KV: KVNamespace;
  TELEGRAM_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ALLOWED_ORIGIN?: string;
}

type Point = {
  forecast_hour:number; valid_time_utc:string; valid_time_istanbul:string;
  temperature_2m_c:number|null; temperature_850hpa_c:number|null;
  wind_speed_10m_kmh:number|null; wind_direction_10m_deg:number|null;
  wind_speed_850hpa_kmh:number|null; precipitation_6h_mm:number|null;
};

const json = (v:any, status=200, origin="*") =>
  new Response(JSON.stringify(v,null,2), {
    status, headers: {"content-type":"application/json; charset=utf-8","cache-control":"no-store","access-control-allow-origin":origin}
  });

function runKey(v:string){const d=v.replace(/[^0-9]/g,"");return d.length>=10?d.slice(0,10):d;}
function utcDate(v:string){return new Date(v);}
function localIso(d:Date){return new Date(d.getTime()+TZ_OFFSET_MS).toISOString().slice(0,16);}
function num(a:any,i:number){const n=Number(a?.[i]);return Number.isFinite(n)?n:null;}

async function fetchRun(hour:number){
  const u=new URL(METEOPT);
  u.searchParams.set("lat",String(LAT)); u.searchParams.set("lon",String(LON));
  u.searchParams.set("run",String(hour).padStart(2,"0")); u.searchParams.set("lang","en");
  // Cache-bust the upstream request so a new GFS cycle cannot be hidden by an intermediary cache.
  u.searchParams.set("_",String(Date.now()));
  const r=await fetch(u,{cache:"no-store",headers:{"user-agent":"Istanbul-GFS-Cloudflare/1.0","cache-control":"no-cache"}});
  if(!r.ok) throw new Error("MeteoPT HTTP "+r.status);
  const doc:any=await r.json();
  return {doc,url:u.toString()};
}

function normalize(doc:any){
  const apiRun=String(doc.run||"").trim(), parsed=runKey(apiRun);
  if(parsed.length!==10) throw new Error("MeteoPT run is invalid: "+apiRun);
  const cycle=new Date(Date.UTC(Number(parsed.slice(0,4)),Number(parsed.slice(4,6))-1,Number(parsed.slice(6,8)),Number(parsed.slice(8,10))));
  const steps=(doc.steps?.values||[]).map((x:any)=>Number(x)).filter((x:number)=>Number.isFinite(x));
  const data=doc.data||{};
  const vals=(name:string)=>data?.[name]?.values||[];
  const points:Point[]=[];
  for(let i=0;i<steps.length;i++){
    const lead=steps[i]; if(lead<=0) continue;
    const valid=new Date(cycle.getTime()+lead*3600000);
    points.push({
      forecast_hour:lead, valid_time_utc:valid.toISOString().slice(0,16)+"Z", valid_time_istanbul:localIso(valid),
      temperature_2m_c:num(vals("tmp2m"),i), temperature_850hpa_c:num(vals("tmp850mb"),i),
      wind_speed_10m_kmh:num(vals("wind10m"),i), wind_direction_10m_deg:num(vals("winddir10m"),i),
      wind_speed_850hpa_kmh:num(vals("wind850"),i), precipitation_6h_mm:num(vals("apcp"),i)
    });
  }
  const days:Record<string,Point[]>={};
  for(const p of points)(days[p.valid_time_istanbul.slice(0,10)]??=[]).push(p);
  const daily=Object.entries(days).sort().map(([date,ps])=>{
    const arr=(k:keyof Point)=>ps.map(p=>Number(p[k])).filter(Number.isFinite);
    const t=arr("temperature_2m_c"), t8=arr("temperature_850hpa_c"), r=arr("precipitation_6h_mm"), w=arr("wind_speed_10m_kmh"), w8=arr("wind_speed_850hpa_kmh");
    return {date_istanbul:date,temperature_min_c:t.length?Math.min(...t):null,temperature_max_c:t.length?Math.max(...t):null,
      temperature_850hpa_min_c:t8.length?Math.min(...t8):null,temperature_850hpa_max_c:t8.length?Math.max(...t8):null,
      precipitation_total_mm:r.reduce((s,x)=>s+Math.max(0,x),0),wind_speed_max_10m_kmh:w.length?Math.max(...w):null,wind_speed_max_850hpa_kmh:w8.length?Math.max(...w8):null};
  });
  const latest=points[0]||{};
  return {model:"ncep_gfs_global",forecast_source:"meteopt",run_id_utc:cycle.toISOString(),
    location:{name:"Istanbul",latitude:LAT,longitude:LON,nearest_gfs_grid_latitude:41,nearest_gfs_grid_longitude:29},
    sources:{forecast:"MeteoPT GFS 3-hour point forecast (Istanbul, TR)"},
    noaa_source_file:{f180_available:steps.includes(180),f180_source_name:"MeteoPT",f180_source_url:METEOPT},
    current_conditions:{temperature_2m_c:latest.temperature_2m_c,precipitation_mm:latest.precipitation_6h_mm,wind_speed_10m_kmh:latest.wind_speed_10m_kmh,mean_sea_level_pressure_hpa:null},
    daily_summary:daily,forecast_6_hourly:points,forecast_horizon_hours:Math.max(0,...steps),
    published_at_utc:new Date().toISOString(),forecast_valid_until_utc:points.at(-1)?.valid_time_utc||null,schema:"gfs-watch.forecast.v1"};
}

function report(doc:any, previous:any[]){
  const r=doc.run_id_utc, d=new Date(r), run=String(d.getUTCHours()).padStart(2,"0")+"Z";
  const c=doc.current_conditions||{}, h=doc.forecast_horizon_hours||0;
  const temp=c.temperature_2m_c==null?"—":c.temperature_2m_c.toFixed(1)+"°C";
  const wind=c.wind_speed_10m_kmh==null?"—":c.wind_speed_10m_kmh.toFixed(0)+" km/sa";
  const rain=c.precipitation_mm==null?"—":c.precipitation_mm.toFixed(1)+" mm";
  const local=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}).format(d);
  return `🌦️ İSTANBUL'UN HAVASI · GFS

Yeni GFS ${run} çıktı: F180 tamamlandı.
Yayın: ${local} TSİ
Kaynak: MeteoPT · 41.014N, 28.950E
Tahmin ufku: F${h}

Aktüel model başlangıcı
🌡️ ${temp}
💨 ${wind}
🌧️ ${rain}

Son 4 GFS döngüsü karşılaştırması hazır.
Bu paket Cloudflare tarafından tek canonical veri kaynağından üretildi.`;
}

function crc32(bytes:Uint8Array){
  let c=0xffffffff; for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}
  return (c^0xffffffff)>>>0;
}
function u32(n:number){return new Uint8Array([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]);}
function chunk(type:string,data:Uint8Array){
  const t=new TextEncoder().encode(type), all=new Uint8Array(t.length+data.length);all.set(t);all.set(data,t.length);
  const out=new Uint8Array(12+data.length);out.set(u32(data.length),0);out.set(all,4);out.set(u32(crc32(all)),8+data.length);return out;
}
function zlibStore(data:Uint8Array){
  const parts:Uint8Array[]=[new Uint8Array([0x78,0x01])]; let off=0;
  while(off<data.length){const n=Math.min(65535,data.length-off),last=off+n===data.length;const b=new Uint8Array(5+n);b[0]=last?1:0;b[1]=n&255;b[2]=(n>>>8)&255;const nn=(~n)&65535;b[3]=nn&255;b[4]=(nn>>>8)&255;b.set(data.slice(off,off+n),5);parts.push(b);off+=n;}
  let s=1,a=1;for(const x of data){a=(a+x)%65521;s=(s+a)%65521;}parts.push(new Uint8Array([(s>>>8)&255,s&255,(a>>>8)&255,a&255]));
  const total=parts.reduce((n,x)=>n+x.length,0),out=new Uint8Array(total);let p=0;for(const x of parts){out.set(x,p);p+=x.length;}return out;
}
function png(w:number,h:number,pix:Uint8Array){
  const raw=new Uint8Array(h*(w*4+1));for(let y=0;y<h;y++){raw[y*(w*4+1)]=0;raw.set(pix.slice(y*w*4,(y+1)*w*4),y*(w*4+1)+1);}
  const head=new Uint8Array(13);new DataView(head.buffer).setUint32(0,w);new DataView(head.buffer).setUint32(4,h);head[8]=8;head[9]=6;
  const chunks=[new Uint8Array([137,80,78,71,13,10,26,10]),chunk("IHDR",head),chunk("IDAT",zlibStore(raw)),chunk("IEND",new Uint8Array())];
  const n=chunks.reduce((s,x)=>s+x.length,0),out=new Uint8Array(n);let p=0;for(const x of chunks){out.set(x,p);p+=x.length;}return out;
}
function chart(points:Point[],key:keyof Point,color:[number,number,number]){
  const W=1000,H=560, pix=new Uint8Array(W*H*4);pix.fill(245);
  const set=(x:number,y:number,c:[number,number,number,number])=>{x=Math.round(x);y=Math.round(y);if(x<0||x>=W||y<0||y>=H)return;const i=(y*W+x)*4;pix[i]=c[0];pix[i+1]=c[1];pix[i+2]=c[2];pix[i+3]=c[3];};
  const line=(x0:number,y0:number,x1:number,y1:number,c:[number,number,number,number],width=2)=>{let dx=Math.abs(x1-x0),sx=x0<x1?1:-1,dy=-Math.abs(y1-y0),sy=y0<y1?1:-1,e=dx+dy;for(;;){for(let a=-width;a<=width;a++)for(let b=-width;b<=width;b++)if(a*a+b*b<=width*width)set(x0+a,y0+b,c);if(x0===x1&&y0===y1)break;const e2=2*e;if(e2>=dy){e+=dy;x0+=sx}if(e2<=dx){e+=dx;y0+=sy}}};
  const vals=points.map(p=>Number(p[key])).filter(Number.isFinite);if(!vals.length)return png(W,H,pix);
  const lo=Math.min(...vals),hi=Math.max(...vals)+(Math.max(...vals)===Math.min(...vals)?1:0.0001), x0=70,x1=960,y0=60,y1=500;
  for(let i=0;i<=5;i++){const y=y0+(y1-y0)*i/5;line(x0,y,x1,y,[220,228,232,255],1);}
  for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],av=Number(a[key]),bv=Number(b[key]);if(!Number.isFinite(av)||!Number.isFinite(bv))continue;
    const xa=x0+(i-1)*((x1-x0)/Math.max(1,points.length-1)),xb=x0+i*((x1-x0)/Math.max(1,points.length-1));
    const ya=y1-(av-lo)*(y1-y0)/(hi-lo),yb=y1-(bv-lo)*(y1-y0)/(hi-lo);line(xa,ya,xb,yb,[...color,255],4);}
  return png(W,H,pix);
}

async function storeRun(env:Env,doc:any){
  const key="run:"+runKey(doc.run_id_utc);
  await env.GFS_KV.put(key,JSON.stringify(doc));
  return key;
}
async function lastRuns(env:Env){
  const keys=await env.GFS_KV.list({prefix:"run:"});
  const ids=keys.keys.map(k=>k.name.slice(4)).sort().reverse().slice(0,4);
  const docs:any[]=[];for(const id of ids){const v=await env.GFS_KV.get("run:"+id,"json");if(v)docs.push(v);}
  return docs.sort((a,b)=>Date.parse(b.run_id_utc)-Date.parse(a.run_id_utc));
}
async function tg(env:Env,method:string,body:BodyInit){
  const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`,{method:"POST",body});
  if(!r.ok)throw new Error("Telegram HTTP "+r.status+" "+await r.text());
}
async function notify(env:Env,text:string,images:Uint8Array[]){
  const media:any[] = images.map((_,i)=>({
    type:"photo",
    media:`attach://gfs-${i}`,
    caption:["🌡️ Sıcaklık","🌡️ 850 hPa sıcaklık","🌧️ Yağış","💨 10 m rüzgâr"][i]
  }));
  const fd=new FormData();
  fd.set("chat_id",env.TELEGRAM_CHAT_ID);
  fd.set("media",JSON.stringify(media));
  for(let i=0;i<images.length;i++) fd.append("gfs-"+i,new File([images[i]],`istanbul-gfs-${i+1}.png`,{type:"image/png"}));
  await tg(env,"sendMediaGroup",fd);
}
async function publish(env:Env,doc:any,runs:any[]){
  const images=[
    chart(doc.forecast_6_hourly,"temperature_2m_c",[32,150,180]),
    chart(doc.forecast_6_hourly,"temperature_850hpa_c",[90,120,180]),
    chart(doc.forecast_6_hourly,"precipitation_6h_mm",[50,130,190]),
    chart(doc.forecast_6_hourly,"wind_speed_10m_kmh",[170,100,70])
  ];
  const comparison={schema:"istanbul-gfs.comparison.v1",location:{name:"Istanbul",latitude:LAT,longitude:LON},updated_at_utc:doc.published_at_utc,runs};
  const text=report(doc,runs.slice(1));
  await env.GFS_KV.put("latest",JSON.stringify({...doc,comparison_runs:runs}));
  await env.GFS_KV.put("comparison",JSON.stringify(comparison));
  await env.GFS_KV.put("report",text);
  for(let i=0;i<images.length;i++)await env.GFS_KV.put("image:"+i,images[i]);
  await notify(env,text,images);
  await env.GFS_KV.put("published:"+runKey(doc.run_id_utc),JSON.stringify({run_id_utc:doc.run_id_utc,published_at_utc:new Date().toISOString()}));
}
async function process(env:Env){
  const startedAt=new Date().toISOString();
  const checks:any[]=[];
  await env.GFS_KV.put("gfs:last-check",JSON.stringify({
    checked_at_utc:startedAt,
    status:"running"
  }));

  // Check every cycle independently. A failure in one cycle must not abort the others.
  for(const h of [18,12,6,0]){
    try{
      const x=await fetchRun(h);
      const returnedRun=String(x.doc.run||"").trim();
      const id=runKey(returnedRun);

      if(!id){
        checks.push({requested_cycle_utc:h,status:"invalid_run",returned_run:returnedRun});
        continue;
      }

      const doc=normalize(x.doc);
      const returnedHour=new Date(doc.run_id_utc).getUTCHours();
      const ready180=doc.noaa_source_file.f180_available;

      // The API can temporarily serve the newest run even when an older cycle was requested.
      // Never mistake that response for the requested cycle.
      if(returnedHour!==h){
        console.log("MeteoPT returned a different cycle",{
          requested_cycle_utc:h,
          returned_run_id_utc:doc.run_id_utc
        });
        checks.push({
          requested_cycle_utc:h,
          returned_run_id_utc:doc.run_id_utc,
          f180_available:ready180,
          forecast_horizon_hours:doc.forecast_horizon_hours,
          status:"different_cycle"
        });
        continue;
      }

      console.log("MeteoPT run check",doc.run_id_utc,"F180",ready180);
      checks.push({
        requested_cycle_utc:h,
        run_id_utc:doc.run_id_utc,
        f180_available:ready180,
        forecast_horizon_hours:doc.forecast_horizon_hours,
        status:"checked"
      });
    }catch(e){
      console.error("MeteoPT GFS cycle failed",h,e);
      checks.push({
        requested_cycle_utc:h,
        status:"error",
        error:String(e)
      });
    }
  }

  await env.GFS_KV.put("gfs:last-check",JSON.stringify({
    checked_at_utc:new Date().toISOString(),
    status:"checked",
    checks
  }));

  const ready:any[]=[];
  for(const c of checks){
    if(c.status==="checked" && c.f180_available){
      try{
        const x=await fetchRun(c.requested_cycle_utc);
        const doc=normalize(x.doc);
        if(new Date(doc.run_id_utc).getUTCHours()===c.requested_cycle_utc && doc.noaa_source_file.f180_available){
          ready.push(doc);
        }
      }catch(e){
        console.error("MeteoPT ready-cycle recheck failed",c.requested_cycle_utc,e);
      }
    }
  }

  if(!ready.length){
    await env.GFS_KV.put("gfs:last-check",JSON.stringify({
      checked_at_utc:new Date().toISOString(),
      status:"no_f180_ready",
      checks
    }));
    console.log("No MeteoPT GFS cycle with F180 ready");
    return;
  }

  ready.sort((a,b)=>Date.parse(b.run_id_utc)-Date.parse(a.run_id_utc));
  const doc=ready[0];
  const publishedKey="published:"+runKey(doc.run_id_utc);
  const publishedMarker=await env.GFS_KV.get(publishedKey);
  const latestExisting=await env.GFS_KV.get("latest");

  if(publishedMarker && latestExisting){
    await env.GFS_KV.put("gfs:last-check",JSON.stringify({
      checked_at_utc:new Date().toISOString(),
      status:"already_published",
      run_id_utc:doc.run_id_utc,
      f180_available:true,
      forecast_horizon_hours:doc.forecast_horizon_hours,
      checks
    }));
    console.log("Already published and latest payload exists",doc.run_id_utc);
    return;
  }

  await storeRun(env,doc);
  const runs=await lastRuns(env);
  await publish(env,doc,runs);

  await env.GFS_KV.put("gfs:last-check",JSON.stringify({
    checked_at_utc:new Date().toISOString(),
    status:"published",
    run_id_utc:doc.run_id_utc,
    f180_available:true,
    forecast_horizon_hours:doc.forecast_horizon_hours,
    checks
  }));
  console.log("Published Istanbul GFS",doc.run_id_utc);
}

export default {
  async scheduled(controller:ScheduledController,env:Env,ctx:ExecutionContext){
    console.log("GFS CRON START", controller.cron, new Date(controller.scheduledTime).toISOString());
    try {
      await process(env);
    } catch (e) {
      console.error("GFS CRON FAILED", e);
      await env.GFS_KV.put("gfs:last-check",JSON.stringify({
        checked_at_utc:new Date().toISOString(),
        status:"fatal_error",
        error:String(e)
      }));
      // Keep the scheduled invocation green so one transient upstream/Telegram error
      // does not make the cron itself appear broken. The next run retries automatically.
    }
  },
  async fetch(request:Request,env:Env):Promise<Response>{
    const origin=env.ALLOWED_ORIGIN||"*";const u=new URL(request.url);
    if(request.method==="OPTIONS")return new Response(null,{headers:{"access-control-allow-origin":origin,"access-control-allow-methods":"GET,OPTIONS","access-control-allow-headers":"content-type"}});
    if(u.pathname==="/health")return json({ok:true,service:"istanbul-gfs-cloudflare",time:new Date().toISOString()},200,origin);
    if(u.pathname==="/gfs/latest"){const v=await env.GFS_KV.get("latest","json");return v?json(v,200,origin):json({error:"not_ready"},404,origin);}
    if(u.pathname==="/gfs/status"){const v=await env.GFS_KV.get("gfs:last-check","json");return v?json(v,200,origin):json({error:"no_check_yet"},404,origin);}
    if(u.pathname==="/gfs/comparison"){const v=await env.GFS_KV.get("comparison","json");return v?json(v,200,origin):json({error:"not_ready"},404,origin);}
    if(u.pathname==="/gfs/report"){const v=await env.GFS_KV.get("report");return v?new Response(v,{headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store","access-control-allow-origin":origin} }):new Response("not_ready",{status:404});}
    if(/^\/gfs\/image-[0-3]$/.test(u.pathname)){const i=u.pathname.slice(-1);const v=await env.GFS_KV.get("image:"+i,"arrayBuffer");return v?new Response(v,{headers:{"content-type":"image/png","cache-control":"no-store","access-control-allow-origin":origin}}):new Response("not_ready",{status:404});}
    if(u.pathname==="/gfs/notification-latest"){const v=await env.GFS_KV.get("latest","json");if(!v)return json({error:"not_ready"},404,origin);return json({run_id_utc:v.run_id_utc,report_text:await env.GFS_KV.get("report"),images:[0,1,2,3].map(i=>({url:new URL("/gfs/image-"+i,u.origin).toString()}))},200,origin);}
    return new Response("İstanbul GFS Cloudflare Worker",{headers:{"content-type":"text/plain; charset=utf-8","access-control-allow-origin":origin}});
  }
};