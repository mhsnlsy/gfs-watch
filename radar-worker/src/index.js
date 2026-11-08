// LIVE SYNTHETIC RADAR DRILL ENABLED: 30 km N / 25 dBZ / 20 px / 30 km/h / ~60 min ETA
const LAT = 41.0904;
const LON = 28.9438;
const RADIUS_KM = 90;
const THRESHOLD_DBZ = 10;
const THRESHOLD_DBZ_STRONG = 30;
const MIN_ALERT_PIXELS = 5;
const ALERT_COOLDOWN_SECONDS = 45 * 60;
const HISTORY_LEN = 4;
const ZOOM = 7;
const TILE_SIZE = 256;
const PIXEL_KM = 0.55;
const ANALYSIS_RADIUS_PX = Math.ceil(RADIUS_KM / PIXEL_KM);

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
      if(dbz>=THRESHOLD_DBZ) high.push({dx,dy,dist_km:Math.hypot(dx,dy)*PIXEL_KM,dbz});
    }
  }
  if(!high.length)return {max_dbz:0,count:0,centroid_dist:null,strong_count:0,strong_max:0,avg_dx:0,avg_dy:0};
  const avg_dx=high.reduce((s,p)=>s+p.dx,0)/high.length;
  const avg_dy=high.reduce((s,p)=>s+p.dy,0)/high.length;
  const max_dbz=Math.max(...high.map(p=>p.dbz));
  const strong=high.filter(p=>p.dbz>=THRESHOLD_DBZ_STRONG);
  return {max_dbz,count:high.length,centroid_dist:Math.round(Math.hypot(avg_dx,avg_dy)*PIXEL_KM*10)/10,
    strong_count:strong.length,strong_max:strong.length?Math.max(...strong.map(p=>p.dbz)):0,avg_dx,avg_dy};
}

function motion(history){
  if(history.length<2)return {speed:null,heading:null,towards:false,eta:null};
  const segments=[];
  for(let i=1;i<history.length;i++){
    const a=history[i-1],b=history[i],dt=b.ts-a.ts;
    if(dt<60) continue;
    const dx=b.avg_dx-a.avg_dx,dy=b.avg_dy-a.avg_dy,dist=Math.hypot(dx,dy);
    if(dist>0) segments.push({dx,dy,dist,dt});
  }
  if(!segments.length)return {speed:null,heading:null,towards:false,eta:null};
  const recent=segments.slice(-3);
  const totalDt=recent.reduce((s,x)=>s+x.dt,0);
  const dx=recent.reduce((s,x)=>s+x.dx,0),dy=recent.reduce((s,x)=>s+x.dy,0);
  const dist=Math.hypot(dx,dy);
  if(totalDt<60||dist===0)return {speed:null,heading:null,towards:false,eta:null};
  const speed=dist*PIXEL_KM/totalDt*3600, heading=(Math.atan2(dx,-dy)*180/Math.PI+360)%360;
  const b=history[history.length-1],tx=-b.avg_dx,ty=-b.avg_dy,tlen=Math.hypot(tx,ty);
  const towards=dist>=0.5&&tlen>=1&&(dx*tx+dy*ty)/(dist*tlen)>0.5;
  const eta=speed>5&&b.centroid_dist!=null&&towards?b.centroid_dist/speed*60:null;
  return {speed:Math.round(speed),heading:Math.round(heading),towards,eta:eta!=null?Math.round(eta):null};
}

function approaching(prev,curr){
  if(!curr||curr.centroid_dist==null)return false;
  if(!prev||prev.centroid_dist==null)return curr.centroid_dist<20&&curr.max_dbz>=THRESHOLD_DBZ;
  return curr.centroid_dist<prev.centroid_dist-0.8&&curr.centroid_dist<RADIUS_KM&&curr.max_dbz>=THRESHOLD_DBZ;
}

async function telegramText(env,text){
  if(!env.TELEGRAM_TOKEN||!env.CHAT_ID)return false;
  const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({chat_id:env.CHAT_ID,text,parse_mode:"HTML"})
  });
  return r.ok;
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
  return r||{history_json:"[]",last_alert_ts:0};
}

async function saveState(db,s){
  await db.prepare(`INSERT INTO radar_state(id,history_json,last_frame_ts,last_alert_ts,last_intensity,updated_at)
    VALUES(1,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET history_json=excluded.history_json,last_frame_ts=excluded.last_frame_ts,
    last_alert_ts=excluded.last_alert_ts,last_intensity=excluded.last_intensity,updated_at=excluded.updated_at`)
    .bind(JSON.stringify(s.history),s.last_frame_ts||0,s.last_alert_ts||0,s.last_intensity||"",new Date().toISOString()).run();
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

async function makeSyntheticRadarPng(){
  const w=256,h=256,bpp=4;
  const raw=new Uint8Array(h*(1+w*bpp));
  const cx=128, cy=128-Math.round(30/PIXEL_KM);
  const blob=[];
  for(let dy=-1;dy<=2;dy++) for(let dx=-2;dx<=2;dx++) blob.push([cx+dx,cy+dy]);
  const pixels=new Set(blob.slice(0,20).map(([x,y])=>`${x},${y}`));
  for(let y=0;y<h;y++){
    const row=y*(1+w*bpp); raw[row]=0;
    for(let x=0;x<w;x++){
      const i=row+1+x*bpp;
      if(pixels.has(`${x},${y}`)){
        raw[i]=0; raw[i+1]=119; raw[i+2]=170; raw[i+3]=255;
      } else {
        raw[i]=0; raw[i+1]=0; raw[i+2]=0; raw[i+3]=0;
      }
    }
  }
  const compressed=await readStream(new Response(raw).body.pipeThrough(new CompressionStream("deflate")));
  const ihdr=new Uint8Array(13), dv=new DataView(ihdr.buffer);
  dv.setUint32(0,w); dv.setUint32(4,h); ihdr[8]=8; ihdr[9]=6; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  const sig=new Uint8Array([137,80,78,71,13,10,26,10]);
  const idat=pngChunk("IDAT",compressed), iend=pngChunk("IEND",new Uint8Array());
  const out=new Uint8Array(sig.length+25+idat.length+iend.length);
  let o=0; out.set(sig,o);o+=sig.length;
  out.set(pngChunk("IHDR",ihdr),o);o+=25;
  out.set(idat,o);o+=idat.length;
  out.set(iend,o);
  return out;
}

async function runSyntheticTest(env){
  const text=`⚠️ TEST / TATBİKAT — GERÇEK YAĞIŞ DEĞİL

SENTETİK RADAR SENARYOSU
Kütle: 30 km kuzeyden geliyor
Şiddet: 25 dBZ
Yağış pikseli: 20
Hız: 30 km/sa
Tahmini varış: ~60 dk
Yön: GÜNEY / İstanbul'a doğru

BU MESAJ YALNIZCA SİSTEM TESTİDİR. GERÇEK YAĞIŞ ALARMI DEĞİLDİR.`;
  const sent=await telegramText(env,text);
  return {status:sent?"test_sent":"telegram_send_failed",telegram_sent:sent,scenario:{distance_km:30,dbz:25,pixels:20,speed_kmh:30,eta_minutes:60},mode:"text_only_test"};
}

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
  const radarPhotoBytes=decoded.find(t=>t.ox===0&&t.oy===0)?.bytes;
  const curr=analyzeImage(img), state=await getState(env.RADAR_DB);
  const history=JSON.parse(state.history_json||"[]");
  if(history.length&&history[history.length-1].ts===ts)return {status:"duplicate_frame",frame_ts:ts};

  history.push({ts,avg_dx:curr.avg_dx,avg_dy:curr.avg_dy,centroid_dist:curr.centroid_dist,max_dbz:curr.max_dbz});
  const h=history.slice(-HISTORY_LEN), prev=h.length>1?h[h.length-2]:null, m=motion(h);
  const pixelGate=curr.count>=MIN_ALERT_PIXELS, hasEcho=curr.centroid_dist!=null&&curr.count>0;
  const onSite=hasEcho&&curr.centroid_dist<5&&curr.max_dbz>=THRESHOLD_DBZ;
  let app=approaching(prev,curr);
  if(m.towards&&hasEcho&&curr.centroid_dist<RADIUS_KM)app=app||curr.max_dbz>=THRESHOLD_DBZ;
  const etaEligible=m.eta!=null&&m.eta<=90;
  const alert=pixelGate&&((app&&etaEligible)||onSite);

  let intensity="DÜŞÜK",emoji="🌦️";
  if(curr.max_dbz>30){intensity="ÇOK GÜÇLÜ";emoji="⚠️";}
  else if(curr.max_dbz>20){intensity="GÜÇLÜ";emoji="⛈️";}
  else if(curr.max_dbz>10){intensity="ORTA";emoji="🌧️";}

  const now=Math.floor(Date.now()/1000), last=Number(state.last_alert_ts||0);
  let sent=false;
  if(alert&&now-last>=ALERT_COOLDOWN_SECONDS){
    let motionTxt=""; if(m.speed!=null){motionTxt=`Hız: ~${m.speed} km/sa, yön: ${m.heading}°`; if(m.eta) motionTxt+=`, tahmini varış: ~${m.eta} dk`; if(m.towards) motionTxt+=" (konuma doğru)";}
    const caption=`${emoji} <b>${intensity} YAĞIŞ UYARISI — İstanbul</b>
Konum: 41.0904 N, 28.9438 E
Şiddet: ${intensity} (${curr.max_dbz} dBZ), merkez: ${curr.centroid_dist??"—"} km, ${curr.count} yağış pikseli
${motionTxt}
${onSite?"Konuma ulaşıyor / üzerinde.":"Yaklaşıyor."}
${new Date(ts*1000).toLocaleString("tr-TR",{timeZone:"Europe/Istanbul"})}`;
    const photoResult=radarPhotoBytes?await telegramPhoto(env,radarPhotoBytes,caption):false;
    sent=typeof photoResult==="object"?photoResult.ok:photoResult;
    if(!sent) sent=await telegramText(env,caption);
    if(sent) {state.last_alert_ts=now;state.last_intensity=intensity;}
  }
  state.history=h;state.last_frame_ts=ts;
  await saveState(env.RADAR_DB,state);
  return {status:"ok",frame_ts:ts,alert,pixel_count:curr.count,pixel_gate:pixelGate,max_dbz:curr.max_dbz,eta_minutes:m.eta,eta_eligible:etaEligible,
    centroid_dist:curr.centroid_dist,approaching:app,on_site:onSite,towards:m.towards,telegram_sent:sent};
}

export default {
  async fetch(request,env){const url=new URL(request.url);if(url.pathname==="/test-radar"){return new Response(JSON.stringify(await runSyntheticTest(env)),{headers:{"content-type":"application/json"}});}if(url.pathname==="/health"){const s=await getState(env.RADAR_DB);return new Response(JSON.stringify({ok:true,service:"radar-monitor",interval:"6m",pixel_threshold:MIN_ALERT_PIXELS,cooldown_minutes:ALERT_COOLDOWN_SECONDS/60,last_frame_ts:Number(s.last_frame_ts||0),last_alert_ts:Number(s.last_alert_ts||0),last_intensity:s.last_intensity||""}),{headers:{"content-type":"application/json"}});}return new Response(JSON.stringify({ok:true,service:"radar-monitor",interval:"6m"}),{headers:{"content-type":"application/json"}});},
  async scheduled(event,env,ctx){ctx.waitUntil(check(env).then(r=>console.log(JSON.stringify(r))).catch(e=>console.error(e.stack||e.message||e)));}
};
