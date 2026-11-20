(() => {
  "use strict";

  const API = (window.GFS_WATCH_STATIONS_API || "https://gfs-watch-stations.muhsin-ulusoy.workers.dev") + "/api";
  const TZ = "Europe/Istanbul";
  const COLORS = {
    temperature: "#ef4444",
    dewPoint: "#3b82f6",
    precipitation1h: "#19a7e0",
    dailyPrecipitation: "#f97316",
    windChill: "#8b5cf6",
    heatIndex: "#eab308",
    humidity: "#16b981",
    windSpeed: "#10b981",
    windDirection: "#6366f1",
    pressure: "#f59e0b",
    precipitation10m: "#14b8a6",
    precipitation6h: "#8b5cf6",
    precipitation12h: "#ec4899",
    precipitation24h: "#f43f5e"
  };

  const VARIABLES = [
    {id:"temperature", label:"Temperature", color:COLORS.temperature, field:"temperature_c", unit:"°C", agg:"avg", digits:1},
    {id:"dewPoint", label:"Dew Point", color:COLORS.dewPoint, field:"dew_point_c", unit:"°C", agg:"avg", digits:1},
    {id:"precipitation1h", label:"Precipitation 1h", color:COLORS.precipitation1h, field:"rain_1h_mm", unit:"mm", agg:"max", digits:1},
    {id:"dailyPrecipitation", label:"Daily Precipitation", color:COLORS.dailyPrecipitation, field:"rain_00_now_mm", unit:"mm", agg:"max", digits:1},
    {id:"windChill", label:"Wind Chill", color:COLORS.windChill, field:"feels_like_c", unit:"°C", agg:"avg", digits:1},
    {id:"heatIndex", label:"Heat Index", color:COLORS.heatIndex, field:"heat_index_c", unit:"°C", agg:"avg", digits:1},
    {id:"humidity", label:"Relative Humidity", color:COLORS.humidity, field:"humidity_percent", unit:"%", agg:"avg", digits:0},
    {id:"windSpeed", label:"Wind Speed", color:COLORS.windSpeed, field:"wind_speed_kmh", unit:"km/h", agg:"avg", digits:1},
    {id:"windDirection", label:"Wind Direction", color:COLORS.windDirection, field:"wind_direction", unit:"°", agg:"last", digits:0},
    {id:"pressure", label:"Pressure", color:COLORS.pressure, field:"pressure_hpa", unit:"hPa", agg:"avg", digits:1},
    {id:"precipitation10m", label:"Precipitation 10m", color:COLORS.precipitation10m, field:"rain_10m_mm", unit:"mm", agg:"max", digits:1},
    {id:"precipitation6h", label:"Precipitation 6h", color:COLORS.precipitation6h, field:"rain_6h_mm", unit:"mm", agg:"max", digits:1},
    {id:"precipitation12h", label:"Precipitation 12h", color:COLORS.precipitation12h, field:"rain_12h_mm", unit:"mm", agg:"max", digits:1},
    {id:"precipitation24h", label:"Precipitation 24h", color:COLORS.precipitation24h, field:"rain_24h_mm", unit:"mm", agg:"max", digits:1}
  ];

  const state = {
    windowHours: 24,
    zone: "local",
    selected: ["temperature","dewPoint","precipitation1h","dailyPrecipitation"],
    cache: new Map(),
    openPicker: false
  };

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  const fmt = (v, digits) => v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("tr-TR", {minimumFractionDigits:digits, maximumFractionDigits:digits});
  const timeFormatter = (zone, long=false) => new Intl.DateTimeFormat("en-GB", {
    timeZone: zone === "local" ? TZ : "UTC",
    day: long ? "2-digit" : undefined,
    month: long ? "short" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const formatTime = (v, long=false) => {
    const d = new Date(v);
    if (!Number.isFinite(d.getTime())) return "—";
    return timeFormatter(state.zone, long).format(d);
  };
  const formatAxis = (v, hours) => {
    const d = new Date(v);
    if (!Number.isFinite(d.getTime())) return "—";
    const opts = hours <= 48
      ? {timeZone:state.zone==="local"?TZ:"UTC",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}
      : {timeZone:state.zone==="local"?TZ:"UTC",day:"2-digit",month:"short"};
    return new Intl.DateTimeFormat("en-GB", opts).format(d);
  };

  function injectStyle() {
    if ($("koy-observation-history-style")) return;
    const style = document.createElement("style");
    style.id = "koy-observation-history-style";
    style.textContent = `
      #koy-observation-history{margin:0 0 18px;padding:0;min-width:0}
      #koy-observation-history .oh-panel{background:#1b232f;border:1px solid rgba(204,225,239,.11);border-radius:21px;overflow:hidden;box-shadow:0 18px 55px rgba(0,0,0,.12)}
      #koy-observation-history .oh-head{padding:18px 20px 0}
      #koy-observation-history .oh-title{font:600 15px Manrope,sans-serif;color:#eef5f8}
      #koy-observation-history .oh-sub{font-size:10px;color:#8998a7;margin-top:4px}
      #koy-observation-history .oh-toggle-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:14px}
      #koy-observation-history .oh-segment{display:flex;background:#111821;border:1px solid rgba(204,225,239,.08);border-radius:13px;padding:3px}
      #koy-observation-history button{font-family:"DM Sans",sans-serif}
      #koy-observation-history .oh-segment button{border:0;background:transparent;color:#697786;font-size:10px;font-weight:700;padding:8px 17px;border-radius:10px;cursor:pointer}
      #koy-observation-history .oh-segment button.active{background:#202a38;color:#edf5f8;box-shadow:0 2px 10px rgba(0,0,0,.12)}
      #koy-observation-history .oh-zone{display:flex;background:#111821;border:1px solid rgba(204,225,239,.08);border-radius:13px;padding:3px}
      #koy-observation-history .oh-zone button{border:0;background:transparent;color:#697786;font-size:10px;font-weight:700;padding:8px 15px;border-radius:10px;cursor:pointer}
      #koy-observation-history .oh-zone button.active{background:#202a38;color:#edf5f8}
      #koy-observation-history .oh-vars{display:flex;flex-wrap:wrap;gap:8px;padding:14px 20px 5px}
      #koy-observation-history .oh-chip{display:inline-flex;align-items:center;gap:7px;border:1px solid color-mix(in srgb,var(--c) 85%,transparent);color:#aeb7c2;background:rgba(255,255,255,.015);border-radius:999px;padding:7px 10px;font-size:10px;white-space:nowrap}
      #koy-observation-history .oh-chip-dot{width:8px;height:8px;border-radius:50%;background:var(--c);flex:none}
      #koy-observation-history .oh-chip-x{border:0;background:transparent;color:#66727f;padding:0 0 0 2px;font-size:15px;line-height:1;cursor:pointer}
      #koy-observation-history .oh-add{margin:5px 20px 16px;border:1px dashed rgba(204,225,239,.14);background:#171e28;color:#8d98a6;border-radius:999px;padding:9px 14px;font-size:10px;font-weight:600;cursor:pointer}
      #koy-observation-history .oh-add:hover{color:#e7eef3;border-color:rgba(125,211,215,.3)}
      #koy-observation-history .oh-chart-list{display:grid;gap:8px;padding:0 20px 20px}
      #koy-observation-history .oh-chart{background:#202832;border-radius:17px;padding:17px 16px 13px;min-width:0}
      #koy-observation-history .oh-chart-head{display:flex;justify-content:space-between;gap:10px;align-items:center}
      #koy-observation-history .oh-chart-name{display:flex;align-items:center;gap:8px;color:#aeb7c2;font-size:12px}
      #koy-observation-history .oh-chart-dot{width:9px;height:9px;border-radius:50%}
      #koy-observation-history .oh-value{font:700 15px Manrope,sans-serif;color:var(--c)}
      #koy-observation-history .oh-graph{height:160px;margin-top:7px;position:relative}
      #koy-observation-history svg{width:100%;height:100%;display:block;overflow:visible}
      #koy-observation-history .oh-grid{stroke:rgba(200,220,235,.10);stroke-width:1}
      #koy-observation-history .oh-line{fill:none;stroke:var(--c);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
      #koy-observation-history .oh-range{font-size:9px;color:#8d99a6;margin-top:1px}
      #koy-observation-history .oh-axis{display:flex;justify-content:space-between;color:#7e8a98;font-size:8px;margin-top:7px}
      #koy-observation-history .oh-empty{padding:38px 8px;text-align:center;color:#8b98a6;font-size:11px}
      #koy-observation-history .oh-picker-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:9990;display:none}
      #koy-observation-history .oh-picker-backdrop.open{display:block}
      #koy-observation-history .oh-picker{position:fixed;left:0;right:0;bottom:0;z-index:9991;background:#1b232f;border-radius:25px 25px 0 0;border:1px solid rgba(204,225,239,.12);box-shadow:0 -25px 70px rgba(0,0,0,.45);max-height:78vh;overflow:auto;transform:translateY(100%);transition:transform .18s ease}
      #koy-observation-history .oh-picker.open{transform:translateY(0)}
      #koy-observation-history .oh-picker-head{padding:22px 24px 16px;border-bottom:1px solid rgba(204,225,239,.08);font:600 16px Manrope,sans-serif}
      #koy-observation-history .oh-option{display:flex;align-items:center;gap:12px;width:100%;padding:15px 24px;border:0;border-bottom:1px solid rgba(204,225,239,.07);background:transparent;color:#e1e8ed;text-align:left;font-size:13px;cursor:pointer}
      #koy-observation-history .oh-option:last-child{border-bottom:0}
      #koy-observation-history .oh-option.disabled{color:#66727f;cursor:default}
      #koy-observation-history .oh-option-dot{width:10px;height:10px;border-radius:50%;background:var(--c);flex:none}
      @media(max-width:560px){
        #koy-observation-history .oh-head{padding:17px 15px 0}
        #koy-observation-history .oh-toggle-row{align-items:stretch;flex-direction:column}
        #koy-observation-history .oh-segment,#koy-observation-history .oh-zone{width:100%}
        #koy-observation-history .oh-segment button,#koy-observation-history .oh-zone button{flex:1}
        #koy-observation-history .oh-vars{padding:12px 15px 4px}
        #koy-observation-history .oh-add{margin-left:15px;margin-right:15px}
        #koy-observation-history .oh-chart-list{padding-left:15px;padding-right:15px}
        #koy-observation-history .oh-chart{padding:15px 13px 12px;border-radius:15px}
        #koy-observation-history .oh-graph{height:145px}
      }
    `;
    document.head.appendChild(style);
  }

  function build() {
    if ($("koy-observation-history")) return;
    const anchor = document.querySelector("#station-history-panel");
    if (!anchor) return;
    const section = document.createElement("section");
    section.id = "koy-observation-history";
    section.innerHTML = `
      <div class="oh-panel">
        <div class="oh-head">
          <div class="oh-title">Observation History</div>
          <div class="oh-sub">Çanakçı MGM · son ölçümler</div>
          <div class="oh-toggle-row">
            <div class="oh-segment" id="oh-window">
              <button data-hours="24" class="active">24h</button>
              <button data-hours="48">48h</button>
              <button data-hours="168">7d</button>
              <button data-hours="720">30d</button>
            </div>
            <div class="oh-zone" id="oh-zone">
              <button data-zone="local" class="active">Local</button>
              <button data-zone="utc">UTC</button>
            </div>
          </div>
        </div>
        <div class="oh-vars" id="oh-vars"></div>
        <button class="oh-add" id="oh-add">＋ Add variable</button>
        <div class="oh-chart-list" id="oh-charts"><div class="oh-empty">Geçmiş veriler yükleniyor…</div></div>
      </div>
      <div class="oh-picker-backdrop" id="oh-backdrop"></div>
      <div class="oh-picker" id="oh-picker" aria-label="Add variable">
        <div class="oh-picker-head">Add variable</div>
        <div id="oh-options"></div>
      </div>
    `;
    anchor.parentNode.insertBefore(section, anchor.nextSibling);
    bind();
    renderChips();
    renderCharts();
    load();
  }

  function bind() {
    $("oh-window").addEventListener("click", e => {
      const b=e.target.closest("button[data-hours]"); if(!b)return;
      state.windowHours=Number(b.dataset.hours);
      $("oh-window").querySelectorAll("button").forEach(x=>x.classList.toggle("active",x===b));
      load();
    });
    $("oh-zone").addEventListener("click", e => {
      const b=e.target.closest("button[data-zone]"); if(!b)return;
      state.zone=b.dataset.zone;
      $("oh-zone").querySelectorAll("button").forEach(x=>x.classList.toggle("active",x===b));
      renderCharts();
    });
    $("oh-add").addEventListener("click", openPicker);
    $("oh-backdrop").addEventListener("click", closePicker);
    $("oh-options").addEventListener("click", e => {
      const b=e.target.closest("button[data-variable]"); if(!b)return;
      const id=b.dataset.variable;
      if(state.selected.includes(id)) return;
      state.selected.push(id);
      closePicker();
      renderChips();
      renderCharts();
    });
    $("oh-vars").addEventListener("click", e => {
      const b=e.target.closest("button[data-remove]"); if(!b)return;
      state.selected=state.selected.filter(id=>id!==b.dataset.remove);
      renderChips();
      renderCharts();
    });
  }

  function openPicker() {
    state.openPicker=true;
    $("oh-options").innerHTML=VARIABLES.map(v => {
      const disabled=state.selected.includes(v.id);
      return `<button class="oh-option${disabled?" disabled":""}" data-variable="${v.id}" ${disabled?"disabled":""}>
        <span class="oh-option-dot" style="--c:${v.color}"></span>${esc(v.label)}
      </button>`;
    }).join("");
    $("oh-backdrop").classList.add("open");
    $("oh-picker").classList.add("open");
  }
  function closePicker() {
    state.openPicker=false;
    $("oh-backdrop").classList.remove("open");
    $("oh-picker").classList.remove("open");
  }

  function renderChips() {
    $("oh-vars").innerHTML=state.selected.map(id=>{
      const v=VARIABLES.find(x=>x.id===id); if(!v)return "";
      return `<span class="oh-chip" style="--c:${v.color}"><span class="oh-chip-dot"></span>${esc(v.label)}<button class="oh-chip-x" data-remove="${v.id}" aria-label="Remove ${esc(v.label)}">×</button></span>`;
    }).join("");
  }

  async function load() {
    const key=state.windowHours;
    if(state.cache.has(key)){renderCharts();return;}
    $("oh-charts").innerHTML='<div class="oh-empty">Geçmiş veriler yükleniyor…</div>';
    try {
      const bucket=key<=48?10:key<=168?30:key<=720?60:120;
      const url=API+"/history-graph/canakci?hours="+key+"&bucket="+bucket+"&v="+Date.now();
      const response=await fetch(url,{cache:"no-store"});
      if(!response.ok) throw new Error("HTTP "+response.status);
      const data=await response.json();
      if(!data.ok) throw new Error(data.error||"History API error");
      state.cache.set(key,data);
      renderCharts();
    } catch(error) {
      $("oh-charts").innerHTML='<div class="oh-empty">Geçmiş veriler şu anda alınamadı.</div>';
      console.error("Köy Observation History:",error);
    }
  }

  function renderCharts() {
    const data=state.cache.get(state.windowHours);
    if(!data || !Array.isArray(data.samples) || !data.samples.length){
      $("oh-charts").innerHTML='<div class="oh-empty">Bu dönem için kayıt bulunamadı.</div>';
      return;
    }
    $("oh-charts").innerHTML=state.selected.map(id=>{
      const v=VARIABLES.find(x=>x.id===id); if(!v)return "";
      const points=data.samples.map(s=>({time:s.bucket_utc,value:Number(s[v.field])})).filter(p=>Number.isFinite(p.value));
      return chart(v,points,state.windowHours);
    }).join("");
  }

  function chart(v,points,hours) {
    if(!points.length) return `<article class="oh-chart" style="--c:${v.color}"><div class="oh-chart-name"><span class="oh-chart-dot" style="background:${v.color}"></span>${esc(v.label)}</div><div class="oh-empty">Bu değişken için veri yok.</div></article>`;
    const width=1000,height=180,pad={l:8,r:8,t:8,b:25};
    const values=points.map(p=>p.value);
    let lo=Math.min(...values),hi=Math.max(...values);
    if(lo===hi){lo-=1;hi+=1;}
    const x=i=>pad.l+(i/(points.length-1||1))*(width-pad.l-pad.r);
    const y=v.id.includes("precipitation")? (val=>pad.t+(1-(val/Math.max(hi,0.001)))*(height-pad.t-pad.b)) : (val=>pad.t+(1-(val-lo)/(hi-lo))*(height-pad.t-pad.b));
    const path=points.map((p,i)=>(i?"L":"M")+x(i).toFixed(2)+" "+y(p.value).toFixed(2)).join(" ");
    const grid=[0.25,0.5,0.75].map(f=>`<line class="oh-grid" x1="${pad.l}" x2="${width-pad.r}" y1="${(pad.t+f*(height-pad.t-pad.b)).toFixed(1)}" y2="${(pad.t+f*(height-pad.t-pad.b)).toFixed(1)}"></line>`).join("");
    const last=points[points.length-1];
    const min=Math.min(...values),max=Math.max(...values);
    const axis=[points[0],points[Math.floor(points.length/2)],points[points.length-1]].map(p=>formatAxis(p.time,hours));
    return `<article class="oh-chart" style="--c:${v.color}">
      <div class="oh-chart-head"><div class="oh-chart-name"><span class="oh-chart-dot" style="background:${v.color}"></span>${esc(v.label)}</div><div class="oh-value">${fmt(last.value,v.digits)} ${v.unit}</div></div>
      <div class="oh-graph"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${esc(v.label)} history chart">${grid}<path class="oh-line" style="--c:${v.color}" d="${path}"></path></svg></div>
      <div class="oh-range">Lowest ${fmt(min,v.digits)} · Highest ${fmt(max,v.digits)} ${v.unit}</div>
      <div class="oh-axis"><span>${esc(axis[0])}</span><span>${esc(axis[1])}</span><span>${esc(axis[2])}</span></div>
    </article>`;
  }

  function start() {
    injectStyle();
    build();
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",start);
  else start();
})();