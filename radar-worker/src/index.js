// RADAR CRON LIVE — Cloudflare Paid
const LAT = 41.0904;
const LON = 28.9438;
const ANALYSIS_RADIUS_KM = 210;
const THRESHOLD_DBZ_STRONG = 30;
const ENTRY_ALERT_RADIUS_KM = 25;
const RADAR_BUILD = "paid-cron-2026-11-10-grok-approach-eta-4frame-3";
const HISTORY_LEN = 4;
const ZOOM = 7;
const TILE_SIZE = 256;
const PIXEL_KM = 0.55;
const ANALYSIS_RADIUS_PX = Math.ceil(ANALYSIS_RADIUS_KM / PIXEL_KM);

const DBZ_HINTS = [
  [10, [0,220,220]], [15, [0,190,220]], [20, [0,163,224]],
  [25, [0,119,170]], [30, [0,85,136]], [35, [255,238,0]],
  [40, [255,170,0]], [45, [255,68,0]], [50, [193,0,0]],
  [55, [255,170,255]]
];

function haversine(a,b,c,d){
  const R=6371, p1=a*Math.PI/180, p2=c*Math.PI/180;
  const dp=(c-a)*Math.PI/180, dl=(d-b)*Math.PI/180;
  const x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}

function latlonToPixel(lat,lon,z){
  const lr=lat*Math.PI/180, n=2**z;
  return [
    Math.floor((lon+180)/360*n*TILE_SIZE),
    Math.floor((1-Math.asinh(Math.tan(lr))/Math.PI)/2*n*TILE_SIZE)
  ];
}

async function readStream(stream){
  const reader=stream.getReader(), parts=[], total=[];
  let n=0;
  while(true){
    const {value,done}=await reader.read();
    if(done) break;
    parts.push(value); n+=value.length;
  }
  const out=new Uint8Array(n); let o=0;
  for(const p of parts){out.set(p,o);o+=p.length;}
  return out;
}

function paeth(a,b,c){
  const p=a+b-c, pa=Math.abs(p-a), pb=Math.abs(p-b), pc=Math.abs(p-c);
  return pa<=pb&&pa<=pc?a:pb<=pc?b:c;
}

async function decodePng(buf){
  const u=new Uint8Array(buf);
  const sig=[137,80,78,71,13,10,26,10];
  for(let i=0;i<8;i++) if(u[i]!==sig[i]) throw new Error("Invalid PNG");
  let off=8,w=0,h=0,ct=0,bd=0, ids=[];
  while(off<u.length){
    const len=new DataView(u.buffer,u.byteOffset+off,4).getUint32(0); off+=4;
    const type=String.fromCharCode(...u.slice(off,off+4)); off+=4;
    const data=u.slice(off,off+len); off+=len; off+=4;
    if(type==="IHDR"){const v=new DataView(data.buffer,data.byteOffset,data.byteLength);w=v.getUint32(0);h=v.getUint32(4);bd=data[8];ct=data[9];}
    else if(type==="IDAT") ids.push(data);
    else if(type==="IEND") break;
  }
  if(bd!==8 || (ct!==6 && ct!==2)) throw new Error("Unsupported PNG format");
  const compressed=new Uint8Array(ids.reduce((n,x)=>n+x.length,0)); let o=0;
  for(const x of ids){compressed.set(x,o);o+=x.length;}
  const raw=await readStream(new Response(compressed).body.pipeThrough(new DecompressionStream("deflate")));
  const bpp=ct===6?4:3, stride=w*bpp, out=new Uint8Array(h*stride);
  let src=0;
  for(let y=0;y<h;y++){
    const filter=raw[src++], row=y*stride;
    for(let x=0;x<stride;x++){
      const a=x>=bpp?out[row+x-bpp]:0;
      const b=y>0?out[row-stride+x]:0;
      const c=(y>0&&x>=bpp)?out[row-stride+x-bpp]:0;
      let v=raw[src++];
      if(filter===1)v=(v+a)&255;
      else if(filter===2)v=(v+b)&255;
      else if(filter===3)v=(v+Math.floor((a+b)/2))&255;
      else if(filter===4)v=(v+paeth(a,b,c))&255;
      else if(filter!==0)throw new Error("Unsupported PNG filter");
      out[row+x]=v;
    }
  }
  return {w,h,ct,data:out};
}

function estimateDbz(r,g,b){
  let best=0, dist=999;
  for(const [dbz,[tr,tg,tb]] of DBZ_HINTS){
    const d=Math.abs(r-tr)+Math.abs(g-tg)+Math.abs(b-tb);
    if(d<dist){dist=d;best=dbz;}
  }
  return dist<80?best:0;
}

function compassFromVector(dx,dy){
  if(dx==null||dy==null) return "—";
  const deg=(Math.atan2(dx,-dy)*180/Math.PI+360)%360;
  const dirs=["K","K-KD","KD","D-KD","D","D-GD","GD","G-GD","G","G-GB","GB","B-GB","B","B-KB","KB","K-KB"];
  return dirs[Math.round(deg/22.5)%16];
}
function motionMetrics(curr,history,currentTs){
  const samples=history.filter(p=>p && p.avg_dx!=null && p.avg_dy!=null && p.ts!=null);
  if(!samples.length || curr.avg_dx==null || curr.avg_dy==null || curr.centroid_dist==null)
    return {approaching:false,speed_kmh:null,eta_min:null,motion_dir:"—"};

  const prev=samples[samples.length-1];
  const dtMin=Math.max((currentTs-prev.ts)/60,0.1);
  let vx=curr.avg_dx-prev.avg_dx, vy=curr.avg_dy-prev.avg_dy, dt=dtMin;

  // Use up to four consecutive radar frames to stabilize the motion vector.
  // This avoids an ETA being dominated by one noisy six-minute scan.
  if(samples.length>=2){
    const first=samples[Math.max(0,samples.length-3)];
    const spanMin=Math.max((currentTs-first.ts)/60,dtMin);
    vx=(curr.avg_dx-first.avg_dx);
    vy=(curr.avg_dy-first.avg_dy);
    dt=spanMin;
  }

  const tx=-curr.avg_dx, ty=-curr.avg_dy;
  const motionLen=Math.hypot(vx,vy), targetLen=Math.hypot(tx,ty);
  if(motionLen<0.25 || targetLen<=0)
    return {approaching:false,speed_kmh:null,eta_min:null,motion_dir:compassFromVector(vx,vy)};

  const toward=(vx*tx+vy*ty)/(motionLen*targetLen);
  const speedKmh=motionLen*PIXEL_KM*(60/dt);
  const radialKmPerMin=(motionLen*PIXEL_KM*toward)/dt;
  const etaMin=radialKmPerMin>0 ? curr.centroid_dist/radialKmPerMin : null;
  return {
    approaching:toward>0,
    speed_kmh:Math.round(speedKmh*10)/10,
    eta_min:etaMin!=null?Math.max(1,Math.round(etaMin)):null,
    motion_dir:compassFromVector(vx,vy)
  };
}
function analyzeImage(img){
  const [px,py]=latlonToPixel(LAT,LON,ZOOM);
  const localX=(px%TILE_SIZE)+TILE_SIZE, localY=(py%TILE_SIZE)+TILE_SIZE, radius=ANALYSIS_RADIUS_PX;
  const high=[];
  for(let dy=-radius;dy<=radius;dy++){
    for(let dx=-radius;dx<=radius;dx++){
      if(dx*dx+dy*dy>radius*radius) continue;
      const x=localX+dx,y=localY+dy;
      if(x<0||y<0||x>=img.w||y>=img.h) continue;
      const i=(y*img.w+x)*(img.ct===6?4:3);
      const r=img.data[i],g=img.data[i+1],b=img.data[i+2];
      const a=img.ct===6?img.data[i+3]:255;
      if(a<=40) continue;
      const dbz=estimateDbz(r,g,b);
      if(a>40 && (img.ct===6 || dbz>0)) high.push({dx,dy,dist_km:Math.hypot(dx,dy)*PIXEL_KM,dbz});
    }
  }
  if(!high.length)return {max_dbz:0,count:0,min_dist_km:null,centroid_dist:null,strong_count:0,strong_max:0,avg_dx:0,avg_dy:0,area_km2:0,width_km:0,height_km:0};
  const avg_dx=high.reduce((s,p)=>s+p.dx,0)/high.length;
  const avg_dy=high.reduce((s,p)=>s+p.dy,0)/high.length;
  const min_dist_km=Math.min(...high.map(p=>p.dist_km));
  const max_dbz=Math.max(...high.map(p=>p.dbz));
  const min_dx=Math.min(...high.map(p=>p.dx)), max_dx=Math.max(...high.map(p=>p.dx));
  const min_dy=Math.min(...high.map(p=>p.dy)), max_dy=Math.max(...high.map(p=>p.dy));
  const strong=high.filter(p=>p.dbz>=THRESHOLD_DBZ_STRONG);
  return {max_dbz,count:high.length,min_dist_km:Math.round(min_dist_km*10)/10,centroid_dist:Math.round(Math.hypot(avg_dx,avg_dy)*PIXEL_KM*10)/10,
    strong_count:strong.length,strong_max:strong.length?Math.max(...strong.map(p=>p.dbz)):0,avg_dx,avg_dy,
    area_km2:Math.round(high.length*PIXEL_KM*PIXEL_KM),
    width_km:Math.round((max_dx-min_dx+1)*PIXEL_KM*10)/10,
    height_km:Math.round((max_dy-min_dy+1)*PIXEL_KM*10)/10};
}

async function telegramText(env,text){
  if(!env.TELEGRAM_TOKEN||!env.CHAT_ID)return {ok:false,status:0,body:"telegram credentials missing"};
  const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({chat_id:env.CHAT_ID,text,parse_mode:"HTML"})
  });
  let body="";
  try{body=await r.text();}catch{}
  return {ok:r.ok,status:r.status,body:body.slice(0,500)};
}

async function telegramPhoto(env,bytes,caption){
  if(!env.TELEGRAM_TOKEN||!env.CHAT_ID)return false;
  const fd=new FormData();
  fd.append("chat_id",env.CHAT_ID);
  fd.append("caption",caption);
  fd.append("parse_mode","HTML");
  fd.append("photo",new File([bytes],"istanbul-radar.png",{type:"image/png"}));
  const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendPhoto`,{method:"POST",body:fd});
  if(!r.ok){
    let body="";
    try{body=await r.text();}catch{}
    return {ok:false,status:r.status,body:body.slice(0,500)};
  }
  return {ok:true,status:r.status};
}

async function getState(db){
  const r=await db.prepare("SELECT * FROM radar_state WHERE id=1").first();
  return r||{history_json:"[]",last_alert_ts:0,last_telegram_status:0,last_telegram_error:""};
}

async function saveState(db,s){
  await db.prepare(`INSERT INTO radar_state(id,history_json,last_frame_ts,last_alert_ts,last_intensity,last_telegram_status,last_telegram_error,updated_at)
    VALUES(1,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET history_json=excluded.history_json,last_frame_ts=excluded.last_frame_ts,
    last_alert_ts=excluded.last_alert_ts,last_intensity=excluded.last_intensity,
    last_telegram_status=excluded.last_telegram_status,last_telegram_error=excluded.last_telegram_error,
    updated_at=excluded.updated_at`)
    .bind(JSON.stringify(s.history),s.last_frame_ts||0,s.last_alert_ts||0,s.last_intensity||"",
      s.last_telegram_status||0,s.last_telegram_error||"",new Date().toISOString()).run();
}

function crc32(bytes){
  let c=0xffffffff;
  for(const b of bytes){
    c^=b;
    for(let k=0;k<8;k++) c=(c>>>1)^((c&1)?0xedb88320:0);
  }
  return (c^0xffffffff)>>>0;
}

function pngChunk(type,data){
  const t=new TextEncoder().encode(type);
  const out=new Uint8Array(12+t.length+data.length);
  const dv=new DataView(out.buffer);
  dv.setUint32(0,data.length);
  out.set(t,4); out.set(data,8);
  dv.setUint32(8+t.length+data.length,crc32(new Uint8Array([...t,...data])));
  return out;
}

async function encodePngRGBA(w,h,rgba){
  const raw=new Uint8Array(h*(1+w*4));
  for(let y=0;y<h;y++){const ro=y*(1+w*4),so=y*w*4;raw[ro]=0;raw.set(rgba.subarray(so,so+w*4),ro+1);}
  const compressed=await readStream(new Response(raw).body.pipeThrough(new CompressionStream("deflate")));
  const ihdr=new Uint8Array(13),dv=new DataView(ihdr.buffer);dv.setUint32(0,w);dv.setUint32(4,h);ihdr[8]=8;ihdr[9]=6;
  const sig=new Uint8Array([137,80,78,71,13,10,26,10]);const a=pngChunk("IHDR",ihdr),b=pngChunk("IDAT",compressed),d=pngChunk("IEND",new Uint8Array());
  const out=new Uint8Array(sig.length+a.length+b.length+d.length);let o=0;out.set(sig,o);o+=sig.length;out.set(a,o);o+=a.length;out.set(b,o);o+=b.length;out.set(d,o);return out;
}
function drawLine(rgba,w,x0,y0,x1,y1,color,width=2){let dx=Math.abs(x1-x0),sx=x0<x1?1:-1,dy=-Math.abs(y1-y0),sy=y0<y1?1:-1,err=dx+dy,h=rgba.length/(w*4);while(true){for(let yy=-width;yy<=width;yy++)for(let xx=-width;xx<=width;xx++){const x=Math.round(x0+xx),y=Math.round(y0+yy);if(x<0||y<0||x>=w||y>=h)continue;const i=(y*w+x)*4;rgba[i]=color[0];rgba[i+1]=color[1];rgba[i+2]=color[2];rgba[i+3]=255;}if(Math.round(x0)===Math.round(x1)&&Math.round(y0)===Math.round(y1))break;const e2=2*err;if(e2>=dy){err+=dy;x0+=sx;}if(e2<=dx){err+=dx;y0+=sy;}}}
function drawCircle(rgba,w,cx,cy,r,color,width=2){const h=rgba.length/(w*4);for(let a=0;a<360;a++){const rad=a*Math.PI/180,x=Math.round(cx+Math.cos(rad)*r),y=Math.round(cy+Math.sin(rad)*r);for(let k=-width;k<=width;k++){const xx=x+(Math.abs(Math.cos(rad))<0.5?k:0),yy=y+(Math.abs(Math.sin(rad))<0.5?k:0);if(xx<0||yy<0||xx>=w||yy>=h)continue;const i=(yy*w+xx)*4;rgba[i]=color[0];rgba[i+1]=color[1];rgba[i+2]=color[2];rgba[i+3]=255;}}}
function drawMarker(rgba,w,cx,cy){drawCircle(rgba,w,cx,cy,9,[0,92,230],3);drawCircle(rgba,w,cx,cy,4,[255,255,255],2);drawLine(rgba,w,cx-14,cy,cx+14,cy,[255,255,255],1);drawLine(rgba,w,cx,cy-14,cx,cy+14,[255,255,255],1);}
function drawArrow(rgba,w,x0,y0,x1,y1){drawLine(rgba,w,x0,y0,x1,y1,[255,255,255],3);const ang=Math.atan2(y1-y0,x1-x0),len=14;drawLine(rgba,w,x1,y1,x1-len*Math.cos(ang-0.5),y1-len*Math.sin(ang-0.5),[255,255,255],3);drawLine(rgba,w,x1,y1,x1-len*Math.cos(ang+0.5),y1-len*Math.sin(ang+0.5),[255,255,255],3);}
function compositeRadar(base,radar){const rgba=new Uint8Array(base.w*base.h*4),bb=base.ct===6?4:3,rb=radar.ct===6?4:3;for(let p=0,i=0;p<base.w*base.h;p++,i+=4){const bi=p*bb,ri=p*rb;rgba[i]=base.data[bi]||0;rgba[i+1]=base.data[bi+1]||0;rgba[i+2]=base.data[bi+2]||0;rgba[i+3]=255;const a=(radar.ct===6?(radar.data[ri+3]||0):255)/255;if(a>0){rgba[i]=Math.round((radar.data[ri]||0)*a+rgba[i]*(1-a));rgba[i+1]=Math.round((radar.data[ri+1]||0)*a+rgba[i+1]*(1-a));rgba[i+2]=Math.round((radar.data[ri+2]||0)*a+rgba[i+2]*(1-a));}}return rgba;}
async function makeRadarReportPng(base,radar,curr){const rgba=compositeRadar(base,radar),w=base.w,h=base.h,[px,py]=latlonToPixel(LAT,LON,ZOOM),cx=(px%TILE_SIZE)+TILE_SIZE,cy=(py%TILE_SIZE)+TILE_SIZE;drawCircle(rgba,w,cx,cy,Math.round(ENTRY_ALERT_RADIUS_KM/PIXEL_KM),[255,255,255],2);drawMarker(rgba,w,cx,cy);if(curr.centroid_dist!=null){const mx=cx+curr.avg_dx,my=cy+curr.avg_dy;drawCircle(rgba,w,mx,my,8,[255,255,255],2);drawArrow(rgba,w,cx,cy,mx,my);}return encodePngRGBA(w,h,rgba);}

async function check(env){
  const timeline=await (await fetch("https://api.rainviewer.com/public/weather-maps.json",{cf:{cacheTtl:0}})).json();
  const past=timeline?.radar?.past||[];
  if(!past.length) return {status:"no_past_frames"};
  const latest=past[past.length-1], path=latest.path, ts=latest.time;
  const host=timeline.host||"https://tilecache.rainviewer.com";
  const [px,py]=latlonToPixel(LAT,LON,ZOOM), tx=Math.floor(px/TILE_SIZE), ty=Math.floor(py/TILE_SIZE);
  const tiles=[];
  for(let oy=-1;oy<=1;oy++) for(let ox=-1;ox<=1;ox++){
    const u=`${host}${path}/${TILE_SIZE}/${ZOOM}/${tx+ox}/${ty+oy}/2/1_1.png`;
    const r=await fetch(u,{cf:{cacheTtl:0}});
    if(!r.ok) return {status:"tile_download_failed",frame_ts:ts};
    tiles.push({ox,oy,bytes:await r.arrayBuffer()});
  }
  const decoded=await Promise.all(tiles.map(async t=>({...t,img:await decodePng(t.bytes)})));
  // Build only the radar mosaic needed for detection first. The expensive
  // OSM/base-map fetch and PNG compositing are deferred until an alert is
  // actually going to be sent. This keeps the six-minute Cron well below
  // the Worker CPU budget during normal (no-alert) scans.
  const mosaic={w:TILE_SIZE*3,h:TILE_SIZE*3,ct:decoded[0].img.ct,data:new Uint8Array(TILE_SIZE*TILE_SIZE*9*(decoded[0].img.ct===6?4:3))};
  const bpp=mosaic.ct===6?4:3;
  for(const t of decoded){
    for(let y=0;y<TILE_SIZE;y++){
      const src=(y*TILE_SIZE)*bpp;
      const dst=((y+(t.oy+1)*TILE_SIZE)*mosaic.w+(t.ox+1)*TILE_SIZE)*bpp;
      mosaic.data.set(t.img.data.subarray(src,src+TILE_SIZE*bpp),dst);
    }
  }
  const img=mosaic;
  const curr=analyzeImage(img), state=await getState(env.RADAR_DB);
  const history=JSON.parse(state.history_json||"[]");
  if(history.length&&history[history.length-1].ts===ts)return {status:"duplicate_frame",frame_ts:ts};
  const hBefore = history.slice(-HISTORY_LEN);
  const previous = hBefore.length ? hBefore[hBefore.length - 1] : null;
  const rainDetected = curr.count > 0 && curr.min_dist_km != null;
  const motionInfo = motionMetrics(curr,hBefore,ts);
  history.push({ts,avg_dx:curr.avg_dx,avg_dy:curr.avg_dy,min_dist_km:curr.min_dist_km,centroid_dist:curr.centroid_dist,max_dbz:curr.max_dbz,approaching:motionInfo.approaching});
  const h=history.slice(-HISTORY_LEN);

  // RainViewer detects precipitation approaching Istanbul -> send Telegram.
  // Intensity, pixel count, radius and cooldown are deliberately not filters.
  // Send only when a new approaching episode starts. Do not repeat every six minutes
  // while the same precipitation system continues approaching.
  const alert = rainDetected && motionInfo.approaching && !Boolean(previous?.approaching);

  let intensity="HAFİF",emoji="🌦️";
  if(curr.max_dbz>=25){intensity="GÜÇLÜ";emoji="⛈️";}
  else if(curr.max_dbz>=15){intensity="ORTA";emoji="🌧️";}

  const now=Math.floor(Date.now()/1000);
  let sent=false, telegramStatus=0, telegramError="";
  if(alert){
    const caption = `${emoji} <b>${intensity} YAĞIŞ YAKLAŞIYOR — İstanbul</b>\\n📍 Merkez: ${curr.centroid_dist??"—"} km ${compassFromVector(curr.avg_dx,curr.avg_dy)}\\n💧 Maksimum: ${curr.max_dbz} dBZ\\n🧭 Hareket: ${motionInfo.motion_dir} yönünde\\n💨 Hız: ${motionInfo.speed_kmh??"—"} km/sa\\n⏱️ Tahmini varış: ${motionInfo.eta_min!=null?motionInfo.eta_min+" dakika":"hesaplanamıyor"}\\n⚠️ Varış süresi tahminidir.\\n📡 RainViewer: ${new Date(ts*1000).toLocaleString("tr-TR",{timeZone:"Europe/Istanbul"})}`;
    const baseTiles=await Promise.all(tiles.map(async t=>{const u=`https://tile.openstreetmap.org/${ZOOM}/${tx+t.ox}/${ty+t.oy}.png`;const r=await fetch(u,{cf:{cacheTtl:3600}});if(!r.ok)throw new Error("base_map_tile_download_failed");return {...t,bytes:await r.arrayBuffer()};}));
    const baseDecoded=await Promise.all(baseTiles.map(async t=>({...t,img:await decodePng(t.bytes)})));
    const baseMosaic={w:TILE_SIZE*3,h:TILE_SIZE*3,ct:baseDecoded[0].img.ct,data:new Uint8Array(TILE_SIZE*TILE_SIZE*9*(baseDecoded[0].img.ct===6?4:3))};
    const baseBpp=baseMosaic.ct===6?4:3;
    for(const t of baseDecoded){
      for(let y=0;y<TILE_SIZE;y++){
        const src=(y*TILE_SIZE)*baseBpp;
        const dst=((y+(t.oy+1)*TILE_SIZE)*baseMosaic.w+(t.ox+1)*TILE_SIZE)*baseBpp;
        baseMosaic.data.set(t.img.data.subarray(src,src+TILE_SIZE*baseBpp),dst);
      }
    }
    const reportPhotoBytes=await makeRadarReportPng(baseMosaic,mosaic,curr);
    const photoResult=reportPhotoBytes?await telegramPhoto(env,reportPhotoBytes,caption):false;
    if(typeof photoResult==="object"){
      telegramStatus=photoResult.status||0;
      telegramError=photoResult.ok?"":(photoResult.body||"");
      sent=photoResult.ok;
    }else{
      sent=Boolean(photoResult);
    }
    if(!sent){
      const textResult=await telegramText(env,caption);
      telegramStatus=textResult.status||telegramStatus;
      telegramError=textResult.ok?"":(textResult.body||telegramError);
      sent=textResult.ok;
    }
    state.last_telegram_status=telegramStatus;
    state.last_telegram_error=telegramError;
    if(sent) {state.last_alert_ts=now;state.last_intensity=intensity;}
  }
  state.history=h;state.last_frame_ts=ts;
  await saveState(env.RADAR_DB,state);
  return {status:"ok",frame_ts:ts,alert,rain_detected:rainDetected,approaching:motionInfo.approaching,motion_direction:motionInfo.motion_dir,speed_kmh:motionInfo.speed_kmh,eta_min:motionInfo.eta_min,pixel_count:curr.count,max_dbz:curr.max_dbz,area_km2:curr.area_km2,width_km:curr.width_km,height_km:curr.height_km,min_dist_km:curr.min_dist_km,previous_min_dist_km:previous?.min_dist_km??null,centroid_dist:curr.centroid_dist,telegram_sent:sent,telegram_status:telegramStatus,telegram_error:telegramError};
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);

    if (url.pathname === "/telegram-test") {
      const r = await telegramText(env, "🧪 <b>RainViewer Telegram bağlantı testi</b>\\nCloudflare Worker Telegram API erişimi çalışıyor.");
      return new Response(JSON.stringify({ok:r.ok,status:r.status,error:r.ok?null:r.body}), {headers: {"content-type":"application/json"}});
    }

    if (url.pathname === "/health") {
      const state = await getState(env.RADAR_DB);
      const health = {
        ok: true,
        service: "radar-monitor",
        interval: "6m",
        build: RADAR_BUILD,
        alert_rule: "RainViewer yağış tespiti + yaklaşma",
        last_frame_ts: Number(state.last_frame_ts || 0),
        last_alert_ts: Number(state.last_alert_ts || 0),
        last_intensity: state.last_intensity || "",
        telegram_configured: Boolean(env.TELEGRAM_TOKEN && env.CHAT_ID),
        last_telegram_status: Number(state.last_telegram_status || 0),
        last_telegram_error: state.last_telegram_error || ""
      };
      return new Response(JSON.stringify(health), {
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      service: "radar-monitor",
      interval: "6m"
    }), {
      headers: { "content-type": "application/json" }
    });
  },
  async scheduled(event,env,ctx){ctx.waitUntil(check(env).then(r=>console.log(JSON.stringify(r))).catch(e=>console.error(e.stack||e.message||e)));}
};
