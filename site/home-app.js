const __hideEmptyBadges=()=>{document.querySelectorAll('[class*="badge"],[class*="Badge"]').forEach(el=>{const text=(el.textContent||"").replace(/\u00a0/g," ").trim();const hasDataBadge=el.dataset.min!==undefined&&el.dataset.max!==undefined;if(!text&&!hasDataBadge){if(!el.hasAttribute("hidden"))el.dataset.emptyBadgeHidden="1";el.hidden=true;}else if((text||hasDataBadge)&&el.dataset.emptyBadgeHidden==="1"){el.hidden=false;delete el.dataset.emptyBadgeHidden;}})};const __emptyBadgeObserver=new MutationObserver(__hideEmptyBadges);__emptyBadgeObserver.observe(document.body,{subtree:true,childList:true,characterData:true});__hideEmptyBadges();


    // Keep the full F180 payload for long-range charts and briefings; the dedicated 72-hour table reads /gfs/f72 separately.
    const DATA_API_BASE=(window.ISTANBUL_GFS_API_BASE||window.location.origin);
    const DATA_URL=DATA_API_BASE+"/gfs/latest";
    const DATA_URL_FALLBACK="https://gfs-watch-istanbul-gfs.muhsin-ulusoy.workers.dev/gfs/latest";
    async function fetchForecastData(path){
      const primary=DATA_API_BASE+path;
      try{
        const response=await fetch(primary,{cache:"no-store"});
        if(response.ok)return response;
      }catch(_){}
      if(DATA_API_BASE!==window.location.origin){
        try{
          const response=await fetch(window.location.origin+path,{cache:"no-store"});
          if(response.ok)return response;
        }catch(_){}
      }
      const fallback=DATA_URL_FALLBACK.replace("/gfs/latest",path);
      return fetch(fallback,{cache:"no-store",mode:"cors"});
    }
    // Live ECMWF source: MeteoPT point series at 41.0901N, 28.9436E.
    // The gateway calls the canonical Istanbul ECMWF Worker endpoint, which
    // fetches the same MeteoPT source and fills the current forecast payload.
    const ECMWF_DATA_URL="/api/ecmwf/latest";
    function applyAppVersion(doc){
      if(!doc||!doc.name||!doc.version)return;
      document.querySelectorAll("[data-app-name]").forEach(node=>{node.textContent=doc.name;});
      document.querySelectorAll("[data-app-version]").forEach(node=>{node.textContent=doc.version;});
    }
    fetch("./version.json",{cache:"no-store"}).then(response=>response.ok?response.json():null).then(applyAppVersion).catch(()=>{});
    const STATIONS_API=(window.GFS_WATCH_API_BASE||window.location.origin)+"/api";
    const STATIONS_URL=STATIONS_API+"/stations";
    const STATION_HISTORY_API=key=>STATIONS_API+"/history/"+encodeURIComponent(key)+"?hours=72";
    async function fetchStationsApi(path){
      const primary=STATIONS_API+path;
      const response=await fetch(primary,{cache:"no-store"});
      if(!response.ok)throw new Error("İstasyon API HTTP "+response.status);
      return response;
    }
    // No forecast-verification.json is published yet; avoid repeated 404s until the calibration archive is generated.
    const VERIFY_URL=null;
    let enkaStationObservation=null,eyupsultanStationObservation=null,sisliStationObservation=null,activeStation="eyupsultan";
    // HARD DEFAULT: homepage always starts on Eyüpsultan on every device.
    // Do not restore a previously stored ENKA/Şişli choice during initial page load.
    try{ localStorage.removeItem("istanbul-hava-station"); }catch(_){}
    let enkaStationHistorySamples=[],eyupsultanStationHistorySamples=[],sisliStationHistorySamples=[];
    let eyupsultanStationRainHistorySamples=[],sisliStationRainHistorySamples=[];
    let verificationDoc=null;
    let forecastData=null;
    const $=id=>document.getElementById(id);

    // ENKA Balmumcu camera: refresh the JPEG every 90 seconds once it scrolls into view.
    // A timed-out request keeps the last good frame instead of leaving an empty panel.
    (function initEnkaCamera(){
      const image=$("enka-camera-image");
      const updated=$("enka-camera-updated");
      const status=$("enka-camera-status");
      const panel=$("enka-camera-panel");
      const placeholder=$("enka-camera-placeholder");
      if(!image||!panel) return;
      const source=image.dataset.cameraSrc||"https://w.enka.com/camhd/cam1/c.jpg";
      const timeoutMs=12000;
      let seq=0;
      let started=false;
      let lastFrame="";
      let requestToken=0;
      const showFrame=(url)=>{
        lastFrame=url;
        image.src=url;
        image.classList.remove("is-pending");
        if(placeholder) placeholder.hidden=true;
      };
      const showFallback=(message)=>{
        if(lastFrame){
          if(image.getAttribute("src")!==lastFrame) image.src=lastFrame;
          image.classList.remove("is-pending");
          if(placeholder) placeholder.hidden=true;
          if(updated) updated.textContent="Son kare gösteriliyor";
        }else{
          image.classList.add("is-pending");
          image.removeAttribute("src");
          if(placeholder) placeholder.hidden=false;
          if(updated) updated.textContent="Görüntü bekleniyor";
        }
        if(status) status.textContent=message;
      };
      const refresh=()=>{
        const token=++requestToken;
        seq++;
        const url=source+(source.indexOf("?")>=0?"&":"?")+"cb="+Date.now()+"-"+seq;
        const probe=new Image();
        let settled=false;
        const timer=window.setTimeout(()=>{
          if(settled||token!==requestToken) return;
          settled=true;
          probe.onload=null;
          probe.onerror=null;
          showFallback(lastFrame?"Yenileme zaman aşımı · son kare":"Görüntü zaman aşımına uğradı");
        },timeoutMs);
        probe.onload=()=>{
          if(settled||token!==requestToken) return;
          settled=true;
          window.clearTimeout(timer);
          showFrame(url);
          if(updated) updated.textContent="Son yenileme: "+new Intl.DateTimeFormat("tr-TR",{hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(new Date());
          if(status) status.textContent="90 sn'de bir yenilenir";
        };
        probe.onerror=()=>{
          if(settled||token!==requestToken) return;
          settled=true;
          window.clearTimeout(timer);
          showFallback(lastFrame?"Kamera görüntüsü alınamadı · son kare":"Kamera görüntüsü alınamadı");
        };
        probe.referrerPolicy="no-referrer";
        probe.src=url;
      };
      const start=()=>{
        if(started) return;
        started=true;
        refresh();
        setInterval(refresh,90000);
      };
      if("IntersectionObserver" in window){
        const observer=new IntersectionObserver(entries=>{
          if(entries.some(entry=>entry.isIntersecting||entry.intersectionRatio>0)){
            start();
            observer.disconnect();
          }
        },{rootMargin:"160px 0px",threshold:0});
        observer.observe(panel);
      }else start();
    })();
    const numeric=value=>typeof value==="number"&&Number.isFinite(value);
    const windDirectionTr={
      N:"Kuzey",NNE:"Kuzey-kuzeydoğu",NE:"Kuzeydoğu",ENE:"Doğu-kuzeydoğu",
      E:"Doğu",ESE:"Doğu-güneydoğu",SE:"Güneydoğu",SSE:"Güney-güneydoğu",
      S:"Güney",SSW:"Güney-güneybatı",SW:"Güneybatı",WSW:"Batı-güneybatı",
      W:"Batı",WNW:"Batı-kuzeybatı",NW:"Kuzeybatı",NNW:"Kuzey-kuzeybatı"
    };
    const fmt=(value,digits=1)=>numeric(value)?value.toLocaleString("tr-TR",{minimumFractionDigits:digits,maximumFractionDigits:digits}):"—";
    const esc=value=>String(value == null ? "" : value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
    const timeTR=value=>new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",minute:"2-digit"}).format(new Date(value));
    const timeUTC=value=>new Intl.DateTimeFormat("tr-TR",{timeZone:"UTC",day:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(value));
    // Single canonical MeteoPT display clock. The 180h table and every live forecast badge use this exact conversion.
    // MeteoPT table convention: subtract 3h from the published valid timestamp before formatting as TSİ.
    const meteoptCanonicalDateLabel=value=>{
      const date=new Date(new Date(value).getTime()-3*3600000);
      const weekday=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",weekday:"long"}).format(date);
      const clock=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(date);
      return weekday.charAt(0).toLocaleUpperCase("tr-TR")+weekday.slice(1)+" · "+clock+" TSİ";
    };
    window.__METEOPT_CANONICAL_DATE_LABEL=meteoptCanonicalDateLabel;
    const forecastClockUTC=value=>meteoptCanonicalDateLabel(value).split(" · ")[1].replace(" TSİ","");
    const symbolFor=rain=>rain>=5?"🌧️":rain>=1?"🌦️":"⛅";
    function renderDaily(items,targetId="daily-grid"){
      const grid=$(targetId);
      if(!Array.isArray(items)||!items.length){grid.innerHTML='<div class="chart-empty">Günlük tahmin verisi bulunamadı.</div>';return;}
      grid.innerHTML=items.map(item=>{
        const date=new Date(item.date_istanbul+"T12:00:00+03:00");
        const day=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",weekday:"short"}).format(date);
        const rain=numeric(item.precipitation_total_mm)?item.precipitation_total_mm:0;
        return '<article class="day"><div class="day-name">'+esc(day)+'</div><div class="day-icon">'+symbolFor(rain)+'</div><div class="day-range">'+fmt(item.temperature_max_c,0)+'° <span>'+fmt(item.temperature_min_c,0)+'°</span></div><div class="day-rain">☂ '+fmt(rain,1)+' mm</div><div class="day-wind">↗ '+fmt(item.wind_speed_max_10m_kmh,0)+' km/sa</div></article>';
      }).join("");
    }
    function pressureRegionName(latitude,longitude){
      const lat=Number(latitude),lon=Number(longitude);
      if(lat>=41.45&&lat<=42.05&&lon>=32.9&&lon<=34.2)return "Kastamonu · Küre/Azdavay çevresi";
      if(lat>=39.2&&lat<=40.9&&lon>=40.2&&lon<=42.6)return "Erzurum · Tortum çevresi";
      if(lat>=38.0&&lat<=39.3&&lon>=35.0&&lon<=36.6)return "Kayseri · Bünyan/Sarız çevresi";
      if(lat>=41.0&&lat<=42.2&&lon>=32.0&&lon<=34.8)return "Batı Karadeniz · Kastamonu çevresi";
      if(lat>=39.0&&lat<=41.2&&lon>=40.0&&lon<=43.5)return "Doğu Anadolu · Erzurum çevresi";
      if(lat>=37.8&&lat<=39.5&&lon>=34.5&&lon<=37.5)return "İç Anadolu · Kayseri çevresi";
      if(lat>=42.0&&lat<=44.5&&lon>=40.0&&lon<=45.0)return "Kafkaslar · Gürcistan–Rusya sınır bölgesi";
      if(lat>=43.6&&lat<=48.3&&lon>=20.2&&lon<=29.7)return "Romanya";
      if(lat>=44&&lat<=46.5&&lon>=32.2&&lon<=37)return "Kırım ve kuzey Karadeniz";
      if(lat>=41.2&&lat<=44.2&&lon>=22.3&&lon<=28.2)return "Bulgaristan ve Balkanlar";
      if(lat>=43&&lat<=49.2&&lon>=37&&lon<=48.5)return "Güney Rusya · Kuzey Kafkasya";
      if(lat>=40.5&&lat<=47.5&&lon>=27&&lon<=42.5)return lon<33?"Batı Karadeniz":lon<37?"Orta Karadeniz":"Doğu Karadeniz";
      if(lat>=40&&lat<=42.3&&lon>=26&&lon<=30.5)return "Marmara ve Trakya";
      if(lat>=36.5&&lat<=40&&lon>=26&&lon<=30)return "Ege Bölgesi";
      if(lat>=37&&lat<=40.8&&lon>=30&&lon<=36.5)return "İç Anadolu";
      if(lat>=30&&lat<36.5&&lon>=27&&lon<=37.5)return "Doğu Akdeniz";
      if(lat>=39&&lat<=46&&lon>=13&&lon<=20)return "Adriyatik ve Batı Balkanlar";
      if(lat>=45&&lon<32)return "Doğu Avrupa · Romanya-Ukrayna";
      return "Bölgesel analiz alanı";
    }
    function pressureRelativeToIstanbul(latitude,longitude){
      const rad=value=>value*Math.PI/180;
      const lat1=rad(41.014),lat2=rad(Number(latitude));
      const dLat=lat2-lat1,dLon=rad(((Number(longitude)-28.95+180)%360+360)%360-180);
      const h=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
      const distance=6371*2*Math.asin(Math.sqrt(Math.max(0,Math.min(1,h))));
      const bearing=(Math.atan2(Math.sin(dLon)*Math.cos(lat2),Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon))*180/Math.PI+360)%360;
      const directions=["kuzey","kuzeydoğu","doğu","güneydoğu","güney","güneybatı","batı","kuzeybatı"];
      return distance<50?"İstanbul'un yakın çevresinde":"İstanbul'un yaklaşık "+Math.round(distance)+" km "+directions[Math.floor((bearing+22.5)/45)%8]+" yönünde";
    }
    function renderFindings(findings,istanbulPressure,targetId="pressure-findings"){
      const list=$(targetId);
      if(!Array.isArray(findings)||!findings.length){list.innerHTML='<li class="pressure-empty">Bu tahmin döngüsü için bölgesel basınç yorumu bulunmuyor.</li>';return;}
      const items=findings.map(value=>String(value)).filter(value=>!value.includes("Yüksek ve alçak basınç merkezleri bölgesel eğilimi gösterir"));
      list.innerHTML=items.map(text=>'<li><span class="pressure-icon">◈</span><span>'+esc(text)+'</span></li>').join("");
    }
    function buildPressureComment(centers){
      if(!Array.isArray(centers)||!centers.length)return "İstanbul merkezli 2500 km çapındaki alanda GFS deniz seviyesi basıncına göre belirlenen eşiklerde anlamlı bir basınç merkezi bulunmuyor.";
      const highs=centers.filter(c=>c.type==="high").sort((a,b)=>Number(b.pressure_hpa)-Number(a.pressure_hpa));
      const lows=centers.filter(c=>c.type==="low").sort((a,b)=>Number(a.pressure_hpa)-Number(b.pressure_hpa));
      const parts=[];
      if(highs.length){
        const strongest=highs[0];
        const region=pressureRegionName(strongest.latitude,strongest.longitude);
        parts.push("İstanbul merkezli 2500 km çapındaki alanda "+highs.length+" yüksek basınç merkezi öne çıkıyor. En güçlü merkez "+Number(strongest.pressure_hpa).toFixed(1)+" hPa ile "+region+" üzerinde; İstanbul'un yaklaşık "+Number(strongest.distance_km).toFixed(0)+" km "+esc(String(strongest.direction||""))+" yönünde.");
      }
      if(lows.length){
        const strongest=lows[0];
        const region=pressureRegionName(strongest.latitude,strongest.longitude);
        parts.push(lows.length+" alçak basınç merkezi de tespit ediliyor. En belirgin merkez "+Number(strongest.pressure_hpa).toFixed(1)+" hPa ile "+region+" üzerinde.");
      }else{
        parts.push("Bu analiz alanında 1013 hPa ve altına inen belirgin bir alçak basınç merkezi yok.");
      }
      const dirs=centers.map(c=>String(c.direction||"")).filter(Boolean);
      const east=dirs.filter(d=>["D","DGD","DKD"].includes(d)).length;
      if(east===centers.length)parts.push("Merkezlerin tamamının İstanbul'un doğu-kuzeydoğu tarafında toplanması, bölgesel basınç alanında doğu sektörü yüksek basınç açısından baskın olduğunu gösteriyor.");
      return parts.join(" ");
    }
    function renderPressureText(centers){
      const list=$("pressure-findings");
      if(!list)return;
      if(!Array.isArray(centers)||!centers.length){
        list.innerHTML='<li class="pressure-empty">'+buildPressureComment([])+'</li>';
        return;
      }
      const comment=buildPressureComment(centers);
      list.innerHTML='<li class="pressure-comment">'+esc(comment)+'</li>'+centers.map(center=>{
        const isLow=center.type==="low";
        const label=isLow?"Alçak basınç":"Yüksek basınç";
        const icon=isLow?"↘":"↗";
        const region=pressureRegionName(center.latitude,center.longitude);
        return '<li class="pressure-center-item"><span class="pressure-icon '+(isLow?"low":"high")+'">'+icon+'</span><span><strong>'+label+' · '+esc(region)+'</strong><br><span class="pressure-center-value">'+Number(center.pressure_hpa).toFixed(1)+' hPa</span> · İstanbul\'a '+Number(center.distance_km).toFixed(0)+' km '+esc(String(center.direction||""))+' yönünde</span></li>';
      }).join("");
    }
    function pressureForecastDateLabel(value){
      const d=new Date(value);
      const day=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"2-digit"}).format(d);
      const weekday=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",weekday:"short"}).format(d);
      const hour=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(d);
      return day+" "+weekday+" · "+hour;
    }
    function pressureForecastRegion(center){
      return pressureRegionName(center.latitude,center.longitude);
    }
    function renderPressureForecast(payload){
      const lows=$("pressure-cyclone-forecast"), highs=$("pressure-high-forecast");
      const steps=payload&&Array.isArray(payload.forecast_steps)?payload.forecast_steps:[];
      const tracks=payload&&Array.isArray(payload.tracks)?payload.tracks:[];
      const checkpointEl=$("pressure-milestones");
      if(!steps.length){
        if(lows)lows.innerHTML='<li>120 saatlik GFS merkez tahmini bekleniyor.</li>';
        if(highs)highs.innerHTML='<li>120 saatlik GFS yüksek basınç tahmini bekleniyor.</li>';
        return;
      }
      const bestAt=(step,type)=>{
        const cs=(step&&step.centers||[]).filter(c=>c.type===type);
        if(!cs.length)return null;
        cs.sort((a,b)=>type==="low"?Number(a.pressure_hpa)-Number(b.pressure_hpa):Number(b.pressure_hpa)-Number(a.pressure_hpa));
        return cs[0];
      };
      const validDayLabel=(step)=>{
        if(!step||!step.valid_time_utc)return "—";
        const d=new Date(step.valid_time_utc);
        const parts=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"long",weekday:"long"}).formatToParts(d);
        const day=parts.find(p=>p.type==="day")?.value||"";
        const month=parts.find(p=>p.type==="month")?.value||"";
        const weekday=parts.find(p=>p.type==="weekday")?.value||"";
        return day+" "+month+" · "+weekday;
      };
      const region=(c)=>{
        if(!c)return "—";
        return pressureForecastRegion(c);
      };
      const lifecycleFor=(step,center)=>{
        if(!center||!tracks.length)return null;
        let best=null,bestDistance=Infinity;
        tracks.filter(t=>t.type===center.type&&Array.isArray(t.points)).forEach(track=>{
          track.points.forEach(point=>{
            if(Number(point.forecast_hour)!==Number(step.forecast_hour))return;
            const dlat=Number(point.latitude)-Number(center.latitude);
            const dlon=Number(point.longitude)-Number(center.longitude);
            const distance=Math.hypot(dlat,dlon);
            if(distance<bestDistance){bestDistance=distance;best=point;}
          });
        });
        // Lifecycle belongs to this exact valid time. Do not fall back to the
        // track-level lifecycle, because that would label every forecast time
        // with the same overall track state.
        return best&&best.lifecycle ? (best.lifecycle === "aktif" ? "sabit" : best.lifecycle) : null;
      };
      const lifecycleBadge=(step,center)=>{
        const value=lifecycleFor(step,center);
        if(!value)return "";
        return '<span class="pressure-lifecycle pressure-lifecycle-'+value+'">'+esc(value)+'</span>';
      };
      const lowRows=[],highRows=[];
      [0,12,24,48,72,96,120].forEach(hour=>{
        const step=steps.find(s=>Number(s.forecast_hour)===hour);
        if(!step)return;
        const low=bestAt(step,"low"), high=bestAt(step,"high");
        if(low)lowRows.push("<li><strong>"+validDayLabel(step)+"</strong> · "+esc(region(low))+" · ~"+Number(low.pressure_hpa).toFixed(0)+" hPa "+lifecycleBadge(step,low)+"</li>");
        if(high)highRows.push("<li><strong>"+validDayLabel(step)+"</strong> · "+esc(region(high))+" · ~"+Number(high.pressure_hpa).toFixed(0)+" hPa "+lifecycleBadge(step,high)+"</li>");
      });
      if(lows)lows.innerHTML=lowRows.length?lowRows.join(""):"<li>Belirgin siklon merkezi bulunamadı.</li>";
      if(highs)highs.innerHTML=highRows.length?highRows.join(""):"<li>Belirgin yüksek basınç merkezi bulunamadı.</li>";

      if(checkpointEl){
        const items=[0,12,24,48,72,96,120].map(hour=>{
          const step=steps.find(s=>Number(s.forecast_hour)===hour);
          if(!step)return "";
          const low=bestAt(step,"low"), high=bestAt(step,"high");
          const bits=[];
          if(low)bits.push("🔴 "+esc(region(low))+" "+Number(low.pressure_hpa).toFixed(0)+" hPa");
          if(high)bits.push("🔵 "+esc(region(high))+" "+Number(high.pressure_hpa).toFixed(0)+" hPa");
          return "<li><strong>"+validDayLabel(step)+"</strong> · "+(bits.length?bits.join(" · "):"Belirgin merkez yok")+"</li>";
        }).filter(Boolean);
        checkpointEl.innerHTML='<div class="pressure-summary-title">⏱️ GFS sinoptik gelişim</div><ul class="pressure-list">'+items.join("")+"</ul>";
      }

      const trend=document.getElementById("pressure-trend");
      if(trend){
        const parts=[];
        tracks.filter(t=>t.points&&t.points.length>=2).forEach(t=>{
          const a=t.points[0], b=t.points[t.points.length-1];
          const dp=Number(t.pressure_change_hpa);
          const trendText=t.type==="low"?(dp<=-1?"güçleniyor":dp>=1?"zayıflıyor":"belirgin değişmiyor"):(dp>=1?"güçleniyor":dp<=-1?"zayıflıyor":"belirgin değişmiyor");
          const label=t.type==="low"?"Siklon":"Yüksek basınç";
          parts.push("<span><strong>"+label+":</strong> "+esc(t.lifecycle||trendText)+" ("+dp.toFixed(1)+" hPa / 120 saat); "+Number(t.movement_km).toFixed(0)+" km "+esc(t.movement_direction)+" hareket; tepe adımı +"+Number(t.peak_forecast_hour||0)+" saat.</span>");
        });
        trend.innerHTML="<strong>Hareket ve trend:</strong> "+(parts.length?parts.slice(0,4).join(" "):"120 saatlik merkez hareketi için yeterli iz bulunamadı.");
      }

      const note=document.querySelector(".gfs-pressure-panel .section-note");
      if(note){
        const first=payload.cycle_utc?new Date(payload.cycle_utc):null;
        const last=steps.length?new Date(steps[steps.length-1].valid_time_utc):null;
        const fmtDate=d=>d?new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"2-digit"}).format(d):"—";
        note.innerHTML="Anlık analiz + model tahmini<br>"+fmtDate(first)+"–"+fmtDate(last);
      }
    }
    async function loadGithubPressureCenters(){
      const list=$("pressure-findings");
      if(!list)return;
      try{
        const response=await fetch("./data/gfs-pressure-centers.json?v="+Date.now(),{cache:"no-store",credentials:"same-origin"});
        if(!response.ok)throw new Error("HTTP "+response.status);
        const payload=await response.json();
        renderPressureForecast(payload);
        const analysis=payload&&payload.analysis;
        const centers=analysis&&Array.isArray(analysis.centers)?analysis.centers:[];
        renderPressureText(centers);
        if(centers.length){
          const cycle=payload.cycle_utc?new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(payload.cycle_utc)):"—";
          list.innerHTML += '<li class="pressure-source-note">GitHub Actions · GFS 0.25° GRIB2 · f000 · '+esc(cycle)+' TSİ · 120 saat tahmini aktif</li>';
        }
      }catch(error){
        console.warn("GitHub GFS pressure centers unavailable:",error);
        list.innerHTML='<li class="pressure-empty">GitHub Actions basınç analizi henüz hazır değil.</li>';
      }
    }

    let activeTouchChartTooltip=null;
    let activeTouchChartTooltipTimer=null;
    function clearScheduledTouchChartTooltip(hideFn){
      if(activeTouchChartTooltip!==hideFn)return;
      if(activeTouchChartTooltipTimer!==null)window.clearTimeout(activeTouchChartTooltipTimer);
      activeTouchChartTooltipTimer=null;
      activeTouchChartTooltip=null;
    }
    function dismissActiveTouchChartTooltip(){
      const hide=activeTouchChartTooltip;
      if(activeTouchChartTooltipTimer!==null)window.clearTimeout(activeTouchChartTooltipTimer);
      activeTouchChartTooltipTimer=null;
      activeTouchChartTooltip=null;
      if(hide)hide();
    }
    function scheduleTouchChartTooltipDismiss(hideFn){
      if(activeTouchChartTooltip&&activeTouchChartTooltip!==hideFn){
        const previous=activeTouchChartTooltip;
        if(activeTouchChartTooltipTimer!==null)window.clearTimeout(activeTouchChartTooltipTimer);
        activeTouchChartTooltipTimer=null;
        activeTouchChartTooltip=null;
        previous();
      }
      if(activeTouchChartTooltipTimer!==null)window.clearTimeout(activeTouchChartTooltipTimer);
      activeTouchChartTooltip=hideFn;
      activeTouchChartTooltipTimer=window.setTimeout(dismissActiveTouchChartTooltip,2800);
    }
    document.addEventListener("pointerdown",event=>{
      if(event.pointerType==="touch"&&!event.target.closest(".chart-hit-area,.station-chart-hit-area"))dismissActiveTouchChartTooltip();
    },{passive:true});
    window.addEventListener("scroll",dismissActiveTouchChartTooltip,{passive:true});

    const chartDateTimeTR=value=>{
      const date=new Date(value);
      const dayMonth=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit"}).format(date);
      const clock=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(date);
      return dayMonth+" "+clock;
    };
    // GFS forecast display convention: the forecast UTC clock is shown as TSİ
    // without applying the Istanbul +03 offset a second time. Thus a 12Z run's
    // Step 3 (15Z) is displayed as 15 TSİ, not 18 TSİ.
    const forecastDateTimeTSI=value=>{
      const date=new Date(value);
      const dayMonth=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"2-digit"}).format(date);
      const weekday=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",weekday:"long"}).format(date);
      const clock=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(date);
      return dayMonth+" "+weekday+" · "+clock+" TSİ";
    };
    function attachForecastChartTooltip(container,svg,coords,temperature,width,height,top,bottom,isEcmwf=false){
      const ns="http://www.w3.org/2000/svg";
      const tooltip=document.createElement("div");
      tooltip.className="chart-tooltip";
      tooltip.hidden=true;
      tooltip.setAttribute("role","tooltip");
      const tooltipLayer=container.closest(".chart-card")||container;
      tooltipLayer.appendChild(tooltip);

      const cursorLine=document.createElementNS(ns,"line");
      cursorLine.setAttribute("class","chart-crosshair");
      cursorLine.setAttribute("y1",String(top));
      cursorLine.setAttribute("y2",String(height-bottom));
      cursorLine.setAttribute("stroke","#e8fbf7");
      cursorLine.setAttribute("stroke-width","1");
      cursorLine.setAttribute("stroke-dasharray","3 4");
      cursorLine.setAttribute("opacity",".78");
      cursorLine.setAttribute("visibility","hidden");

      const cursorDot=document.createElementNS(ns,"circle");
      cursorDot.setAttribute("class","chart-crosshair");
      cursorDot.setAttribute("r","5");
      cursorDot.setAttribute("fill",temperature?"#7dd3d7":"#8abce8");
      cursorDot.setAttribute("stroke","#f4ffff");
      cursorDot.setAttribute("stroke-width","2");
      cursorDot.setAttribute("visibility","hidden");
      svg.appendChild(cursorLine);
      svg.appendChild(cursorDot);

      const hitArea=document.createElementNS(ns,"rect");
      hitArea.setAttribute("class","chart-hit-area");
      hitArea.setAttribute("x","48");
      hitArea.setAttribute("y",String(top));
      hitArea.setAttribute("width",String(width-48-18));
      hitArea.setAttribute("height",String(height-top-bottom));
      hitArea.setAttribute("aria-label","Grafikte bir noktaya dokunarak tarih, saat ve tahmin değerini görüntüleyin");
      hitArea.setAttribute("tabindex","0");
      hitArea.style.touchAction="pan-y";
      hitArea.style.webkitTapHighlightColor="transparent";
      svg.appendChild(hitArea);

      const hideTooltip=()=>{
        clearScheduledTouchChartTooltip(hideTooltip);
        tooltip.hidden=true;
        cursorLine.setAttribute("visibility","hidden");
        cursorDot.setAttribute("visibility","hidden");
      };
      const showPoint=point=>{
        if(!point)return;
        cursorLine.setAttribute("x1",String(point.x));
        cursorLine.setAttribute("x2",String(point.x));
        cursorDot.setAttribute("cx",String(point.x));
        cursorDot.setAttribute("cy",String(point.y));
        cursorLine.setAttribute("visibility","visible");
        cursorDot.setAttribute("visibility","visible");

        const valueLabel=temperature
          ? "Sıcaklık: "+fmt(point.value,1)+" °C"
          : "Yağış: "+fmt(point.value,2)+" mm";
        const forecastFormatter=isEcmwf?chartDateTimeTR:forecastDateTimeTSI;
        const intervalLabel=!temperature&&point.intervalStart
          ? '<div class="chart-tooltip-meta">Yağış aralığı: '+esc(forecastFormatter(point.intervalStart))+' – '+esc(forecastFormatter(point.date))+(isEcmwf?" TSİ":"")+'</div>'
          : "";
        const intervalDuration=!temperature&&point.intervalHours
          ? '<div class="chart-tooltip-meta">'+point.intervalHours+' saatlik yağış dilimi</div>'
          : "";
        tooltip.innerHTML=
          '<div class="chart-tooltip-time">'+esc(forecastFormatter(point.date))+'</div>'+
          '<div class="chart-tooltip-value">'+esc(valueLabel)+'</div>'+
          intervalLabel+
          '<div class="chart-tooltip-meta">Tahmin adımı: +'+esc(point.forecastHour)+' saat</div>'+
          intervalDuration;
        tooltip.hidden=false;

        const layerRect=tooltipLayer.getBoundingClientRect();
        const svgRect=svg.getBoundingClientRect();
        const localX=(point.x/width)*svgRect.width+(svgRect.left-layerRect.left);
        const localY=(point.y/height)*svgRect.height+(svgRect.top-layerRect.top);
        const tooltipWidth=tooltip.offsetWidth;
        const tooltipHeight=tooltip.offsetHeight;
        const edgePadding=8;
        const gap=10;
        let desiredLeft=localX-tooltipWidth/2;
        // Keep the full popup visible: open left of points near the right edge,
        // and right of points near the left edge.
        if(localX+tooltipWidth/2>layerRect.width-edgePadding){
          desiredLeft=localX-tooltipWidth-gap;
        }else if(localX-tooltipWidth/2<edgePadding){
          desiredLeft=localX+gap;
        }
        const maxLeft=Math.max(edgePadding,layerRect.width-tooltipWidth-edgePadding);
        const clampedLeft=Math.min(maxLeft,Math.max(edgePadding,desiredLeft));
        const spaceAbove=localY-tooltipHeight-gap;
        const showBelow=spaceAbove<8;
        const desiredTop=showBelow?localY+gap:spaceAbove;
        const maxTop=Math.max(8,layerRect.height-tooltipHeight-8);
        tooltip.style.left=clampedLeft+"px";
        tooltip.style.top=Math.min(maxTop,Math.max(8,desiredTop))+"px";
        tooltip.classList.toggle("below",showBelow);
      };
      const selectNearestPoint=event=>{
        const rect=svg.getBoundingClientRect();
        if(!rect.width)return;
        const chartX=(event.clientX-rect.left)*(width/rect.width);
        let nearest=coords[0],distance=Math.abs(coords[0].x-chartX);
        for(let index=1;index<coords.length;index++){
          const candidateDistance=Math.abs(coords[index].x-chartX);
          if(candidateDistance<distance){
            nearest=coords[index];
            distance=candidateDistance;
          }
        }
        showPoint(nearest);
      };

      hitArea.addEventListener("pointermove",event=>{
        if(event.pointerType==="touch"){
          selectNearestPoint(event);
          scheduleTouchChartTooltipDismiss(hideTooltip);
          return;
        }
        selectNearestPoint(event);
      });
      hitArea.addEventListener("pointerdown",event=>{
        selectNearestPoint(event);
        if(event.pointerType==="touch"){
          try{hitArea.setPointerCapture(event.pointerId);}catch(_){}
          scheduleTouchChartTooltipDismiss(hideTooltip);
        }
      });
      hitArea.addEventListener("pointerup",event=>{
        if(event.pointerType==="touch")scheduleTouchChartTooltipDismiss(hideTooltip);
      });
      hitArea.addEventListener("pointerleave",event=>{
        if(event.pointerType!=="touch")hideTooltip();
      });
      hitArea.addEventListener("pointercancel",hideTooltip);
      hitArea.addEventListener("keydown",event=>{
        if(event.key!=="ArrowLeft"&&event.key!=="ArrowRight")return;
        event.preventDefault();
        const currentX=Number(cursorDot.getAttribute("cx"));
        let currentIndex=coords.findIndex(point=>point.x===currentX);
        if(currentIndex<0)currentIndex=0;
        currentIndex=Math.max(0,Math.min(coords.length-1,currentIndex+(event.key==="ArrowRight"?1:-1)));
        showPoint(coords[currentIndex]);
      });
    }
    function renderChart(metric,targetId,sourceData=forecastData){
      const container=$(targetId);
      const points=sourceData&&sourceData.forecast_6_hourly;
      const temperature=metric==="temperature";
      const isEcmwf=sourceData&&sourceData.schema==="gfs-watch.ecmwf-eps.v1";
      const field=temperature?"temperature_2m_c":"precipitation_6h_mm";
      const title=temperature?"2 m sıcaklık · °C":(isEcmwf?"Tahmin adımı yağış birikimi · mm":"3 saatlik toplam yağış · mm");
      const counter=$(isEcmwf?(temperature?"ecmwf-temperature-count":"ecmwf-precipitation-count"):(temperature?"temperature-count":"precipitation-count"));
      if(!Array.isArray(points)){container.innerHTML='<div class="chart-empty">Tahmin verisi bulunamadı.</div>';return;}

      // GFS provides hourly data through +120h and then three-hourly data.
      // Display both charts on a uniform three-hour timeline.
      const byLead=points
        .map(point=>({...point,lead:Number(point.forecast_hour)}))
        .filter(point=>Number.isFinite(point.lead))
        .sort((a,b)=>a.lead-b.lead);

      let valid=[];
      if(temperature){
        valid=byLead
          .filter(point=>point.lead%3===0&&numeric(point[field]))
          .map(point=>({
            value:point[field],
            date:point.valid_time_utc,
            forecastHour:point.lead
          }));
      }else if(isEcmwf){
        valid=byLead.slice(1).map((endpoint,index)=>{
          const startPoint=byLead[index];
          return {
            value:endpoint.precipitation_6h_mm,
            date:endpoint.valid_time_istanbul,
            forecastHour:endpoint.lead,
            intervalStart:startPoint.valid_time_istanbul,
            intervalHours:Number(endpoint.precipitation_interval_hours)||endpoint.lead-startPoint.lead
          };
        }).filter(point=>numeric(point.value));
      }else{
        const threeHourEndpoints=byLead.filter(point=>point.lead>0&&point.lead%3===0);
        valid=threeHourEndpoints.map(endpoint=>{
          const startLead=endpoint.lead-3;
          const intervalPoints=byLead.filter(point=>point.lead>startLead&&point.lead<=endpoint.lead);
          const expectedCount=endpoint.lead<=120?3:1;
          const measured=intervalPoints.filter(point=>numeric(point[field]));
          const startPoint=byLead.find(point=>point.lead===startLead);
          if(measured.length!==expectedCount||!startPoint)return null;
          return {
            value:measured.reduce((total,point)=>total+point[field],0),
            date:endpoint.valid_time_istanbul,
            forecastHour:endpoint.lead,
            intervalStart:startPoint.valid_time_istanbul,
            intervalHours:3
          };
        }).filter(Boolean);
      }

      counter.textContent=temperature
        ? valid.length+" nokta · 3 saatlik"
        : valid.length+(isEcmwf?" aralık · 3 / 6 saatlik":" aralık · 3 saatlik");
      if(valid.length<2){container.innerHTML='<div class="chart-empty">Bu değişken için yeterli grafik verisi bulunmuyor.</div>';return;}

      const width=900,height=250,left=48,right=18,top=18,bottom=40;
      const min=Math.min(...valid.map(point=>point.value));
      const max=Math.max(...valid.map(point=>point.value));
      const span=(max-min)||1;
      const low=temperature?min-span*.16:Math.max(0,min-span*.12);
      const high=max+span*.16;
      const maxForecastHour=numeric(sourceData.forecast_horizon_hours)
        ? sourceData.forecast_horizon_hours
        : Math.max(...valid.map(point=>point.forecastHour));
      const xFor=hour=>left+(hour/maxForecastHour)*(width-left-right);
      const yFor=value=>top+((high-value)/(high-low))*(height-top-bottom);
      const coords=valid.map(point=>({
        x:xFor(point.forecastHour),
        y:yFor(point.value),
        value:point.value,
        date:point.date,
        forecastHour:point.forecastHour,
        intervalStart:point.intervalStart||null,
        intervalHours:point.intervalHours||0
      }));
      const line=coords.map((point,index)=>(index?"L":"M")+point.x.toFixed(1)+" "+point.y.toFixed(1)).join(" ");
      const last=coords[coords.length-1],first=coords[0];
      const area=line+" L "+last.x.toFixed(1)+" "+(height-bottom)+" L "+first.x.toFixed(1)+" "+(height-bottom)+" Z";
      const ticks=[0,1,2,3].map(index=>low+(high-low)*index/3);
      const grid=ticks.map(value=>{
        const y=yFor(value);
        return '<line x1="'+left+'" y1="'+y+'" x2="'+(width-right)+'" y2="'+y+'" stroke="rgba(194,220,232,.12)" stroke-dasharray="4 6"/><text x="'+(left-10)+'" y="'+(y+4)+'" fill="#91a9b8" font-size="11" text-anchor="end">'+fmt(value,temperature?0:1)+'</text>';
      }).join("");
      const markers=coords.filter((point,index)=>index===0||index===coords.length-1||index%8===0)
        .map(point=>'<circle cx="'+point.x+'" cy="'+point.y+'" r="3.2" fill="#c8f2ec" stroke="#133548" stroke-width="2"/>').join("");
      const labels=[coords[0],coords[Math.floor(coords.length/2)],coords[coords.length-1]]
        .map(point=>'<text x="'+point.x+'" y="'+(height-12)+'" fill="#91a9b8" font-size="7" text-anchor="middle">'+esc(new Intl.DateTimeFormat("tr-TR",{timeZone:"UTC",day:"2-digit"}).format(new Date(point.date)))+'</text>').join("");
      const gradientId=targetId+"-fill";
      const stroke=temperature?"#7dd3d7":"#8abce8";
      container.innerHTML='<svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+title+' grafiği"><defs><linearGradient id="'+gradientId+'" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="'+stroke+'" stop-opacity=".28"/><stop offset="100%" stop-color="'+stroke+'" stop-opacity="0"/></linearGradient></defs>'+grid+'<path d="'+area+'" fill="url(#'+gradientId+')"/><path d="'+line+'" fill="none" stroke="'+stroke+'" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'+markers+labels+'</svg>';
      const svg=container.querySelector("svg");
      attachForecastChartTooltip(container,svg,coords,temperature,width,height,top,bottom,isEcmwf);
    }
    function skillAtLead(lead){
      const doc=verificationDoc&&verificationDoc.stations?verificationDoc.stations[activeStation]:null;
      const hours=doc&&Array.isArray(doc.by_hour)?doc.by_hour:[];
      const exact=hours.find(row=>row.f===lead&&row.pairs>=3);
      return exact||null;
    }
    function skillAtLeadRain(lead){
      const doc=verificationDoc&&verificationDoc.stations?verificationDoc.stations[activeStation]:null;
      const hours=doc&&Array.isArray(doc.rain_by_hour)?doc.rain_by_hour:[];
      const exact=hours.find(row=>row.f===lead&&row.pairs>=3);
      return exact||null;
    }
    function skillColor(pct){
      if(!numeric(pct))return "rgba(125,211,215,.45)";
      if(pct>=90)return "#b6f3d4";
      if(pct>=70)return "#7aa8b8";
      return "#667986";
    }
    function signedMiss(bias,kind){
      if(!numeric(bias))return "yön henüz yok";
      const mag=Math.abs(bias);
      if(kind==="temp"){
        if(mag<0.05)return "yön yok, ortalamada tutmuş";
        return bias>0?"model "+fmt1(mag)+"° sıcak kaçırmış":"model "+fmt1(mag)+"° soğuk kaçırmış";
      }
      if(mag<0.05)return "yön yok, yağış miktarı tutmuş";
      return bias>0?"model "+fmt(mag,2)+" mm fazla yağış vermiş":"model "+fmt(mag,2)+" mm az yağış vermiş";
    }
    let latestRainForecastPoints=[];
    // The station rain badges consume the same F72 payload as the visible MeteoPT table.
    // This keeps the badge and table on one source/cycle instead of maintaining two forecast paths.
    window.addEventListener("meteopt-gfs-f72-updated",event=>{
      const points=event&&event.detail&&Array.isArray(event.detail.points)?event.detail.points:[];
      if(points.length) renderRainWindow(points);
    });
    function renderRainWindow(parsed){
      latestRainForecastPoints=Array.isArray(parsed)?parsed:[];
      const current=$("rain-brief-current"),forecast=$("rain-brief-forecast"),heavy=$("rain-brief-heavy");
      if(!forecast)return;
      // Hard guard: the GFS renderer is forbidden from writing the current-station badge.
      // That badge is exclusively controlled by renderStationCard().
      if(current) current.dataset.source="live-station";
      // The current-rain badge is owned exclusively by the live station observation.
      // The MeteoPT F72 payload is used only for the forecast badge below.
      // Match the MeteoPT 180h table clock exactly: the table labels the
      // published UTC forecast hour as TSİ without adding Istanbul +03 again.
      // Example: a 00Z valid time is shown as 00:00 TSİ in the table.
      const dateTime=ms=>window.__METEOPT_CANONICAL_DATE_LABEL(ms);
      const points=latestRainForecastPoints.filter(p=>p.modelLead>0&&numeric(p.precipitation_6h_mm)&&Number.isFinite(p.stamp)).sort((a,b)=>a.stamp-b.stamp);
      if(points.length<2){
        forecast.textContent="MeteoPT GFS verisi yeterli değil; yağış zamanı hesaplanamıyor.";
        if(heavy){heavy.textContent="";heavy.hidden=true;}
        return;
      }
      const gaps=points.slice(1).map((p,i)=>(p.stamp-points[i].stamp)/3600000).filter(v=>v>0&&v<=12).sort((a,b)=>a-b);
      const stepH=gaps.length?gaps[Math.floor(gaps.length/2)]:3;
      const now=Date.now();
      // The MeteoPT table deliberately displays UTC forecast clock values as TSİ
      // (without adding +03:00). Compare forecast timestamps against the same
      // wall-clock scale; otherwise the countdown is exactly three hours too long.
      const tableClockNow=now+3*3600000;
      const intervals=points.map(p=>({start:p.stamp-stepH*3600000,end:p.stamp,mm:p.precipitation_6h_mm}))
        .filter(x=>x.mm>=0.2&&x.end>tableClockNow-stepH*3600000);
      const active=intervals.filter(x=>x.start<=tableClockNow&&x.end>tableClockNow);
      const upcoming=intervals.filter(x=>x.start>tableClockNow);
      if(active.length){
        // Yağış sürüyorsa, birbirine bitişik yağışlı model adımlarını birleştir
        // ve mevcut yağış periyodunun sona ereceği ilk kuru zamanı göster.
        const orderedRain=intervals.slice().sort((a,b)=>a.start-b.start);
        let dryAt=Math.max(...active.map(x=>x.end));
        let extended=true;
        while(extended){
          extended=false;
          for(const period of orderedRain){
            if(period.start<=dryAt&&period.end>dryAt){
              dryAt=period.end;
              extended=true;
            }
          }
        }
        const resumesAt=orderedRain
          .filter(period=>period.start>dryAt)
          .sort((a,b)=>a.start-b.start)[0];
        if(resumesAt){
          forecast.textContent="MeteoPT GFS tahminine göre kuru aralık: "+dateTime(dryAt)+"–"+dateTime(resumesAt.start)+". Yağışın "+dateTime(resumesAt.start)+" itibarıyla yeniden başlaması bekleniyor.";
        }else{
          forecast.textContent="MeteoPT GFS tahminine göre "+dateTime(dryAt)+" itibarıyla yağış sona eriyor; tahmin süresinin kalanında yeniden yağış görünmüyor.";
        }
      }else if(upcoming.length){
        const next=upcoming[0],forecastAt=next.end,hours=Math.max(0,(forecastAt-tableClockNow)/3600000);
        const lead=hours<1?"1 saatten az":Math.round(hours)+" saat";
        forecast.innerHTML="MeteoPT GFS tahminine göre yaklaşık "+lead+" içinde<br>("+dateTime(forecastAt)+") yağış bekleniyor.";
      }else{
        forecast.textContent="MeteoPT GFS tahmininde mevcut zamandan sonra belirgin yağış görünmüyor.";
      }
      if(heavy){
        const significant=intervals.filter(x=>x.mm>2.00);
        const heavyActive=significant.filter(x=>x.start<=tableClockNow&&x.end>tableClockNow);
        const heavyNext=significant.filter(x=>x.start>tableClockNow);
        const target=heavyActive[0]||heavyNext[0];
        if(target){
          const when=target.start<=tableClockNow?"Şu anda":" "+dateTime(target.end)+" itibarıyla";
          heavy.hidden=false;
          heavy.textContent="Kuvvetli yağış uyarısı: "+when+" "+fmt(target.mm,2)+" mm / 3 saat (2,00 mm üzeri) tahmin ediliyor.";
        }else{
          heavy.textContent="";
          heavy.hidden=true;
        }
      }
    }
    function hourlyForecastAxisPoint(data,hour){
      if(!Array.isArray(data)||!data.length)return null;
      const target=hour;
      return data.reduce((best,p)=>{
        if(!best)return p;
        return Math.abs(p.lead-target)<Math.abs(best.lead-target)?p:best;
      },null);
    }
    
    function attachStationHistoryTooltip(holder,svg,coords,width,height,top,bottom,color,forecastUTC=false){
      if(!coords.length||typeof document==="undefined")return;
      const tip=document.createElement("div");
      tip.className="station-history-tooltip";tip.hidden=true;tip.setAttribute("role","tooltip");
      document.body.appendChild(tip);
      const ns="http://www.w3.org/2000/svg",line=document.createElementNS(ns,"line"),dot=document.createElementNS(ns,"circle"),hit=document.createElementNS(ns,"rect");
      line.setAttribute("y1",String(top));line.setAttribute("y2",String(height-bottom));line.setAttribute("stroke","#e8fbf7");line.setAttribute("stroke-width","1");line.setAttribute("stroke-dasharray","3 4");line.setAttribute("visibility","hidden");
      dot.setAttribute("r","5");dot.setAttribute("fill",color);dot.setAttribute("stroke","#f4ffff");dot.setAttribute("stroke-width","2");dot.setAttribute("visibility","hidden");
      hit.setAttribute("class","station-chart-hit-area");hit.setAttribute("x","42");hit.setAttribute("y",String(top));hit.setAttribute("width",String(width-54));hit.setAttribute("height",String(height-top-bottom));hit.setAttribute("fill","transparent");hit.setAttribute("tabindex","0");hit.setAttribute("aria-label","Grafikte zaman seçerek ölçüm ayrıntılarını görüntüleyin");hit.style.cursor="crosshair";hit.style.touchAction="pan-y";hit.style.webkitTapHighlightColor="transparent";
      svg.append(line,dot,hit);
      const hide=()=>{
        clearScheduledTouchChartTooltip(hide);
        tip.hidden=true;line.setAttribute("visibility","hidden");dot.setAttribute("visibility","hidden");
      };
      const positionAboveTouch=e=>{
        const tw=tip.offsetWidth,th=tip.offsetHeight,margin=8,gap=14;
        const left=Math.max(margin,Math.min(window.innerWidth-tw-margin,e.clientX-tw/2));
        const topPx=e.clientY-th-gap;
        tip.style.position="fixed";
        tip.style.zIndex="2147483647";
        tip.style.pointerEvents="none";
        tip.style.left=Math.round(left)+"px";
        tip.style.top=Math.round(Math.max(margin,topPx))+"px";
      };
      const show=(p,e)=>{
        line.setAttribute("x1",String(p.x));line.setAttribute("x2",String(p.x));dot.setAttribute("cx",String(p.x));dot.setAttribute("cy",String(p.y));line.setAttribute("visibility","visible");dot.setAttribute("visibility","visible");
        const stampLabel=forecastUTC?forecastDateTimeTSI(p.time):chartDateTimeTR(p.time)+" TSİ";
        tip.innerHTML='<div class="station-history-tooltip-time">'+esc(stampLabel)+'</div><div class="station-history-tooltip-value">'+esc(p.valueLabel)+'</div>'+(p.detail?'<div class="station-history-tooltip-detail">'+esc(p.detail)+'</div>':"");
        tip.hidden=false;
        positionAboveTouch(e);
      };
      const nearest=e=>{const r=svg.getBoundingClientRect();if(!r.width)return;const x=(e.clientX-r.left)*width/r.width;let p=coords[0];for(const q of coords)if(Math.abs(q.x-x)<Math.abs(p.x-x))p=q;show(p,e);};
      const handleTouch=e=>{
        if(!e||!e.clientX&&!e.clientY)return;
        nearest(e);
        scheduleTouchChartTooltipDismiss(hide);
      };
      hit.addEventListener("pointermove",e=>{
        if(e.pointerType==="touch"){handleTouch(e);return;}
        nearest(e);
      });
      hit.addEventListener("pointerrawupdate",e=>{if(e.pointerType==="touch")handleTouch(e);});
      hit.addEventListener("touchmove",e=>{
        if(!e.touches[0])return;
        e.preventDefault();
        handleTouch({clientX:e.touches[0].clientX,clientY:e.touches[0].clientY});
      },{passive:false});
      hit.addEventListener("pointerdown",e=>{
        if(e.pointerType==="touch"||e.pointerType==="pen"){
          e.preventDefault();
          try{hit.setPointerCapture(e.pointerId);}catch(_){}
        }
        nearest(e);
        if(e.pointerType==="touch")scheduleTouchChartTooltipDismiss(hide);
      });
      hit.addEventListener("pointerup",e=>{if(e.pointerType==="touch")scheduleTouchChartTooltipDismiss(hide);});
      hit.addEventListener("pointerleave",e=>{if(e.pointerType!=="touch")hide();});
      hit.addEventListener("pointercancel",hide);
      hit.addEventListener("keydown",e=>{if(!["ArrowLeft","ArrowRight"].includes(e.key))return;e.preventDefault();let i=coords.findIndex(p=>p.x===Number(dot.getAttribute("cx")));if(i<0)i=0;i=Math.max(0,Math.min(coords.length-1,i+(e.key==="ArrowRight"?1:-1)));show(coords[i],{clientX:window.innerWidth/2,clientY:Math.max(80,window.innerHeight/2)});});
    }
    function renderStationTemperatureTrend(samples,stationName){
      stationName=stationName||"İstasyon";const holder=$("station-temperature-trend"),meta=$("station-trend-meta");if(!holder)return;
      const now=Date.now(),windowMs=86400000,bucketMs=1800000;
      // Standardize the station time axis: exact hour boundaries, shared by temperature and rain.
      const chartEnd=Math.floor(now/3600000)*3600000,start=chartEnd-windowMs;
      const valid=(Array.isArray(samples)?samples:[]).map(s=>({time:Date.parse(s.observed_at_utc||s.logged_at_utc||""),temperature:Number(s.temperature_2m_c)})).filter(s=>Number.isFinite(s.time)&&Number.isFinite(s.temperature)&&s.time>=start&&s.time<=now).sort((x,y)=>x.time-y.time);
      const bins=[];for(let t=start;t<now;t+=bucketMs)bins.push({start:t,values:[]});
      valid.forEach(s=>{const i=Math.floor((s.time-start)/bucketMs);if(i>=0&&i<bins.length)bins[i].values.push(s.temperature);});
      const data=bins.map((bin,index)=>({index,start:bin.start,count:bin.values.length,min:bin.values.length?Math.min(...bin.values):null,max:bin.values.length?Math.max(...bin.values):null,mean:bin.values.length?bin.values.reduce((a,v)=>a+v,0)/bin.values.length:null})).filter(x=>x.count);
      const coverage=valid.length?Math.min(24,Math.max(0,(now-valid[0].time)/3600000)):0;
      if(meta)meta.textContent=stationName+" · "+valid.length+" kayıt · "+(coverage>=23.9?"24 saat arşiv kapsamı":"arşiv kapsamı "+fmt(coverage,1)+" saat")+" · 30 dk ortalama / min–maks";
      if(!data.length){
        ["station-temp-range-badge","station-rain-range-badge"].forEach(id=>{const el=$(id);if(el){el.hidden=true;el.textContent="";}});
        holder.innerHTML='<div class="station-trend-empty">İlk sıcaklık kaydı bekleniyor. '+esc(stationName)+' ölçümleri geldikçe grafik dolacak.</div>';return;
      }
      const maxSample=valid.reduce((best,s)=>!best||s.temperature>best.temperature?s:best,null);
      const minSample=valid.reduce((best,s)=>!best||s.temperature<best.temperature?s:best,null);
      const tempRangeBadge=$("station-temp-range-badge");
      if(tempRangeBadge&&maxSample&&minSample){tempRangeBadge.hidden=false;tempRangeBadge.textContent="24 saatte min "+fmt(minSample.temperature,1)+" °C · max "+fmt(maxSample.temperature,1)+" °C";}
      const vals=valid.map(s=>s.temperature);let low=Math.floor(Math.min(...vals)-.5),high=Math.ceil(Math.max(...vals)+.5);if(high-low<2){low-=.5;high+=.5;}
      const width=560,height=200,left=44,right=14,top=15,bottom=29,pw=width-left-right,ph=height-top-bottom;
      const xt=t=>left+(t-start)/windowMs*pw,yv=v=>top+(high-v)/(high-low)*ph,xb=p=>xt(p.start+bucketMs/2);
      const ticks=[];for(let v=Math.ceil(low);v<=Math.floor(high);v++)ticks.push(v);
      const grid=ticks.map(v=>'<line x1="'+left+'" y1="'+yv(v)+'" x2="'+(width-right)+'" y2="'+yv(v)+'" stroke="rgba(190,218,228,.17)" stroke-dasharray="3 5"/><text x="'+(left-9)+'" y="'+(yv(v)+3.5)+'" fill="#a8bfca" font-size="10" text-anchor="end">'+esc(fmt(v,1))+'</text>').join("");
      const vgrid=bins.map((p,i)=>i%4? "":'<line x1="'+xt(p.start)+'" y1="'+top+'" x2="'+xt(p.start)+'" y2="'+(height-bottom)+'" stroke="rgba(190,218,228,.13)" stroke-dasharray="2 5"/>').join("");
      const groups=[];data.forEach(p=>{const g=groups[groups.length-1];if(!g||p.index!==g[g.length-1].index+1)groups.push([p]);else g.push(p);});
      const line=groups.map(g=>g.map((p,i)=>(i?"L":"M")+xb(p).toFixed(1)+" "+yv(p.mean).toFixed(1)).join(" ")).join(" ");
      const area=groups.filter(g=>g.length>1).map(g=>g.map((p,i)=>(i?"L":"M")+xb(p).toFixed(1)+" "+yv(p.mean).toFixed(1)).join(" ")+" L "+xb(g[g.length-1])+" "+(height-bottom)+" L "+xb(g[0])+" "+(height-bottom)+" Z").join(" ");
      const ranges=data.map(p=>{const x=xb(p),y1=yv(p.max),y2=yv(p.min),c=4.5;return '<path d="M'+x+' '+y1+'V'+y2+' M'+(x-c)+' '+y1+'h'+(2*c)+' M'+(x-c)+' '+y2+'h'+(2*c)+'" stroke="rgba(125,211,215,.78)" stroke-width="1.7" fill="none"/>';}).join("");
      const labels=Array.from({length:13},(_,i)=>{
        const t=start+i*2*3600000;
        if(t>chartEnd)return "";
        const label=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(t));
        return '<text x="'+xt(t)+'" y="'+(height-8)+'" fill="#a8bfca" font-size="10" text-anchor="middle">'+label+'</text>';
      }).join("");
      const last=data[data.length-1],lx=xb(last),ly=yv(last.mean);
      holder.innerHTML='<svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+esc(stationName)+' son 24 saat sıcaklık geçmişi; 30 dakikalık ortalama, minimum ve maksimum"><defs><linearGradient id="station-trend-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#8edbd2" stop-opacity=".22"/><stop offset="100%" stop-color="#8edbd2" stop-opacity=".015"/></linearGradient></defs>'+vgrid+grid+'<path d="'+area+'" fill="url(#station-trend-area)"/>'+ranges+'<path d="'+line+'" fill="none" stroke="#8edbd2" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="'+lx+'" cy="'+ly+'" r="6" fill="#f1fff9" stroke="#a4e7d5" stroke-width="1.5"/>'+labels+'</svg>';
      if(meta)meta.textContent=stationName+" · "+valid.length+" kayıt · son ölçüm "+fmt(valid[valid.length-1].temperature,1)+" °C · 30 dk ortalama / min–maks";
      if(typeof document!=="undefined"){const svg=holder.querySelector("svg");attachStationHistoryTooltip(holder,svg,data.map(p=>({x:xb(p),y:yv(p.mean),time:p.start+bucketMs/2,valueLabel:fmt(p.mean,1)+" °C ortalama",detail:"Min "+fmt(p.min,1)+" °C · Maks "+fmt(p.max,1)+" °C · "+p.count+" kayıt"})),width,height,top,bottom,"#7dd3d7");}
    }
    function renderStationPressureTrend(samples,stationName){
      stationName=stationName||"ENKA Balmumcu";
      const holder=$("station-rain-trend"),meta=$("station-rain-meta");
      const caption=$("station-rain-caption");
      if(caption)caption.textContent="hPa · 30 dk ortalama";
      if(!holder)return;
      const now=Date.now(),windowMs=86400000,bucketMs=1800000,start=now-windowMs;
      const valid=(Array.isArray(samples)?samples:[]).map(s=>({time:Date.parse(s.observed_at_utc||s.logged_at_utc||""),pressure:Number(s.station_pressure_hpa)})).filter(s=>Number.isFinite(s.time)&&Number.isFinite(s.pressure)&&s.time>=start&&s.time<=now).sort((a,b)=>a.time-b.time);
      const bins=[];for(let t=start;t<now;t+=bucketMs)bins.push({start:t,values:[]});
      valid.forEach(s=>{const i=Math.floor((s.time-start)/bucketMs);if(i>=0&&i<bins.length)bins[i].values.push(s.pressure);});
      const data=bins.map((bin,index)=>({index,start:bin.start,count:bin.values.length,mean:bin.values.length?bin.values.reduce((a,v)=>a+v,0)/bin.values.length:null,min:bin.values.length?Math.min(...bin.values):null,max:bin.values.length?Math.max(...bin.values):null})).filter(p=>p.count);
      if(meta)meta.textContent=stationName+" · "+valid.length+" kayıt · "+(valid.length?fmt(valid[valid.length-1].pressure,1)+" hPa · 30 dk ortalama":"basınç kayıtları bekleniyor");
      if(!data.length){holder.innerHTML='<div class="station-trend-empty">İlk basınç kaydı bekleniyor. İstasyon ölçümleri geldikçe grafik dolacak.</div>';return;}
      let low=Math.floor(Math.min(...valid.map(p=>p.pressure))-1),high=Math.ceil(Math.max(...valid.map(p=>p.pressure))+1);if(high-low<3){low-=1;high+=1;}
      const width=560,height=160,left=44,right=14,top=13,bottom=27,pw=width-left-right,ph=height-top-bottom;
      const xt=t=>left+(t-start)/windowMs*pw,yv=v=>top+(high-v)/(high-low)*ph,xb=p=>xt(p.start+bucketMs/2);
      const ticks=[];for(let v=Math.ceil(low/2)*2;v<=high;v+=2)ticks.push(v);
      const grid=ticks.map(v=>'<line x1="'+left+'" y1="'+yv(v)+'" x2="'+(width-right)+'" y2="'+yv(v)+'" stroke="rgba(190,218,228,.17)" stroke-dasharray="3 5"/><text x="'+(left-8)+'" y="'+(yv(v)+3.5)+'" fill="#a8bfca" font-size="10" text-anchor="end">'+v+'</text>').join("");
      const groups=[];data.forEach(p=>{const g=groups[groups.length-1];if(!g||p.index!==g[g.length-1].index+1)groups.push([p]);else g.push(p);});
      const line=groups.map(g=>g.map((p,i)=>(i?"L":"M")+xb(p).toFixed(1)+" "+yv(p.mean).toFixed(1)).join(" ")).join(" ");
      const labels=bins.map((p,i)=>{if(i%4&&i!==bins.length-1)return "";const t=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit"}).format(new Date(p.start));return '<text x="'+xt(p.start)+'" y="'+(height-7)+'" fill="#a8bfca" font-size="10" text-anchor="middle">'+t+'</text>';}).join("");
      const last=data[data.length-1],lx=xb(last),ly=yv(last.mean);
      holder.innerHTML='<svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+esc(stationName)+' son 24 saat basınç geçmişi; 30 dakikalık ortalama">'+grid+'<path d="'+line+'" fill="none" stroke="#8abce8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="'+lx+'" cy="'+ly+'" r="5" fill="#f1fff9" stroke="#8abce8" stroke-width="1.5"/>'+labels+'</svg>';
      attachStationHistoryTooltip(holder,holder.querySelector("svg"),data.map(p=>({x:xb(p),y:yv(p.mean),time:p.start+bucketMs/2,valueLabel:fmt(p.mean,1)+" hPa",detail:"Min "+fmt(p.min,1)+" · Maks "+fmt(p.max,1)+" hPa · "+p.count+" kayıt"})),width,height,top,bottom,"#8abce8");
    }
    function renderEyupsultanHourlyRain(samples,stationName,holder,meta,currentObservation){
      const now=Date.now(),windowMs=86400000,hourMs=3600000;
      // Use the end of the current hour as the chart boundary. This keeps the
      // current hour visible as a provisional point while preserving one point
      // per hourly slot. Once the hour closes, the same point becomes final.
      const chartEnd=Math.floor(now/hourMs)*hourMs+hourMs,start=chartEnd-windowMs;
      const rows=Array.isArray(samples)?samples.slice():[];

      // The live observation is always a valid fallback and is also used to
      // populate the current (still-running) hour when the archive is empty.
      if(currentObservation&&numeric(currentObservation.precipitation_1h_mm)){
        rows.push({
          observed_at_utc:currentObservation.observed_at_utc||currentObservation.fetched_at_utc,
          precipitation_1h_mm:currentObservation.precipitation_1h_mm
        });
      }

      // MGM's precipitation_1h_mm is a rolling one-hour accumulation.
      // Keep the latest reading in each hourly slot so the chart advances
      // once per hour instead of drawing every 5/10-minute poll.
      const rawByTime=new Map();
      rows.forEach(sample=>{
        const time=Date.parse(sample.observed_at_utc||sample.logged_at_utc||"");
        const mm=sample.precipitation_1h_mm==null?NaN:Number(sample.precipitation_1h_mm);
        if(Number.isFinite(time)&&time>=start&&time<chartEnd&&Number.isFinite(mm)&&mm>=0){
          rawByTime.set(time,{time,mm});
        }
      });

      const hourlyPoints=new Map();
      [...rawByTime.values()].sort((a,b)=>a.time-b.time).forEach(point=>{
        const slot=Math.floor(point.time/hourMs);
        const previous=hourlyPoints.get(slot);
        if(!previous||point.time>previous.time)hourlyPoints.set(slot,point);
      });
      const points=[...hourlyPoints.values()].sort((a,b)=>a.time-b.time);

      const rainRangeBadge=$( "station-rain-range-badge" );
      if(!points.length){
        if(rainRangeBadge){rainRangeBadge.hidden=true;rainRangeBadge.textContent="";}
        holder.innerHTML='<div class="station-trend-empty">MGM saatlik yağış arşivi henüz oluşuyor. İlk ölçüm geldiğinde grafik otomatik başlayacak.</div>';
        if(meta)meta.textContent=stationName+" · MGM · saatlik arşiv oluşturuluyor";
        return;
      }

      const width=560,height=160,left=42,right=12,top=14,bottom=27,pw=width-left-right,ph=height-top-bottom;
      const max=Math.max(.5,...points.map(point=>point.mm))*1.15;
      const x=t=>left+(t-start)/windowMs*pw,y=v=>top+ph-v/max*ph;
      const grid=[0,max/2,max].map(v=>'<line x1="'+left+'" y1="'+y(v)+'" x2="'+(width-right)+'" y2="'+y(v)+'" stroke="rgba(190,215,225,.13)" stroke-dasharray="3 4"/><text x="'+(left-7)+'" y="'+(y(v)+3)+'" fill="#9fb5c1" font-size="10" text-anchor="end">'+v.toFixed(v<2?1:0).replace(".",",")+'</text>').join("");
      const labels=Array.from({length:13},(_,i)=>{
        const t=start+i*2*3600000;
        if(t>chartEnd)return "";
        const label=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(t));
        return '<text x="'+x(t)+'" y="'+(height-6)+'" fill="#9fb5c1" font-size="10" text-anchor="middle">'+label+'</text>';
      }).join("");
      const groups=[];
      points.forEach(point=>{
        const group=groups[groups.length-1];
        if(!group||point.time-group[group.length-1].time>90*60000)groups.push([point]);
        else group.push(point);
      });
      const line=groups.map(group=>group.map((point,index)=>(index?"L":"M")+x(point.time).toFixed(1)+" "+y(point.mm).toFixed(1)).join(" ")).join(" ");
      const dots=points.map(point=>{
        const provisional=((Math.floor(point.time/hourMs)+1)*hourMs>now);
        const marker=point.mm>0?"#83c9eb":"rgba(131,201,235,.4)";
        const detail=provisional?"Devam eden saat":"Tamamlanan saat";
        return '<circle cx="'+x(point.time).toFixed(1)+'" cy="'+y(point.mm).toFixed(1)+'" r="3" fill="'+marker+'"><title>'+esc(timeTR(point.time))+' · '+fmt(point.mm,1)+' mm / 1 saat · '+detail+'</title></circle>';
      }).join("");
      holder.innerHTML='<svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+esc(stationName)+' son 24 saatteki saatlik kayan yağış toplamı; her saatten bir ölçüm">'+grid+'<path d="'+line+'" fill="none" stroke="#83c9eb" stroke-width="1.9" stroke-linejoin="round"/>'+dots+labels+'</svg>';

      const completedPoints=points.filter(point=>((Math.floor(point.time/hourMs)+1)*hourMs<=now));
      const latest=completedPoints.length?completedPoints[completedPoints.length-1]:points[points.length-1];
      if(rainRangeBadge){
        const minPoint=points.reduce((best,p)=>!best||p.mm<best.mm?p:best,null);
        const peak=points.reduce((best,p)=>!best||p.mm>best.mm?p:best,null);
        if(minPoint&&peak){rainRangeBadge.hidden=false;rainRangeBadge.textContent="24 saatte min "+fmt(minPoint.mm,1)+" mm · max "+fmt(peak.mm,1)+" mm / 1 sa";}
        else{rainRangeBadge.hidden=true;rainRangeBadge.textContent="";}
      }
      const latestIsProvisional=((Math.floor(latest.time/hourMs)+1)*hourMs>now);
      const coverageHours=Math.max(0,(latest.time-points[0].time)/3600000);
      const coverageNote=coverageHours<22.9?" · arşiv "+fmt(coverageHours,1)+" saattir birikiyor":" · 24 saatlik arşiv";
      if(meta)meta.textContent=stationName+" · MGM · "+(latestIsProvisional?"devam eden saat":"son tamamlanan saat")+": "+fmt(latest.mm,1)+" mm / 1 saat"+coverageNote;
      attachStationHistoryTooltip(holder,holder.querySelector("svg"),points.map(point=>{
        const provisional=((Math.floor(point.time/hourMs)+1)*hourMs>now);
        return {
          x:x(point.time),y:y(point.mm),time:point.time,
          valueLabel:fmt(point.mm,1)+" mm / 1 saat",
          detail:(provisional?"Devam eden saat · ":"Tamamlanan saat · ")+timeTR(point.time)
        };
      }),width,height,top,bottom,"#83c9eb");
    }
    function renderStationRainTrend(samples,stationName){
      const holder=$("station-rain-trend"),meta=$("station-rain-meta");if(!holder)return;
      const caption=$("station-rain-caption"),title=$("station-rain-title");
      if(title)title.textContent="Yağış";
      if(activeStation==="eyupsultan"||activeStation==="sisli"||activeStation==="enka"){
        if(caption)caption.textContent="mm · kayan 1 saatlik toplam · saatlik adım";
        const observation=activeStation==="sisli"?sisliStationObservation:eyupsultanStationObservation;
        return renderEyupsultanHourlyRain(samples,stationName,holder,meta,observation);
      }
      return;
    }
    function renderStationHistory(){
      const stationName=activeStation==="eyupsultan"?"Eyüpsultan":activeStation==="sisli"?"Şişli":"ENKA Balmumcu";
      const samples=activeStation==="eyupsultan"?eyupsultanStationHistorySamples:activeStation==="sisli"?sisliStationHistorySamples:enkaStationHistorySamples;
      $("history-station-source").textContent=stationName.toLocaleUpperCase("tr-TR")+" · GERÇEK ÖLÇÜMLER";
      $("station-history-panel").setAttribute("aria-label",stationName+" son 24 saat geçmişi");
      $("history-source-note").hidden=false;
      const enkaCamera=activeStation==="enka"&&enkaStationObservation&&enkaStationObservation.observation_method==="enka-camera-overlay";
      $("history-source-note").textContent=activeStation==="enka"?(enkaCamera?"Sıcaklık, nem, basınç ve rüzgâr: ENKA kamera yedek kaynak. Yağış: MGM Şişli ölçümleri.":"Sıcaklık, nem, basınç ve rüzgâr: ENKA WeatherLink. Yağış: MGM Şişli ölçümleri."):activeStation==="eyupsultan"?"Sıcaklık ve yağış: MGM Eyüpsultan ölçümleri.":"Sıcaklık ve yağış: MGM Şişli ölçümleri.";
      renderStationTemperatureTrend(samples,stationName);
      // Balmumcu rainfall intentionally uses the Şişli MGM archive.
      // Eyüpsultan and Şişli keep their own rainfall archives.
      const dedicatedRainSamples=activeStation==="enka"?sisliStationRainHistorySamples:activeStation==="eyupsultan"?eyupsultanStationRainHistorySamples:sisliStationRainHistorySamples;
      // Fallback to the selected station archive if the rainfall-source archive is not loaded yet.
      const fallbackRainSamples=activeStation==="enka"?sisliStationHistorySamples:activeStation==="eyupsultan"?eyupsultanStationHistorySamples:sisliStationHistorySamples;
      const rainSamples=dedicatedRainSamples.length?dedicatedRainSamples:fallbackRainSamples;
      renderStationRainTrend(rainSamples,stationName);
    }

    
    function calculateFeelsLike(tempC, humidity, windKmh) {
      if (!Number.isFinite(tempC)) return null;
      const rh = Number.isFinite(humidity) ? Math.max(0, Math.min(100, humidity)) : 50;
      const windMs = Number.isFinite(windKmh) ? Math.max(0, windKmh / 3.6) : 0;
      // Australian Apparent Temperature (Steadman, shade, Q=0)
      // e = vapor pressure (hPa)
      const e = (rh / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
      const at = tempC + 0.348 * e - 0.7 * windMs - 4.25;
      return Number.isFinite(at) ? at : null;
    }

    function updateStationLiveRanges(station) {
      const rangeText=(min,max,unit)=>"min "+fmt(min,1)+unit+" · maks "+fmt(max,1)+unit;
      const history=activeStation==="enka"?enkaStationHistorySamples:activeStation==="sisli"?sisliStationHistorySamples:eyupsultanStationHistorySamples;
      const rows=Array.isArray(history)?history:[];
      const now=Date.now(),cutoff=now-86400000;
      const recent=rows.filter(s=>{
        const t=Date.parse(s.observed_at_utc||s.logged_at_utc||"");
        return Number.isFinite(t)&&t>=cutoff&&t<=now+300000;
      });
      const tempValues=recent.map(s=>Number(s.temperature_2m_c)).filter(Number.isFinite);
      const tempEl=$("station-live-temp-range");
      if(tempEl){
        if(tempValues.length){tempEl.textContent=rangeText(Math.min(...tempValues),Math.max(...tempValues),"°");tempEl.hidden=false}
        else{tempEl.textContent="";tempEl.hidden=true}
      }

      const rainHistory=activeStation==="enka"?sisliStationRainHistorySamples:activeStation==="eyupsultan"?eyupsultanStationRainHistorySamples:sisliStationRainHistorySamples;
      const rainRows=Array.isArray(rainHistory)&&rainHistory.length?rainHistory:rows;
      const rainValues=rainRows.filter(s=>{
        const t=Date.parse(s.observed_at_utc||s.logged_at_utc||"");
        const mm=Number(s.precipitation_1h_mm);
        return Number.isFinite(t)&&t>=cutoff&&t<=now+300000&&Number.isFinite(mm)&&mm>=0;
      }).map(s=>Number(s.precipitation_1h_mm));
      if(station&&Number.isFinite(Number(station.precipitation_1h_mm)))rainValues.push(Number(station.precipitation_1h_mm));
      const rainEl=$("station-live-rain-range");
      if(rainEl){
        if(rainValues.length){rainEl.textContent=rangeText(Math.min(...rainValues),Math.max(...rainValues)," mm");rainEl.hidden=false}
        else{rainEl.textContent="";rainEl.hidden=true}
      }

      const feelsEl=$("feels-like-24h");
      if(feelsEl){
        const archivedMin=station&&numeric(station.feels_like_24h_min_c)?Number(station.feels_like_24h_min_c):null;
        const archivedMax=station&&numeric(station.feels_like_24h_max_c)?Number(station.feels_like_24h_max_c):null;
        const feelsValues=recent.map(s=>{
          const stored=Number(s.feels_like_c);
          return Number.isFinite(stored)?stored:calculateFeelsLike(Number(s.temperature_2m_c),Number(s.humidity_percent),Number(s.wind_speed_10m_kmh));
        }).filter(Number.isFinite);
        const minFeels=archivedMin!==null&&archivedMax!==null?archivedMin:(feelsValues.length?Math.min(...feelsValues):null);
        const maxFeels=archivedMin!==null&&archivedMax!==null?archivedMax:(feelsValues.length?Math.max(...feelsValues):null);
        if(minFeels!==null&&maxFeels!==null){
          feelsEl.hidden=false;feelsEl.removeAttribute("hidden");feelsEl.textContent="min "+fmt(minFeels,1)+"° · maks "+fmt(maxFeels,1)+"°";
        }else{feelsEl.hidden=true;feelsEl.textContent=""}
      }
    }

    function updateStation24hDiff(station) {
      const el = $("station-24h-diff");
      
      if (!el) return;
      el.textContent = "";
      
      if (!station || !numeric(station.temperature_2m_c)) return;
      const current = Number(station.temperature_2m_c);
      const samples = activeStation === "enka" ? enkaStationHistorySamples : activeStation === "sisli" ? sisliStationHistorySamples : eyupsultanStationHistorySamples;
      if (Array.isArray(samples) && samples.length) {
        const now = Date.now();
        const target = now - 86400000;
        let best = null;
        let bestDiff = Infinity;
        for (const s of samples) {
          const t = Date.parse(s.observed_at_utc || s.logged_at_utc || "");
          const temp = Number(s.temperature_2m_c);
          if (!Number.isFinite(t) || !Number.isFinite(temp)) continue;
          const diff = Math.abs(t - target);
          if (diff < bestDiff && diff < 3 * 3600000) {
            bestDiff = diff;
            best = temp;
          }
        }
        if (best !== null) {
          const delta = current - best;
          const absDelta = Math.abs(delta);
          if (absDelta < 0.05) {
            el.textContent = "Son 24 saatle aynı";
          } else {
            const dir = delta > 0 ? "daha sıcak" : "daha soğuk";
            el.textContent = "Son 24 saatten " + fmt(absDelta, 1) + "° " + dir;
          }
        }
      }
      const dewValueEl = $("dewpoint-value");
      if (dewValueEl) {
        if (numeric(station.dew_point_c)) {
          dewValueEl.innerHTML = fmt(station.dew_point_c, 1) + "<span class=\"unit\">°</span>";
        } else if (numeric(station.humidity_percent) && numeric(station.temperature_2m_c)) {
          const a = 17.27, b = 237.7;
          const rh = station.humidity_percent / 100;
          const alpha = Math.log(rh) + (a * current) / (b + current);
          const dew = (b * alpha) / (a - alpha);
          if (Number.isFinite(dew)) {
            dewValueEl.innerHTML = fmt(dew, 1) + "<span class=\"unit\">°</span>";
          } else {
            dewValueEl.innerHTML = "—<span class=\"unit\">°</span>";
          }
        } else {
          dewValueEl.innerHTML = "—<span class=\"unit\">°</span>";
        }
      }
    }
    function stationObservationIsFresh(station){
      if(!station||!numeric(station.temperature_2m_c)||!station.observed_at_utc||station.is_stale)return false;
      const observedAt=Date.parse(station.observed_at_utc);
      if(!Number.isFinite(observedAt))return false;
      const ageMinutes=Math.max(0,(Date.now()-observedAt)/60000);
      const isMgmEyupsultan=String(station.station_id||"")==="18101"||String(station.source||"").includes("MGM 18101");
      const defaultLimit=isMgmEyupsultan?30:15;
      const staleAfter=Number.isFinite(station.stale_after_minutes)?station.stale_after_minutes:defaultLimit;
      return ageMinutes<=Math.min(staleAfter,defaultLimit);
    }
    function renderStationCard(station){
      const hasStation=!!station;
      const stationName=station&&station.station_name?station.station_name:(activeStation==="enka"?"ENKA Balmumcu":activeStation==="sisli"?"Şişli":"Eyüpsultan");
      $("station-card-title").textContent=stationName+" · İstanbul";
      const fallbackLabel=$("station-source-fallback");
      if(fallbackLabel)fallbackLabel.hidden=!(activeStation==="enka"&&hasStation&&station.observation_method==="enka-camera-overlay");
      const observed=hasStation&&station.observed_at_utc?new Date(station.observed_at_utc):null;
      const observedValid=observed&&!Number.isNaN(observed.getTime());
      const ageMinutes=observedValid?Math.max(0,(Date.now()-observed.getTime())/60000):null;
      const staleAfter=hasStation&&Number.isFinite(station.stale_after_minutes)?station.stale_after_minutes:(station&&station.station_id==="18101"?20:20);
      const isFresh=stationObservationIsFresh(station);
      $("temperature").textContent=isFresh&&numeric(station.temperature_2m_c)?fmt(station.temperature_2m_c,1)+"°":"—°";
      $("wind").innerHTML=isFresh&&numeric(station.wind_speed_10m_kmh)?fmt(station.wind_speed_10m_kmh,1)+'<span class="unit">km/sa</span>':'—<span class="unit">km/sa</span>';
      const direction=hasStation?(station.wind_direction_tr||windDirectionTr[station.wind_direction_cardinal]||station.wind_direction_cardinal):null;
      $("wind-direction").textContent=isFresh&&direction?direction:"Yön —";
      // Rainfall source: Balmumcu uses Şişli MGM; Eyüpsultan and Şişli use their own MGM observation.
      const rainSource=activeStation==="enka"||activeStation==="sisli"?sisliStationObservation:eyupsultanStationObservation;
      const rain1h=rainSource&&typeof rainSource.precipitation_1h_mm==="number"?rainSource.precipitation_1h_mm:null;
      $("rain").innerHTML=numeric(rain1h)?fmt(rain1h,1)+'<span class="unit">mm</span>':'—<span class="unit">mm</span>';
      const rainBriefCurrent=$("rain-brief-current");
      if(rainBriefCurrent){
        const windSpeed=Number(station&&station.wind_speed_10m_kmh);
        const windCardinal=String(station&&station.wind_direction_cardinal||"").toUpperCase().trim();
        let windBadge="";
        if(Number.isFinite(windSpeed)&&windSpeed>15){
          if(windCardinal==="N") windBadge="Rüzgarlı";
          else if(windCardinal==="NW") windBadge="Karayel hakim";
          else if(windCardinal==="NE") windBadge="Poyraz hakim";
          else if(windCardinal==="S"||windCardinal==="SW") windBadge="Lodos hakim";
        }
        if(rain1h!==null && rain1h>0){
          rainBriefCurrent.textContent="Anlık istasyon yağışı: "+fmt(rain1h,1)+" mm / son 1 saat";
        }else{
          rainBriefCurrent.textContent=windBadge||"Yağış yok";
        }
      }
      const rainDetail=$("rain-detail");
      if(rainDetail)rainDetail.textContent="Son 1 saat";
      $("humidity").innerHTML=isFresh&&numeric(station.humidity_percent)?fmt(station.humidity_percent,0)+'<span class="unit">%</span>':'—<span class="unit">%</span>';
      const feels = isFresh ? calculateFeelsLike(station.temperature_2m_c, station.humidity_percent, station.wind_speed_10m_kmh) : null;
      const feelsEl = $("feels-like");
      if (feelsEl) {
        const archivedFeels = station && numeric(station.feels_like_c) ? Number(station.feels_like_c) : feels;
        feelsEl.innerHTML = (archivedFeels !== null) ? fmt(archivedFeels, 1) + '<span class="unit">°</span>' : '—<span class="unit">°</span>';
      }
      const feelsRangeEl = $("feels-like-24h");
      if (feelsRangeEl) {
        const minFeels = numeric(station.feels_like_24h_min_c) ? Number(station.feels_like_24h_min_c) : null;
        const maxFeels = numeric(station.feels_like_24h_max_c) ? Number(station.feels_like_24h_max_c) : null;
        if (isFresh && minFeels !== null && maxFeels !== null) {
          feelsRangeEl.dataset.min = fmt(minFeels, 1);
          feelsRangeEl.dataset.max = fmt(maxFeels, 1);
          feelsRangeEl.hidden = false;
          feelsRangeEl.textContent = "";
        } else {
          feelsRangeEl.hidden = true;
          feelsRangeEl.textContent = "";
        }
      }
      const livePressure=isFresh?(numeric(station.actual_station_pressure_hpa)?Number(station.actual_station_pressure_hpa):numeric(station.station_pressure_hpa)?Number(station.station_pressure_hpa):null):null;
      $("pressure").innerHTML=livePressure!==null?fmt(livePressure,1)+'<span class="unit">hPa</span>':'—<span class="unit">hPa</span>';
      $("pressure-detail").textContent="";
      $("pressure-detail").hidden=true;
      $("weather-symbol").textContent=symbolFor(numeric(rain1h)?rain1h:0);
      updateStationSky();
      if(hasStation){
        const stale=!isFresh;
        const observedText=observedValid?new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",dateStyle:"short",timeStyle:"short"}).format(observed):"zaman bilinmiyor";
        const ageText=ageMinutes===null?"":ageMinutes<60?Math.round(ageMinutes)+" dk önce":(ageMinutes/60).toFixed(1).replace(".",",")+" saat önce";
        const enkaWaitingForOcr=activeStation==="enka"&&stale&&station.observation_method!=="enka-camera-overlay";
        const sourceLabel=station.observation_method==="enka-camera-overlay"?"ENKA · OCR":station.station_id==="18101"?"MGM 18101":station.station_id==="18401"?"MGM 18401":station.station_id==="ENKA-BALMUMCU-WEATHERLINK"||station.observation_method==="weatherlink-currentvalues-html"?"ENKA WeatherLink":(station.source||"İstasyon");
        const displaySourceLabel=enkaWaitingForOcr?"ENKA · OCR bekleniyor":sourceLabel;
        $("station-observation-meta").textContent=enkaWaitingForOcr?"Güncel ölçüm bekleniyor · kamera OCR devreye alınıyor":(stale?"Gecikmeli ölçüm":"Son ölçüm")+" · "+observedText+" TSİ · "+ageText+" · "+displaySourceLabel;
        updateStationLiveRanges(isFresh&&!enkaWaitingForOcr?station:null);
        updateStation24hDiff(isFresh&&!enkaWaitingForOcr?station:null);
        $("freshness").textContent=enkaWaitingForOcr?"OCR BEKLENİYOR":stale?"ÖLÇÜM ESKİ":"CANLI ÖLÇÜM";
        $("freshness").classList.toggle("stale",stale||enkaWaitingForOcr);
        const alert=$("station-alert");
        alert.hidden=!stale;
        if(stale)alert.textContent=enkaWaitingForOcr?"⚠ ENKA WeatherLink güncel değil. Kamera OCR ölçümü bekleniyor.":observedValid?"⚠ "+sourceLabel+" veri kaynağı güncel ölçüm sağlamıyor.":"⚠ İstasyon ölçüm zamanı doğrulanamadı; veri zaman damgası kontrol edilemiyor.";
      }else{
        $("station-observation-meta").textContent=stationName+" istasyon verisine şu anda ulaşılamıyor.";
        updateStationLiveRanges(null);
        updateStation24hDiff(null);
        $("freshness").textContent="İSTASYON VERİSİ YOK";
        $("freshness").classList.add("stale");
        $("station-alert").hidden=false;
        $("station-alert").textContent="⚠ "+stationName+" istasyon verisi alınamadı. Kartta güncel ölçüm bulunmuyor.";
      }
      fitStationStats();
    }
    function updateStationSky(now){
      const skyApi=window.IstanbulSky;
      const line=$("station-sun-times");
      const moon=$("station-moon");
      if(!skyApi||typeof skyApi.istanbulSky!=="function")return;
      const sky=skyApi.istanbulSky(now instanceof Date?now:new Date());
      if(line)line.textContent=sky.text;
      if(!moon)return;
      moon.hidden=!sky.night;
      if(!sky.night)return;
      const icon=$("station-moon-icon");
      const name=$("station-moon-name");
      if(icon)icon.innerHTML=skyApi.moonPhaseSvg(now instanceof Date?now:new Date());
      if(name)name.textContent=sky.moon.name;
    }
    updateStationSky();
    window.setInterval(updateStationSky,60000);
    function renderStationGap(){
      const node=$("station-temp-compare");
      if(!node)return;
      const stationMap={
        enka:enkaStationObservation,
        eyupsultan:eyupsultanStationObservation,
        sisli:sisliStationObservation
      };
      // Compare against the adjacent station button: ENKA→Eyüpsultan, Eyüpsultan→Şişli, Şişli→Eyüpsultan.
      const otherKey=activeStation==="enka"?"eyupsultan":activeStation==="eyupsultan"?"sisli":"eyupsultan";
      const hereStation=stationMap[activeStation];
      const otherStation=stationMap[otherKey];
      const hide=()=>{node.hidden=true;node.textContent="";};
      if(!stationObservationIsFresh(hereStation)||!stationObservationIsFresh(otherStation)){hide();return;}
      const hereAt=Date.parse(hereStation.observed_at_utc||"");
      const otherAt=Date.parse(otherStation.observed_at_utc||"");
      if(!Number.isFinite(hereAt)||!Number.isFinite(otherAt)||Math.abs(hereAt-otherAt)>30*60000){hide();return;}
      const here=Number(hereStation.temperature_2m_c);
      const there=Number(otherStation.temperature_2m_c);
      if(!Number.isFinite(here)||!Number.isFinite(there)){hide();return;}
      const other=otherKey==="sisli"?"Şişli":otherKey==="enka"?"ENKA Balmumcu":"Eyüpsultan";
      const delta=here-there;
      const gap=Math.abs(delta);
      node.hidden=false;
      node.textContent=gap<0.15?other+" ile aynı":other+"'dan "+fmt(gap,1)+"° daha "+(delta>0?"sıcak":"soğuk");
    }
    function fitStationStats(){
      const row=document.querySelector(".dashboard-top .station-card>.weather-stats");
      if(!row)return;
      row.style.transform="none";
      row.style.width="";
      row.style.marginBottom="";
    }
    window.addEventListener("resize",fitStationStats);
    function buildBriefing(state){
      const num=value=>Number(value).toFixed(1).replace(".",",");
      const when=date=>new Intl.DateTimeFormat("tr-TR",{timeZone:"UTC",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(date)+" UTC";
      const nearest=(points,timeMs,maxGap)=>{
        let best=null,gap=maxGap;
        for(const point of points||[]){
          const stamp=new Date(point.valid_time_utc||point.valid_time_istanbul).getTime();
          if(!Number.isFinite(stamp))continue;
          const delta=Math.abs(stamp-timeMs);
          if(delta<=gap){gap=delta;best=point;}
        }
        return best;
      };
      const now=state.now;
      const horizon=now+72*3600000;
      const gfs=(state.gfsPoints||[]).filter(point=>{
        const stamp=new Date(point.valid_time_utc).getTime();
        return stamp>=now-30*60000&&stamp<=horizon&&point.temperature_2m_c!=null;
      });
      const ec=(state.ecPoints||[]).filter(point=>{
        const stamp=new Date(point.valid_time_utc).getTime();
        return stamp>=now-90*60000&&stamp<=horizon&&point.temperature_2m_c!=null;
      });
      const lines={station:"İstasyon ölçümü bekleniyor.",rain:"Yağış saati hesaplanıyor.",t850:"850 hPa hesaplanıyor.",runs:"Dört çıktı bekleniyor.",split:"ECMWF karşılaştırması bekleniyor."};
      const anchor=state.observedAt||now;
      const gfsNow=nearest(state.gfsPoints,anchor,3*3600000);
      const ecNow=nearest(state.ecPoints,anchor,3*3600000);
      if(state.stationTemp!=null){
        let line=state.stationName+" "+num(state.stationTemp)+"°.";
        if(gfsNow){
          const delta=gfsNow.temperature_2m_c-state.stationTemp;
          const way=delta>0.15?"sıcak":delta<-0.15?"soğuk":"denk";
          line+=" GFS "+num(gfsNow.temperature_2m_c)+"° ("+(delta>0?"+":"")+num(delta)+"° "+way+").";
        }
        if(ecNow){
          const delta=ecNow.temperature_2m_c-state.stationTemp;
          const way=delta>0.15?"sıcak":delta<-0.15?"soğuk":"denk";
          line+=" ECMWF "+num(ecNow.temperature_2m_c)+"° ("+(delta>0?"+":"")+num(delta)+"° "+way+").";
        }else line+=" ECMWF bu saat için henüz yok.";
        lines.station=line;
      }else if(gfsNow){
        lines.station="İstasyon ölçümü yok. GFS bu saatte "+num(gfsNow.temperature_2m_c)+"°.";
      }
      const wet=gfs.filter(point=>(point.precipitation_6h_mm||0)>=0.2);
      const istHour=ms=>Number(new Intl.DateTimeFormat("en-GB",{timeZone:"UTC",hour:"2-digit",hourCycle:"h23"}).format(new Date(ms)));
      const istClock=ms=>forecastClockUTC(ms);
      const istDay=ms=>{
        const name=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",weekday:"long"}).format(new Date(ms));
        return name.charAt(0).toLocaleUpperCase("tr-TR")+name.slice(1);
      };
      const istKey=ms=>new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ms));
      const packHours=items=>{
        const spells=[];
        let current=null;
        for(const item of items){
          if(!current||item.stamp-current.end>2*3600000){
            current={start:item.stamp,end:item.stamp,sum:0};
            spells.push(current);
          }
          current.end=item.stamp;
          current.sum+=item.mm;
        }
        return spells;
      };
      const coverLabel=spell=>{
        const start=istHour(spell.start),end=istHour(spell.end);
        if(start>=0&&end<=5)return "gece";
        if(start>=6&&end<=11)return "sabah";
        if(start>=12&&end<=17)return "öğleden sonra";
        if(start>=18&&end<=23)return "akşam";
        if(end<12)return "öğleden önce";
        if(start>=12)return "öğleden sonra";
        return "";
      };
      const spellText=spell=>{
        const start=istClock(spell.start),end=istClock(spell.end);
        const label=coverLabel(spell);
        return (label?label+" ":"")+(start===end?start:start+"–"+end)+", "+num(spell.sum)+" mm";
      };
      if(!gfs.length)lines.rain="GFS yağış zamanı yok.";
      else if(!wet.length)lines.rain="Önümüzdeki 72 saatte 0,2 mm üstü yağış yok.";
      else{
        const groups=new Map();
        for(const point of wet){
          const stamp=new Date(point.valid_time_utc).getTime();
          const key=istKey(stamp);
          if(!groups.has(key))groups.set(key,[]);
          groups.get(key).push({stamp,mm:point.precipitation_6h_mm||0});
        }
        const parts=[];
        for(const items of groups.values()){
          items.sort((a,b)=>a.stamp-b.stamp);
          const day=istDay(items[0].stamp);
          const before=items.filter(item=>istHour(item.stamp)<12);
          const after=items.filter(item=>istHour(item.stamp)>=12);
          const beforeSum=before.reduce((sum,item)=>sum+item.mm,0);
          const afterSum=after.reduce((sum,item)=>sum+item.mm,0);
          const daySum=beforeSum+afterSum;
          const describe=list=>packHours(list).filter(spell=>spell.sum>=0.5||daySum<2).map(spellText);
          const beforeText=describe(before);
          const afterText=describe(after);
          if(!beforeText.length&&!afterText.length)continue;
          if(beforeText.length&&afterText.length){
            const afterHeavier=afterSum>=beforeSum;
            const lead=afterHeavier?"öğleden sonra":"öğleden önce";
            const more=afterHeavier?afterText:beforeText;
            const less=afterHeavier?beforeText:afterText;
            const bare=text=>text.replace(/^(öğleden sonra|öğleden önce) /,"");
            const capital=text=>text.charAt(0).toLocaleUpperCase("tr-TR")+text.slice(1);
            parts.push(day+" "+lead+" daha fazla: "+more.map(bare).join(" ve ")+". "+less.map(capital).join(". ")+".");
          }else{
            parts.push(day+" "+(afterText.length?afterText:beforeText).join(" ve ")+".");
          }
        }
        const peak=wet.reduce((best,point)=>(point.precipitation_6h_mm||0)>(best.precipitation_6h_mm||0)?point:best,wet[0]);
        const peakAt=new Date(peak.valid_time_utc).getTime();
        lines.rain=parts.join(" ")+" En yoğun "+istDay(peakAt)+" "+istClock(peakAt)+", "+num(peak.precipitation_6h_mm)+" mm.";
      }
      if(gfsNow&&gfsNow.temperature_850hpa_c!=null){
        const later=nearest(gfs,new Date(gfsNow.valid_time_utc).getTime()+24*3600000,3*3600000);
        let line="Şimdi "+num(gfsNow.temperature_850hpa_c)+"°.";
        if(later&&later.temperature_850hpa_c!=null){
          const delta=later.temperature_850hpa_c-gfsNow.temperature_850hpa_c;
          const way=delta<=-0.3?"soğuma":delta>=0.3?"ısınma":"";
          line+=way?(" Yarın aynı saatte "+num(later.temperature_850hpa_c)+"°, "+num(Math.abs(delta))+"° "+way+"."):(" Yarın aynı saatte "+num(later.temperature_850hpa_c)+"°, belirgin değişim yok.");
        }
        const ecLater=ecNow?nearest(ec,new Date(ecNow.valid_time_utc).getTime()+24*3600000,3*3600000):null;
        const ec850=ecLater&&(ecLater.temperature_850hpa_c!=null?ecLater.temperature_850hpa_c:(ecLater.temperature_850hpa&&ecLater.temperature_850hpa.mean_c));
        if(ec850!=null)line+=" ECMWF yarın "+num(ec850)+"°.";
        lines.t850=line;
      }else lines.t850="850 hPa sıcaklığı bu çıktıda yok.";
      const runs=(state.runs||[]).filter(run=>Array.isArray(run.forecast_6_hourly)&&run.forecast_6_hourly.length);
      if(runs.length<2)lines.runs="Karşılaştırılacak ikinci çıktı yok.";
      else{
        const useSurface=runs.some(run=>(run.forecast_6_hourly||[]).some(point=>typeof point.temperature_2m_c==="number"));
        const readTemp=point=>useSurface?point.temperature_2m_c:point.temperature_850hpa_c;
        const subject=useSurface?"2 m sıcaklıkta":"850 hPa sıcaklıkta";
        const buckets=new Map();
        for(const run of runs){
          for(const point of run.forecast_6_hourly){
            const stamp=new Date(point.valid_time_utc).getTime();
            const temp=readTemp(point);
            if(stamp<now-30*60000||stamp>horizon||typeof temp!=="number")continue;
            if(!buckets.has(stamp))buckets.set(stamp,[]);
            buckets.get(stamp).push({run:run.run_id_utc,temp});
          }
        }
        const full=Array.from(buckets.entries()).filter(([,values])=>values.length===runs.length);
        if(!full.length)lines.runs="Dört çıktının ortak saati yok.";
        else{
          const spreads=full.map(([,values])=>{
            const temps=values.map(item=>item.temp);
            return Math.max(...temps)-Math.min(...temps);
          });
          const sorted=spreads.slice().sort((a,b)=>a-b);
          const mid=Math.floor(sorted.length/2);
          const typical=sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
          let worst=full[0],worstSpread=spreads[0];
          spreads.forEach((spread,index)=>{if(spread>worstSpread){worstSpread=spread;worst=full[index];}});
          const latest=runs.slice().sort((a,b)=>new Date(a.run_id_utc)-new Date(b.run_id_utc)).at(-1).run_id_utc;
          const jumps=full.map(([,values])=>{
            const last=values.find(item=>item.run===latest);
            const older=values.filter(item=>item.run!==latest).map(item=>item.temp);
            const mean=older.reduce((sum,value)=>sum+value,0)/older.length;
            return last.temp-mean;
          });
          const jump=jumps.reduce((sum,value)=>sum+value,0)/jumps.length;
          const where=when(new Date(worst[0]));
          if(Math.abs(jump)>=1.2){
            lines.runs="Son çıktı, "+subject+", öncekilerden ortalama "+num(Math.abs(jump))+"° daha "+(jump<0?"soğuk":"sıcak")+". En büyük ayrılık "+where+", "+num(worstSpread)+"°. Oynak.";
          }else{
            lines.runs="Dört çıktı 72 saatte "+subject+" birbirine yakın. Ortanca fark "+num(typical)+"°. En büyük ayrılık "+where+", "+num(worstSpread)+"°.";
          }
        }
      }
      if(!gfs.length){lines.split="GFS saati yok.";return lines;}
      if(!ec.length){lines.split=ecmwfForecast?"ECMWF ile ortak saat yok.":"ECMWF paketi yükleniyor.";return lines;}
      let peak={abs:0},rain=null;
      for(const point of ec){
        const stamp=new Date(point.valid_time_utc).getTime();
        const model=nearest(gfs,stamp,90*60000);
        if(!model)continue;
        const delta=model.temperature_2m_c-point.temperature_2m_c;
        if(Math.abs(delta)>peak.abs)peak={abs:Math.abs(delta),delta,at:stamp,gfs:model.temperature_2m_c,ec:point.temperature_2m_c};
        const gfsRain=gfs.filter(item=>{
          const itemStamp=new Date(item.valid_time_utc).getTime();
          return itemStamp>stamp-3*3600000&&itemStamp<=stamp;
        }).reduce((sum,item)=>sum+(item.precipitation_6h_mm||0),0);
        const ecRain=point.precipitation_interval_mm||0;
        if((gfsRain>=0.5&&ecRain<0.15)||(ecRain>=0.5&&gfsRain<0.15)){
          if(!rain||Math.abs(gfsRain-ecRain)>Math.abs(rain.gfs-rain.ec))rain={at:stamp,gfs:gfsRain,ec:ecRain};
        }
      }
      if(!peak.at)lines.split="Ortak saat bulunamadı.";
      else{
        const fromEcmwf=typeof activeModel!=="undefined"&&activeModel==="ecmwf";
        const lead=fromEcmwf?"ECMWF":"GFS";
        const other=fromEcmwf?"GFS":"ECMWF";
        const otherFrom=fromEcmwf?"GFS'ten":"ECMWF'den";
        const leadDelta=fromEcmwf?-peak.delta:peak.delta;
        const way=leadDelta>0?"sıcak":"soğuk";
        const leadTemp=fromEcmwf?peak.ec:peak.gfs;
        const otherTemp=fromEcmwf?peak.gfs:peak.ec;
        if(peak.abs<1.5&&!rain){
          lines.split="Önümüzdeki 72 saatte "+lead+", "+otherFrom+" sıcaklıkta en fazla "+num(peak.abs)+"° daha "+way+". Yağış saati uyumlu.";
        }else{
          let line=when(new Date(peak.at))+" "+lead+" "+num(leadTemp)+"°, "+other+" "+num(otherTemp)+"° ("+num(peak.abs)+"° "+otherFrom+" daha "+way+").";
          if(rain){
            const leadRain=fromEcmwf?rain.ec:rain.gfs;
            const otherRain=fromEcmwf?rain.gfs:rain.ec;
            line+=" Yağış da ayrışıyor: "+when(new Date(rain.at))+" "+lead+" "+num(leadRain)+" mm, "+other+" "+num(otherRain)+" mm.";
          }
          lines.split=line;
        }
      }
      return lines;
    }
    function renderTemperatureTrend(){
      const holder=$("brief-temperature-trend");
      if(!holder)return;
      const station=eyupsultanStationObservation;
      if(!stationObservationIsFresh(station)){
        holder.textContent="Eyüpsultan istasyonunun güncel ölçümü bekleniyor; eski ölçümle sıcaklık eğilimi üretilmiyor.";
        appendTemperatureSwings(holder);
        return;
      }
      const now=Date.now();
      const windows=briefingDayMeans(briefingForecastPoints(),now).map(item=>({
        day:item.day,
        stamp:Date.parse(item.key+"T12:00:00Z"),
        mean:item.mean
      }));
      const valid=briefingWindowPoints(briefingForecastPoints(),now)
        .map(point=>({stamp:point.stamp,temp:point.temp}))
        .sort((a,b)=>a.stamp-b.stamp);
      const current=Number(station.temperature_2m_c);
      if(windows.length<3){
        holder.textContent="Önümüzdeki 5 gün için yeterli sıcaklık tahmini henüz yayımlanmadı. Eyüpsultan şu an "+fmt(current,1)+"°C.";
        appendTemperatureSwings(holder);
        return;
      }
      const nearTerm=valid.filter(point=>point.stamp<=now+12*3600000).map(point=>point.temp);
      const nearMean=nearTerm.length?nearTerm.reduce((sum,value)=>sum+value,0)/nearTerm.length:current;
      const baseline=(current+nearMean)/2;
      const dayLabel=stamp=>{
        const name=new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",weekday:"long"}).format(new Date(stamp));
        return name.charAt(0).toLocaleUpperCase("tr-TR")+name.slice(1);
      };
      const magnitude=value=>fmt(Math.abs(value),1)+"°C";
      const currentText="Eyüpsultan şu an "+fmt(current,1)+"°C.";
      const series=windows.map((item,index)=>({
        ...item,
        delta:item.mean-(index===0?baseline:windows[index-1].mean),
        trend:"stable"
      }));
      series.forEach(item=>{
        if(item.delta<=-1.0)item.trend="fall";
        else if(item.delta>=1.0)item.trend="rise";
      });
      const dayPhrase=items=>{
        const names=items.map(item=>dayLabel(item.stamp));
        return names.length===1?names[0]:names[0]+"–"+names[names.length-1];
      };
      const groups=[];
      for(const item of series){
        const last=groups[groups.length-1];
        if(last&&last.trend===item.trend)last.items.push(item);
        else groups.push({trend:item.trend,items:[item]});
      }
      const firstFall=groups.findIndex(group=>group.trend==="fall");
      let summary="";
      if(firstFall>=0){
        const fallGroup=groups[firstFall];
        const first=fallGroup.items[0];
        const when=first.day===0?"bugün":first.day===1?"yarın":first.day+" gün sonra";
        summary="Hava "+when+" ("+dayLabel(first.stamp)+") soğumaya başlıyor; günlük ortalama yaklaşık "+magnitude(first.delta)+" düşüyor.";
        const later=groups.slice(firstFall+1);
        for(const group of later){
          if(group.trend==="fall"){
            summary+=" "+dayPhrase(group.items)+" günleri düşüş devam ediyor.";
          }else if(group.trend==="stable"){
            summary+=" "+dayPhrase(group.items)+" günleri sıcaklık stabil seyrediyor.";
          }else{
            summary+=" Yeniden ısınma "+dayLabel(group.items[0].stamp)+" günü başlıyor.";
          }
        }
        if(!later.some(group=>group.trend==="rise")){
          summary+=" Beş günlük tahmin aralığında yeniden ısınma görünmüyor.";
        }
      }else{
        const firstRise=groups.find(group=>group.trend==="rise");
        if(firstRise){
          const first=firstRise.items[0];
          const when=first.day===0?"bugün":first.day===1?"yarın":first.day+" gün sonra";
          summary="Belirgin ısınma "+when+" ("+dayLabel(first.stamp)+") başlıyor; günlük ortalama yaklaşık "+magnitude(first.delta)+" yükseliyor.";
          for(const group of groups.slice(groups.indexOf(firstRise)+1)){
            if(group.trend==="rise")summary+=" "+dayPhrase(group.items)+" günleri ısınma sürüyor.";
            else if(group.trend==="stable")summary+=" "+dayPhrase(group.items)+" günleri sıcaklık stabil seyrediyor.";
            else summary+=" "+dayPhrase(group.items)+" günleri sıcaklık yeniden düşüyor.";
          }
        }else{
          summary="Önümüzdeki beş gün boyunca sıcaklık belirgin değişim göstermeden stabil seyrediyor.";
        }
      }
      summary+=" "+currentText;
      holder.replaceChildren();
      const textNode=document.createElement("span");
      textNode.textContent=summary;
      holder.appendChild(textNode);
      appendTemperatureSwings(holder);
    }
    function tableForecastDayKey(ms){
      return new Intl.DateTimeFormat("en-CA",{timeZone:"UTC",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ms));
    }
    function tableForecastClock(ms){
      return forecastClockUTC(ms);
    }
    function tableForecastDayTitle(dayKey){
      const name=new Intl.DateTimeFormat("tr-TR",{timeZone:"UTC",weekday:"long"}).format(new Date(dayKey+"T12:00:00Z"));
      return name.charAt(0).toLocaleUpperCase("tr-TR")+name.slice(1);
    }
    function istanbulCivilDayKeys(nowMs,count){
      const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(nowMs));
      const keys=[];
      for(let offset=0;offset<count;offset++){
        const start=Date.parse(today+"T00:00:00+03:00")+offset*86400000;
        keys.push(new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(start+12*3600000)));
      }
      return keys;
    }
    function briefingForecastPoints(){
      const canonical=window.__METEOPT_F180_DOCUMENT;
      if(canonical&&Array.isArray(canonical.forecast_6_hourly))return canonical.forecast_6_hourly;
      return forecastData&&Array.isArray(forecastData.forecast_6_hourly)?forecastData.forecast_6_hourly:[];
    }
    const BRIEFING_WINDOW_HOURS=120;
    const BRIEFING_DAY_COUNT=5;
    function briefingWindowPoints(points,nowMs){
      const wanted=new Set(istanbulCivilDayKeys(nowMs,BRIEFING_DAY_COUNT));
      return (points||[]).map(point=>{
        const stamp=Date.parse(point&&point.valid_time_utc);
        const step=Number(point&&point.forecast_hour);
        const temp=Number(point&&point.temperature_2m_c);
        const mm=Number(point&&point.precipitation_6h_mm);
        return {stamp,step,temp,mm:Number.isFinite(mm)?mm:0};
      }).filter(point=>Number.isFinite(point.stamp)&&point.step>0&&point.step<=BRIEFING_WINDOW_HOURS&&point.step%3===0&&point.stamp>=nowMs-30*60000&&wanted.has(tableForecastDayKey(point.stamp)))
        .sort((a,b)=>a.stamp-b.stamp);
    }
    function briefingDayMeans(points,nowMs){
      const dayKeys=istanbulCivilDayKeys(nowMs,BRIEFING_DAY_COUNT);
      const buckets=new Map(dayKeys.map(key=>[key,[]]));
      for(const point of briefingWindowPoints(points,nowMs)){
        if(!Number.isFinite(point.temp))continue;
        buckets.get(tableForecastDayKey(point.stamp)).push(point.temp);
      }
      return dayKeys.map((key,day)=>{
        const temps=buckets.get(key);
        if(temps.length<2)return null;
        return {day,key,count:temps.length,mean:temps.reduce((sum,value)=>sum+value,0)/temps.length};
      }).filter(Boolean);
    }
    function formatSwingAmount(delta){
      const digits=Math.abs(delta).toLocaleString("tr-TR",{minimumFractionDigits:1,maximumFractionDigits:1});
      return (delta<0?"−":"+")+digits+"°C";
    }
    function temperatureSwingLines(points,nowMs){
      const dayKeys=istanbulCivilDayKeys(nowMs,BRIEFING_DAY_COUNT);
      const rows=briefingWindowPoints(points,nowMs).filter(point=>Number.isFinite(point.temp));
      const byDay=new Map();
      for(let index=1;index<rows.length;index++){
        const hours=(rows[index].stamp-rows[index-1].stamp)/3600000;
        if(hours<2.5||hours>3.5)continue;
        const delta=rows[index].temp-rows[index-1].temp;
        if(Math.abs(delta)<4)continue;
        const day=tableForecastDayKey(rows[index-1].stamp);
        if(!byDay.has(day))byDay.set(day,[]);
        byDay.get(day).push({start:rows[index-1].stamp,end:rows[index].stamp,delta});
      }
      return dayKeys.filter(day=>byDay.has(day)).map(day=>{
        const swings=byDay.get(day).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)).slice(0,3)
          .sort((a,b)=>a.start-b.start);
        const parts=swings.map(swing=>tableForecastClock(swing.start)+"–"+tableForecastClock(swing.end)+" "+formatSwingAmount(swing.delta));
        return tableForecastDayTitle(day)+" · "+parts.join(" · ");
      });
    }
    function appendTemperatureSwings(holder){
      const lines=temperatureSwingLines(briefingForecastPoints(),Date.now());
      if(!lines.length)return;
      const list=document.createElement("div");
      list.className="brief-temp-swings";
      for(const text of lines){
        const line=document.createElement("div");
        line.className="brief-temp-swing";
        line.textContent=text;
        list.appendChild(line);
      }
      holder.appendChild(list);
    }
    function rainDayLines(points,nowMs){
      const rows=briefingWindowPoints(points,nowMs);
      const steps=rows.map(point=>point.step).filter(Number.isFinite).sort((a,b)=>a-b);
      const gaps=steps.slice(1).map((step,index)=>step-steps[index]).filter(gap=>gap>0&&gap<=6).sort((a,b)=>a-b);
      const stepH=gaps.length?gaps[Math.floor(gaps.length/2)]:3;
      const cover=(startHour,endHour)=>{
        if(startHour>=18&&endHour>=18)return "akşam";
        if(startHour>=18&&endHour<=5)return "";
        if(endHour>=18&&startHour<18)return "öğleden sonra–akşam";
        if(endHour<=5)return "";
        if(startHour>=6&&endHour<=11)return "sabah";
        if(startHour>=12&&endHour<=17)return "öğleden sonra";
        if(startHour>=18)return "akşam";
        if(endHour<12)return "öğleden önce";
        if(startHour>=12)return "öğleden sonra";
        return "";
      };
      const lines=[];
      for(const key of istanbulCivilDayKeys(nowMs,BRIEFING_DAY_COUNT)){
        const dayPoints=rows.filter(point=>tableForecastDayKey(point.stamp)===key);
        if(!dayPoints.length)continue;
        const wet=dayPoints.filter(point=>point.mm>=0.2);
        const spells=[];
        let current=null;
        for(const item of wet){
          if(!current||item.stamp-current.end>stepH*3600000+60000){
            current={start:item.stamp,end:item.stamp,sum:0};
            spells.push(current);
          }
          current.end=item.stamp;
          current.sum+=item.mm;
        }
        const daySum=spells.reduce((sum,spell)=>sum+spell.sum,0);
        const visible=spells.filter(spell=>spell.sum>=0.5||daySum<2);
        const titled=tableForecastDayTitle(key);
        if(!visible.length){
          lines.push(titled+" · yağış yok");
          continue;
        }
        for(const spell of visible){
          // Each table Prec. row is the 3-hour block that starts at that TSİ
          // hour. 21:00 therefore runs until 00:00; the 00:00 row stays on the
          // next calendar day and is not counted twice.
          const intervalEnd=spell.end+stepH*3600000;
          const whenText=tableForecastClock(spell.start)+"–"+tableForecastClock(intervalEnd);
          const startHour=Number(new Intl.DateTimeFormat("en-GB",{timeZone:"UTC",hour:"2-digit",hourCycle:"h23"}).format(new Date(spell.start)));
          const endHour=Number(new Intl.DateTimeFormat("en-GB",{timeZone:"UTC",hour:"2-digit",hourCycle:"h23"}).format(new Date(spell.end)));
          const period=cover(startHour,endHour);
          lines.push(titled+" · "+whenText+(period?" · "+period:"")+" · "+spell.sum.toLocaleString("tr-TR",{minimumFractionDigits:1,maximumFractionDigits:1})+" mm");
        }
      }
      return lines;
    }
    function renderBriefing(){
      const selectedStation=activeStation==="eyupsultan"?eyupsultanStationObservation:enkaStationObservation;
      const station=stationObservationIsFresh(selectedStation)?selectedStation:null;
      const lines=buildBriefing({
        now:Date.now(),
        gfsPoints:forecastData&&forecastData.forecast_6_hourly,
        ecPoints:ecmwfForecast&&ecmwfForecast.forecasts,
        runs:forecastData&&forecastData.comparison_runs,
        stationTemp:station&&station.temperature_2m_c,
        stationName:activeStation==="eyupsultan"?"Eyüpsultan":"Balmumcu",
        observedAt:station&&station.observed_at_utc?new Date(station.observed_at_utc).getTime():null
      });
      const write=(id,text)=>{const node=$(id);if(node)node.textContent=text;};
      renderRainDays();
      renderTemperatureTrend();
      renderStationGap();
    }
    window.addEventListener("meteopt-gfs-f72-updated",()=>{
      // The F180 table is the canonical rain timing source; refresh the
      // briefing immediately when that payload arrives or is refreshed.
      try{renderRainDays();}catch(error){console.warn("Rain briefing refresh skipped:",error);}
      try{renderTemperatureTrend();}catch(error){console.warn("Temperature swing refresh skipped:",error);}
    });
    function dayWindow(offset){
      const key=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
      const start=Date.parse(key+"T00:00:00+03:00")+offset*86400000;
      return [start,start+86400000];
    }
    function renderRainDays(){
      const holder=$("brief-rain-lines");
      if(!holder)return;
      // Same 180-hour MeteoPT series and TSİ clock as the GFS table.
      // The boxes analyze the first 120 hours, five Istanbul days.
      const lines=rainDayLines(briefingForecastPoints(),Date.now());
      holder.replaceChildren();
      if(!lines.length){
        holder.textContent="Önümüzdeki günler için çıktı yok.";
        return;
      }
      for(const text of lines){
        const line=document.createElement("div");
        line.className="brief-spell";
        line.textContent=text;
        holder.appendChild(line);
      }
    }
    function trustedLeadHours(kind){
      const now=Date.now();
      const points=forecastData&&Array.isArray(forecastData.forecast_6_hourly)?forecastData.forecast_6_hourly:[];
      const leads=[];
      for(const point of points){
        const stamp=new Date(point.valid_time_utc).getTime();
        const lead=Number(point.forecast_hour);
        if(!Number.isFinite(stamp)||stamp<now-20*60000||stamp>now+72*3600000)continue;
        if(!Number.isFinite(lead)||lead<0)continue;
        const skill=kind==="rain"?skillAtLeadRain(lead):skillAtLead(lead);
        const percent=skill&&(kind==="rain"?skill.within_1mm_pct:skill.within_2c_pct);
        if(skill&&skill.pairs>=3&&numeric(percent)&&percent>=90)leads.push(lead);
      }
      return Array.from(new Set(leads)).sort((a,b)=>a-b);
    }
    function formatLeadRanges(hours){
      if(!hours.length)return "";
      const parts=[];
      let start=hours[0],previous=hours[0];
      for(const hour of hours.slice(1)){
        if(hour===previous+1){previous=hour;continue;}
        parts.push(start===previous?"+"+start:"+"+start+"–+"+previous);
        start=previous=hour;
      }
      parts.push(start===previous?"+"+start:"+"+start+"–+"+previous);
      return parts.join(", ");
    }
    
    // Never let an empty/null station state kill the rest of the homepage.
    // The station API loads asynchronously; the UI controls must bind even when
    // the first paint has no observation yet.
    function safeRenderStationCard(station){
      try{renderStationCard(station||null);}
      catch(error){console.warn("Station card render skipped:",error);}
    }
    function forceHomepageDefaultStation(){
      const pagePath=typeof location!=="undefined"&&location?location.pathname:"";
      if(pagePath==="/" || pagePath.endsWith("/index.html")){
        activeStation="eyupsultan";
        try{localStorage.setItem("istanbul-hava-station","eyupsultan");}catch(_){}
        const e=$("station-enka-button"), y=$("station-eyupsultan-button"), s=$("station-sisli-button");
        if(e)e.classList.toggle("active",false),e.setAttribute("aria-pressed","false");
        if(y)y.classList.toggle("active",true),y.setAttribute("aria-pressed","true");
        if(s)s.classList.toggle("active",false),s.setAttribute("aria-pressed","false");
        safeRenderStationCard(eyupsultanStationObservation);
      }
    }
    function selectStation(stationKey){
      if(!["enka","eyupsultan","sisli"].includes(stationKey))return;
      activeStation=stationKey;
      try{localStorage.setItem("istanbul-hava-station",stationKey);}catch(_){}
      const e=$("station-enka-button"), y=$("station-eyupsultan-button"), s=$("station-sisli-button");
      if(e)e.classList.toggle("active",stationKey==="enka"),e.setAttribute("aria-pressed",String(stationKey==="enka"));
      if(y)y.classList.toggle("active",stationKey==="eyupsultan"),y.setAttribute("aria-pressed",String(stationKey==="eyupsultan"));
      if(s)s.classList.toggle("active",stationKey==="sisli"),s.setAttribute("aria-pressed",String(stationKey==="sisli"));
      safeRenderStationCard(stationKey==="enka"?enkaStationObservation:stationKey==="eyupsultan"?eyupsultanStationObservation:sisliStationObservation);
      try{renderStationHistory();}catch(error){console.warn("Station history render skipped:",error);}
      if(typeof renderBriefing==="function")renderBriefing();
      if(typeof refreshSelectedStation==="function")refreshSelectedStation();
    }
    forceHomepageDefaultStation();
    $("station-enka-button") && $("station-enka-button").addEventListener("click",()=>selectStation("enka"));
    $("station-eyupsultan-button") && $("station-eyupsultan-button").addEventListener("click",()=>selectStation("eyupsultan"));
    $("station-sisli-button") && $("station-sisli-button").addEventListener("click",()=>selectStation("sisli"));
    document.querySelector(".topbar .brand") && document.querySelector(".topbar .brand").addEventListener("click",()=>selectStation("eyupsultan"));


    function render(data){
      forecastData=data;
renderBriefing();
      if(data.report&&data.report.report_text){
        renderNotifications([data.report], (data.published_at_utc||data.report.published_at_utc)+"-svgcenter1");
      }
      renderStationCard(activeStation==="enka"?enkaStationObservation:activeStation==="eyupsultan"?eyupsultanStationObservation:sisliStationObservation);
      if(data.published_at_utc){
        const age=(Date.now()-new Date(data.published_at_utc).getTime())/3600000;
      }
      if(data.forecast_valid_until_utc&&$("valid-until"))$("valid-until").textContent="Son geçerlilik: "+new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"2-digit"}).format(new Date(data.forecast_valid_until_utc));
      // GFS bölgesel basınç merkezleri ayrı GitHub Actions verisinden render ediliyor; eski noktasal yorum katmanı bunu ezmemeli.
    }
    function workerStationToPageStation(row){
      if(!row)return null;
      const toNumber=value=>(value===null||value===undefined||value==="")?null:Number(value);
      const pressure=toNumber(row.pressure_hpa == null ? (row.actual_station_pressure_hpa == null ? row.station_pressure_hpa : row.actual_station_pressure_hpa) : row.pressure_hpa);
      const wind=toNumber(row.wind_speed_kmh == null ? row.wind_speed_10m_kmh : row.wind_speed_kmh);
      const temp=toNumber(row.temperature_c == null ? row.temperature_2m_c : row.temperature_2m_c);
      const humidity=toNumber(row.humidity_percent);
      const rain1=toNumber(row.rain_1h_mm == null ? row.precipitation_1h_mm : row.precipitation_1h_mm);
      const rain10=toNumber(row.rain_10m_mm == null ? row.precipitation_10m_mm : row.precipitation_10m_mm);
      const rain6=toNumber(row.rain_6h_mm == null ? row.precipitation_6h_mm : row.rain_6h_mm);
      const rain12=toNumber(row.rain_12h_mm == null ? row.precipitation_12h_mm : row.rain_12h_mm);
      const rain24=toNumber(row.rain_24h_mm == null ? row.precipitation_24h_mm : row.rain_24h_mm);
      const rain00=toNumber(row.rain_00_now_mm == null ? row.precipitation_daily_mm : row.rain_00_now_mm);
      const degree=toNumber(row.wind_direction == null ? row.wind_direction_degrees : row.wind_direction);
      let directionCardinal=row.wind_direction_cardinal||null;
      if(!directionCardinal&&degree!==null){
        const dirs=["N","NE","E","SE","S","SW","W","NW"];
        directionCardinal=dirs[Math.round(((degree%360)+360)%360/45)%8];
      }
      return {
        station_id:String(row.station_id||""),
        station_name:row.station_name||row.station||"İstasyon",
        source:row.source||"Cloudflare Worker",
        observed_at_utc:row.observed_at_utc||row.fetched_at_utc||null,
        fetched_at_utc:row.fetched_at_utc||null,
        temperature_2m_c:temp,
        humidity_percent:humidity,
        actual_station_pressure_hpa:pressure!==null&&pressure>-9000?pressure:null,
        station_pressure_hpa:pressure!==null&&pressure>-9000?pressure:null,
        wind_speed_10m_kmh:wind,
        wind_direction_cardinal:directionCardinal,
        wind_direction_tr:row.wind_direction_tr||directionCardinal,
        precipitation_1h_mm:rain1,
        precipitation_10m_mm:rain10,
        precipitation_6h_mm:rain6,
        precipitation_12h_mm:rain12,
        precipitation_24h_mm:rain24,
        precipitation_daily_mm:rain00,
        dew_point_c:toNumber(row.dew_point_c),
        feels_like_c:toNumber(row.feels_like_c),
        feels_like_24h_min_c:toNumber(row.feels_like_24h_min_c),
        feels_like_24h_max_c:toNumber(row.feels_like_24h_max_c),
        status:row.status||((row.is_stale===true)?"stale":"live"),
        is_stale:row.status==="stale"||row.is_stale===true,
        age_minutes:toNumber(row.age_minutes),
        stale_after_minutes:20
      };
    }
    function workerHistoryToPageSamples(rows){
      if(!Array.isArray(rows))return [];
      const toNumber=value=>(value===null||value===undefined||value==="")?null:Number(value);
      return rows.map(row=>{
        // Station D1 stores canonical history fields as temperature_c/rain_1h_mm.
        // Keep both canonical and legacy aliases because the temperature and
        // rainfall charts consume the same sample array.
        const temp=toNumber(row.temperature_c == null ? row.temperature_2m_c : row.temperature_c);
        const rain1=toNumber(row.rain_1h_mm == null ? row.precipitation_1h_mm : row.rain_1h_mm);
        const rain10=toNumber(row.rain_10m_mm == null ? row.precipitation_10m_mm : row.rain_10m_mm);
        return {
          station_id:String(row.station_id||""),
          observed_at_utc:row.observed_at_utc||row.fetched_at_utc||null,
          logged_at_utc:row.fetched_at_utc||row.observed_at_utc||null,
          temperature_2m_c:temp,
          precipitation_1h_mm:rain1,
          precipitation_10m_mm:rain10,
          precipitation_6h_mm:toNumber(row.rain_6h_mm == null ? row.precipitation_6h_mm : row.rain_6h_mm),
          precipitation_12h_mm:toNumber(row.rain_12h_mm == null ? row.precipitation_12h_mm : row.rain_12h_mm),
          precipitation_24h_mm:toNumber(row.rain_24h_mm == null ? row.precipitation_24h_mm : row.rain_24h_mm),
          station_pressure_hpa:toNumber(row.pressure_hpa),
          humidity_percent:toNumber(row.humidity_percent),
          wind_speed_10m_kmh:toNumber(row.wind_speed_kmh),
          feels_like_c:toNumber(row.feels_like_c)
        };
      }).filter(row=>row.observed_at_utc);
    }
    // Station observations refresh independently from forecast/model data.

    async function refreshStationObservations(){
      const cacheKey=Date.now();
      try{
        const response=await fetchStationsApi("/stations?t="+cacheKey);
        if(!response.ok)throw new Error("Worker stations HTTP "+response.status);
        const document=await response.json();
        const rows=Array.isArray(document.stations)?document.stations:[];
        if(document.ok!==true||rows.length<3)throw new Error("Station gateway returned an incomplete station list");
        for(const row of rows){
          const station=workerStationToPageStation(row);
          if(!station)continue;
          if(station.station_id==="ENKA-BALMUMCU-WEATHERLINK")enkaStationObservation=station;
          if(station.station_id==="18101")eyupsultanStationObservation=station;
          if(station.station_id==="18401")sisliStationObservation=station;
        }
        renderStationCard(activeStation==="enka"?enkaStationObservation:activeStation==="eyupsultan"?eyupsultanStationObservation:sisliStationObservation);
        if(latestRainForecastPoints.length)renderRainWindow(latestRainForecastPoints);
if(typeof renderBriefing==="function")renderBriefing();
      }catch(error){
        console.warn("Worker istasyon verisi alınamadı:",error);
        if(!enkaStationObservation&&!eyupsultanStationObservation&&!sisliStationObservation){
          $("freshness").textContent="İSTASYON BAĞLANTISI YOK";
          $("freshness").classList.add("stale");
          $("station-observation-meta").textContent="İstasyon servisine bağlanılamadı; otomatik yeniden denenecek.";
          $("station-alert").hidden=false;
          $("station-alert").textContent="⚠ Canlı istasyon API bağlantısı kurulamadı. GFS tahminleri bundan bağımsız çalışır.";
        }
      }
    }
    async function refreshSelectedStation(){
      const stationKey=activeStation;
      const cacheKey=Date.now();
      try{
        const historyKeys=stationKey==="enka"?["enka","sisli"]:[stationKey];
        const [currentResponse,...historyResponses]=await Promise.all([
          fetchStationsApi("/stations/"+encodeURIComponent(stationKey)+"?t="+cacheKey),
          ...historyKeys.map(key=>fetchStationsApi("/history/"+encodeURIComponent(key)+"?hours=72&t="+cacheKey))
        ]);

        if(!currentResponse.ok)throw new Error("Selected station API HTTP "+currentResponse.status);
        const currentDocument=await currentResponse.json();
        if(currentDocument.ok!==true||!currentDocument.station)throw new Error("Selected station API returned no station payload");
        let currentLoaded=false;
        {
          const candidate=workerStationToPageStation(currentDocument.station);
          if(candidate){
            const candidateAge=Date.parse(candidate.observed_at_utc||"");
            const candidateFresh=Number.isFinite(candidateAge)&&((Date.now()-candidateAge)/60000)<20&&!candidate.is_stale;
            currentLoaded=candidateFresh;
            if(stationKey==="enka")enkaStationObservation=candidate;
            if(stationKey==="eyupsultan")eyupsultanStationObservation=candidate;
            if(stationKey==="sisli")sisliStationObservation=candidate;
          }
        }

        for(let i=0;i<historyResponses.length;i++){
          const response=historyResponses[i];
          if(!response.ok)continue;
          const document=await response.json();
          const samples=workerHistoryToPageSamples(document.samples == null ? document.history : document.samples);
          const historyKey=historyKeys[i];
          if(historyKey==="enka")enkaStationHistorySamples=samples;
          if(historyKey==="eyupsultan"){
            eyupsultanStationHistorySamples=samples;
            eyupsultanStationRainHistorySamples=samples;
          }
          if(historyKey==="sisli"){
            sisliStationHistorySamples=samples;
            sisliStationRainHistorySamples=samples;
          }
        }



        if(activeStation!==stationKey)return;
        const currentStation=activeStation==="enka"?enkaStationObservation:activeStation==="eyupsultan"?eyupsultanStationObservation:sisliStationObservation;
        renderStationCard(currentStation);
        updateStationLiveRanges(currentStation);
        renderStationHistory();
if(typeof renderBriefing==="function")renderBriefing();
      }catch(error){
        console.warn("Cloudflare istasyon API verisi alınamadı:",error);
        if(activeStation===stationKey&&!stationObservationIsFresh(stationKey==="enka"?enkaStationObservation:stationKey==="eyupsultan"?eyupsultanStationObservation:sisliStationObservation)){
          $("freshness").textContent="İSTASYON BAĞLANTISI YOK";
          $("freshness").classList.add("stale");
          $("station-alert").hidden=false;
          $("station-alert").textContent="⚠ "+(stationKey==="eyupsultan"?"Eyüpsultan":stationKey==="sisli"?"Şişli":"ENKA Balmumcu")+" ölçümü alınamadı; tekrar denenecek.";
        }
      }
    }
    async function loadForecast(){
      try{
        const cacheKey=Date.now();
        const response=await fetchForecastData("/gfs/latest?t="+cacheKey);
        if(!response.ok)throw new Error("Tahmin verisi şu anda alınamıyor.");
        const data=await response.json();
        if(!data||!["gfs-watch.forecast.v1","gfs-watch.forecast.v2"].includes(data.schema)){
          throw new Error("Tahmin verisinin biçimi beklenenden farklı.");
        }
        $("station-enka-button").classList.toggle("active",activeStation==="enka");
        $("station-eyupsultan-button").classList.toggle("active",activeStation==="eyupsultan");
        $("station-sisli-button").classList.toggle("active",activeStation==="sisli");
        $("station-enka-button").setAttribute("aria-pressed",String(activeStation==="enka"));
        $("station-eyupsultan-button").setAttribute("aria-pressed",String(activeStation==="eyupsultan"));
        $("station-sisli-button").setAttribute("aria-pressed",String(activeStation==="sisli"));
        render(data);
      }catch(error){
        // Forecast/model data is independent from live station data.
        $("daily-grid").innerHTML='<div class="error">'+esc(error.message)+'</div>';
        $("forecast-chart").innerHTML='<div class="chart-empty">Tahmin verisi şu anda alınamıyor. İstasyon ölçümleri bağımsız olarak çalışmaya devam ediyor.</div>';
        renderStationCard(activeStation==="enka"?enkaStationObservation:activeStation==="eyupsultan"?eyupsultanStationObservation:sisliStationObservation);
        renderStationHistory();
      }
    }
    let latestNotificationItems=[];
    
    function notificationAsset(path,cacheVersion){
      if(!path)return null;
      const url=/^https?:\/\//i.test(String(path))?new URL(String(path)):new URL("./data/notifications/"+path,window.location.href);
      if(cacheVersion)url.searchParams.set("v",String(cacheVersion));
      return url.href;
    }
    function renderNotifications(items,cacheVersion){
      const list=$("notifications-list");
      if(!Array.isArray(items)||!items.length){
        list.innerHTML='<div class="chart-empty">Henüz yayınlanmış bir grafik bulunmuyor.</div>';
        return;
      }
      list.innerHTML=items.slice(0,1).map(item=>{
        const legacyImage=notificationAsset(item.image_path,cacheVersion);
        const imageItems=Array.isArray(item.images)
          ? item.images.filter(image=>image&&typeof image.path==="string"&&/\.(?:png|svg)(?:[?#].*)?$/i.test(image.path)).map(image=>({url:notificationAsset(image.path,cacheVersion),isSvg:/\.svg(?:[?#]|$)/i.test(image.path)}))
          : legacyImage&&/\.(?:png|svg)(?:[?#]|$)/i.test(item.image_path||"")?[{url:legacyImage,isSvg:/\.svg(?:[?#]|$)/i.test(item.image_path||"")}]:[];
        const imagesHtml=imageItems.length>0
          ? '<div class="notification-images koy-fullframe-images koy-gfs-svg-images" style="background:#0A1B29!important">'+imageItems.map(image=>{
              const media=image.isSvg
                ? '<div class="gfs-interactive-chart" data-svg-src="'+image.url+'" data-chart-label="İstanbul GFS dört döngü valid-time karşılaştırması"><div class="gfs-chart-loading">GFS karşılaştırma grafiği yükleniyor…</div></div>'
                : '<a class="notification-image-link" href="'+image.url+'" target="_blank" rel="noopener"><img class="notification-image" src="'+image.url+'" alt="İstanbul GFS dört döngü karşılaştırması" loading="eager" decoding="async" fetchpriority="high"></a>';
              return '<div class="notification-image-item">'+media+'</div>';
            }).join("")+'</div>'
          : '<div class="media-pending">GFS karşılaştırma grafiği hazırlanıyor.</div>';
        return '<article class="notification-card notification-chart-only koy-gfs-report-card">'+imagesHtml+'</article>';
      }).join("");
      loadInteractiveGfsCharts(list);
    }
    
    async function registerAppWorker(){
      if(!("serviceWorker" in navigator))return;
      try{notificationRegistration=await navigator.serviceWorker.register("./service-worker.js");}
      catch(_){notificationRegistration=null;}
    }
    
    
    async function loadNotifications(){
      try{
        // Same flow as the working Köy page: use the native comparison
        // endpoint first and resolve the generated four-cycle SVG directly.
        const comparisonUrls=[
          ((window.ISTANBUL_GFS_API_BASE||window.location.origin).replace(/\/$/,"")+"/gfs/comparison"),
          "https://gfs-watch-istanbul-gfs.muhsin-ulusoy.workers.dev/gfs/comparison"
        ].filter((url,index,list)=>url&&list.indexOf(url)===index);
        let comparison=null;
        let comparisonError=null;
        for(const url of comparisonUrls){
          try{
            const response=await fetch(url+"?v="+Date.now(),{
              cache:"no-store",
              mode:url.startsWith(window.location.origin)?"same-origin":"cors"
            });
            if(response.ok){
              const doc=await response.json();
              if(Array.isArray(doc&&doc.runs)&&doc.runs.length){
                comparison=doc;
                break;
              }
            }
            comparisonError=new Error("GFS karşılaştırma API HTTP "+response.status);
          }catch(error){
            comparisonError=error;
          }
        }
        if(!comparison)throw comparisonError||new Error("GFS karşılaştırma verisi alınamadı.");

        const runs=comparison.runs.filter(run=>run&&run.run_id_utc).slice(0,4);
        const latestRun=runs[0];
        if(!latestRun)throw new Error("GFS karşılaştırma sonucu boş.");
        const runDate=new Date(latestRun.run_id_utc);
        const runStamp=runDate.getUTCFullYear()
          +String(runDate.getUTCMonth()+1).padStart(2,"0")
          +String(runDate.getUTCDate()).padStart(2,"0")
          +"T"+String(runDate.getUTCHours()).padStart(2,"0")+"Z";
        const version=encodeURIComponent(
          (comparison.updated_at_utc||latestRun.published_at_utc||latestRun.run_id_utc)
          +"|istanbul-svg-absolute-path-v1"
        );
        // Use the canonical D1 publication asset generated by the Istanbul GFS Worker.
        // The old static /data/notifications path can serve an archived SVG without the latest renderer.
        const gfsAssetApi=(window.ISTANBUL_GFS_API_BASE||"https://gfs-watch-istanbul-gfs.muhsin-ulusoy.workers.dev").replace(/\/$/,"");
        const svgPath=gfsAssetApi+"/gfs/publication-asset/notifications/istanbul-gfs-"+runStamp+"-comparison.svg";
        const svgUrl=svgPath+"?v="+encodeURIComponent(String(version)+"-d1-svg-v2-"+String(Date.now()));

        latestNotificationItems=runs;
        renderNotifications([{
          run_id_utc:latestRun.run_id_utc,
          published_at_utc:latestRun.published_at_utc||latestRun.run_id_utc,
          title:"İstanbul GFS · dört döngülü karşılaştırma",
          cycle_label:"MeteoPT GFS",
          images:[{
            label:"GFS dört döngü · aynı geçerlilik saatleri (TSİ)",
            path:svgUrl
          }]
        }],comparison.updated_at_utc||latestRun.published_at_utc||latestRun.run_id_utc);
        return;
      }catch(error){
        // Keep the existing archive manifest only as a fallback.
        try{
          const gfsApi=(window.ISTANBUL_GFS_API_BASE||"").replace(/\/$/,"");
          const archiveUrls=[
            (gfsApi?gfsApi+"/gfs/notification-latest":"/gfs/notification-latest"),
            "https://gfs-watch-istanbul-gfs.muhsin-ulusoy.workers.dev/gfs/notification-latest",
            "https://gfs-watch-istanbul-gfs.muhsin-ulusoy.workers.dev/gfs/publication-asset/notifications/latest.json",
            "./data/notifications/latest.json"
          ].filter((url,index,list)=>url&&list.indexOf(url)===index);
          let response=null;
          let lastArchiveError=null;
          for(const archiveUrl of archiveUrls){
            try{
              const candidate=await fetch(archiveUrl+"?t="+Date.now(),{
                cache:"no-store",
                mode:archiveUrl.startsWith(window.location.origin)?"same-origin":"cors"
              });
              if(candidate.ok){
                response=candidate;
                break;
              }
              lastArchiveError=new Error("Rapor arşivi HTTP "+candidate.status);
            }catch(fallbackError){
              lastArchiveError=fallbackError;
            }
          }
          if(!response)throw lastArchiveError||new Error("Rapor arşivi henüz oluşturulmadı.");
          const document=await response.json();
          if(document.schema!=="gfs-watch.notifications.v1"||!Array.isArray(document.items)||!document.items.length){
            throw new Error("Rapor arşivi biçimi geçersiz veya boş.");
          }
          latestNotificationItems=document.items.slice(0,4);
          renderNotifications(latestNotificationItems,document.updated_at_utc||document.items[0]&&document.items[0].published_at_utc||Date.now());
        }catch(fallbackError){
          console.error("İstanbul GFS report load failed:",error,fallbackError);
          throw fallbackError;
        }
      }
    }
    async function loadVerification(){
      if(VERIFY_URL){
        try{
          const response=await fetch(VERIFY_URL+"?t="+Date.now(),{cache:"no-store"});
          if(!response.ok)throw new Error("missing");
          verificationDoc=await response.json();
        }catch(_){
          verificationDoc=null;
        }
      }else{
        verificationDoc=null;
      }
      if(forecastData&&typeof renderBriefing==="function")renderBriefing();
    }

    let rainviewerMap=null,rainviewerLayer=null,rainviewerLoading=false,rainviewerFrames=[],rainviewerFrameIndex=0,rainviewerTimer=null;
    async function loadRadarGfsComparison(){
      const status=$("radar-gfs-status"),mapNode=$("rainviewer-map");
      if(rainviewerLoading)return;
      rainviewerLoading=true;
      try{
        if(!window.L)throw new Error("Harita kütüphanesi yüklenemedi.");
        const response=await fetch("https://api.rainviewer.com/public/weather-maps.json?t="+Date.now(),{cache:"no-store"});
        if(!response.ok)throw new Error("RainViewer verisi alınamadı (HTTP "+response.status+").");
        const doc=await response.json(),frames=doc.radar&&doc.radar.past||[];
        if(!frames.length)throw new Error("RainViewer radar karesi bulunamadı.");
        rainviewerFrames=frames.slice(-8);rainviewerFrameIndex=0;
        const host=doc.host||"https://tilecache.rainviewer.com";
        if(!rainviewerMap){
          rainviewerMap=L.map(mapNode,{zoomControl:true,scrollWheelZoom:false}).setView([41.014,28.950],8);
          L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:18,attribution:"© OpenStreetMap"}).addTo(rainviewerMap);
          L.circleMarker([41.014,28.950],{radius:6,color:"#ffffff",weight:2,fillColor:"#7dd3d7",fillOpacity:1}).addTo(rainviewerMap).bindPopup("İstanbul referans noktası");
        }
        const showRadarFrame=()=>{
          const frame=rainviewerFrames[rainviewerFrameIndex];
          const tileUrl=host+frame.path+"/256/{z}/{x}/{y}/2/1_1.png";
          if(rainviewerLayer)rainviewerMap.removeLayer(rainviewerLayer);
          rainviewerLayer=L.tileLayer(tileUrl,{opacity:.72,maxZoom:12,tileSize:256,attribution:"RainViewer"}).addTo(rainviewerMap);
          $("radar-frame-time").textContent="Radar hareketi · "+istStamp(new Date(frame.time*1000).toISOString())+" TSİ · "+(rainviewerFrameIndex+1)+"/"+rainviewerFrames.length;
          rainviewerFrameIndex=(rainviewerFrameIndex+1)%rainviewerFrames.length;
        };
        showRadarFrame();
        if(rainviewerTimer)clearInterval(rainviewerTimer);
        rainviewerTimer=setInterval(showRadarFrame,900);
        const target=$("radar-gfs-precipitation");
        if(target){
          target.innerHTML='<div class="chart-empty">GFS yağış tahmini grafiği bu projeden kaldırıldı.</div>';
          $("radar-gfs-forecast-time").textContent="Model grafiği devre dışı";
        }
        status.textContent="RainViewer güncellendi · "+new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit"}).format(new Date())+" TSİ";
        setTimeout(()=>rainviewerMap&&rainviewerMap.invalidateSize(),100);
      }catch(error){
        status.textContent="Radar: "+(error.message||"geçici bağlantı sorunu");
        if(!rainviewerMap)mapNode.innerHTML='<div class="chart-empty">RainViewer radarı şu anda yüklenemiyor. Otomatik olarak yeniden denenecek.</div>';
      }finally{rainviewerLoading=false;}
    }
    async function startPage(){
      // Start weather data lanes immediately and independently. PWA/push setup
      // must never delay or block live station observations.
      void Promise.allSettled([
        loadForecast(),
        loadNotifications(),
        refreshStationObservations(),
        refreshSelectedStation(),
        loadVerification()
      ]);
      void registerAppWorker().catch(error=>console.warn("PWA kurulumu istasyon verisini engellemedi:",error));
      window.setInterval(()=>{loadForecast();loadNotifications();loadVerification();loadRadarGfsComparison();refreshSelectedStation();},300000);
      window.setInterval(refreshStationObservations,60000);
      window.setInterval(refreshSelectedStation,60000);
    }

    let ecmwfForecast=null,ecmwfLoading=false,ecmwfLastFetch=0;
    let activeModel="gfs";
    
    function renderEcmwfReportImages(document){
      const holder=$("ecmwf-report-images");
      if(!holder)return;
      const images=Array.isArray(document.report_images)?document.report_images:[];
      if(images.length<4){
        holder.innerHTML='<article class="chart-card"><div class="chart-empty">Dört çıktının PNG raporu henüz yok.</div></article>';
        return;
      }
      const version=encodeURIComponent(document.updated_at_utc||"");
      holder.innerHTML=images.slice(0,4).map(image=>{
        const url="./data/ecmwf/"+image.path+"?v="+version;
        return '<article class="chart-card"><div class="chart-card-head"><div class="chart-title">'+esc(image.label)+'</div></div><a class="notification-image-link" href="'+url+'" target="_blank" rel="noopener"><img class="notification-image" src="'+url+'" alt="'+esc(image.label)+' · son dört ECMWF çıktısı"></a></article>';
      }).join("");
    }
    function renderEcmwfForecast(document){
      const forecasts=document.forecasts||[];
      const first=forecasts[0],last=forecasts[forecasts.length-1];
      if(!first||!last)throw new Error("ECMWF tahmin zaman serisi boş.");
      const viewData={schema:"gfs-watch.ecmwf-eps.v1",model:document.model,forecast_horizon_hours:document.forecast_horizon_hours,forecast_6_hourly:document.forecast_6_hourly,daily_summary:document.daily_summary,regional_pressure_analysis:document.regional_pressure_analysis};
      if(!Array.isArray(viewData.forecast_6_hourly)||viewData.forecast_6_hourly.length!==forecasts.length)throw new Error("ECMWF ortak tahmin zaman çizelgesi eksik.");
      if(!Array.isArray(viewData.daily_summary)||!viewData.daily_summary.length)throw new Error("ECMWF günlük özet verisi eksik.");
      $("ecmwf-run-meta").textContent="Döngü: "+timeUTC(document.run_id_utc)+" UTC · Geçerlilik: +"+last.forecast_hour+" saat";
      if($("ecmwf-daily-cycle-chip"))$("ecmwf-daily-cycle-chip").textContent="Döngü: "+timeUTC(document.run_id_utc)+" UTC";
      if($("ecmwf-daily-updated-chip"))$("ecmwf-daily-updated-chip").textContent="Yayınlandı: "+timeTR(document.updated_at_utc)+" TSİ";
      $("ecmwf-updated-chip").textContent="Yayınlandı · "+timeTR(document.updated_at_utc);
      $("ecmwf-valid-until").textContent="Son geçerlilik: "+new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"2-digit"}).format(new Date(document.forecast_valid_until_utc));
      renderDaily(viewData.daily_summary,"ecmwf-daily-grid");
      renderEcmwfReportImages(document);
      renderFindings(viewData.regional_pressure_analysis&&viewData.regional_pressure_analysis.findings,first.mslp&&first.mslp.mean_hpa,"ecmwf-pressure-findings");
    }
    async function loadEcmwf(force=false){
      if(ecmwfLoading)return;
      if(!force&&ecmwfForecast&&Date.now()-ecmwfLastFetch<240000)return;
      ecmwfLoading=true;
      try{
        const response=await fetch(ECMWF_DATA_URL+"?t="+Date.now(),{cache:"no-store"});
        if(!response.ok)throw new Error("ECMWF veri paketi henüz yayımlanmamış (HTTP "+response.status+").");
        const document=await response.json();
        if(!document||document.schema!=="gfs-watch.ecmwf-eps.v1"||document.status!=="ready"||!Array.isArray(document.forecasts)||document.forecasts.length<8){
          throw new Error("ECMWF IFS veri paketi eksik veya beklenen biçimde değil.");
        }
        renderEcmwfForecast(document);
        ecmwfForecast=document;
        ecmwfLastFetch=Date.now();
        if(typeof renderBriefing==="function")renderBriefing();
      }catch(error){
      }finally{
        ecmwfLoading=false;
      }
    }
    function setModelView(mode,persist=true){
      activeModel=mode==="ecmwf"?"ecmwf":"gfs";
      const ecmwf=activeModel==="ecmwf";
      const gfsButton=$("model-gfs-button");
      const ecmwfButton=$("model-ecmwf-button");
      const gfsView=$("gfs-model-view");
      const ecmwfView=$("ecmwf-model-view");
      if(gfsView)gfsView.hidden=ecmwf;
      if(ecmwfView)ecmwfView.hidden=!ecmwf;
      if(gfsButton){
        gfsButton.classList.toggle("active",!ecmwf);
        gfsButton.setAttribute("aria-pressed",String(!ecmwf));
      }
      if(ecmwfButton){
        ecmwfButton.classList.toggle("active",ecmwf);
        ecmwfButton.setAttribute("aria-pressed",String(ecmwf));
      }
      const nav=document.querySelector(".topbar nav");
      if(nav)nav.hidden=ecmwf;
      if(persist){try{localStorage.setItem("istanbul-hava-model-view",activeModel);}catch(_){}}
      if(typeof renderBriefing==="function")renderBriefing();
      loadEcmwf();
    }
    const modelGfsButton=$("model-gfs-button");
    const modelEcmwfButton=$("model-ecmwf-button");
    if(modelGfsButton)modelGfsButton.addEventListener("click",()=>setModelView("gfs"));
    if(modelEcmwfButton)modelEcmwfButton.addEventListener("click",()=>setModelView("ecmwf"));
    try{if(localStorage.getItem("istanbul-hava-model-view")==="ecmwf")activeModel="ecmwf";}catch(_){}
    setModelView(activeModel,false);

    // Pressure-center panel: fetch the live GFS 0–120 h analysis on page load.
    loadGithubPressureCenters();

    startPage();
  