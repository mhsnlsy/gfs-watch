(() => {
  "use strict";

  const LAT = 40.955664;
  const LON = 39.006648;
  const TZ = "Europe/Istanbul";
  const START_YEAR = 1984;

  const $ = id => document.getElementById(id);
  const n = v => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const fmt = (v, digits = 1) => {
    const x = n(v);
    return x == null ? "—" : x.toLocaleString("tr-TR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));

  const MODEL_META = {
    cerra: { label:"CERRA", years:"1984–2026", resolution:"5.5 KM" },
    era5: { label:"ERA5", years:"1984–2026", resolution:"~31 KM" },
    era5_land: { label:"ERA5-LAND", years:"1984–2026", resolution:"~9 KM" }
  };

  function dateKey(d) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit"
    }).format(d);
  }

  function monthName(d) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, month:"long"
    }).format(d).toUpperCase();
  }

  function todayParts() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit"
    }).formatToParts(new Date());
    const o = {};
    parts.forEach(p => { if (p.type !== "literal") o[p.type] = Number(p.value); });
    return o;
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function archiveUrl(model, start, end) {
    const daily = [
      "temperature_2m_max",
      "temperature_2m_min",
      "temperature_2m_mean",
      "precipitation_sum"
    ].join(",");
    return "https://archive-api.open-meteo.com/v1/archive"
      + "?latitude=" + LAT
      + "&longitude=" + LON
      + "&start_date=" + start
      + "&end_date=" + end
      + "&daily=" + daily
      + "&models=" + encodeURIComponent(model)
      + "&timezone=" + encodeURIComponent(TZ);
  }

  async function json(url) {
    const r = await fetch(url, { cache:"no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  async function fetchCurrent() {
    const url = "https://api.open-meteo.com/v1/forecast"
      + "?latitude=" + LAT + "&longitude=" + LON
      + "&current=temperature_2m,wind_speed_10m"
      + "&daily=temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum"
      + "&past_days=1&forecast_days=1&timezone=" + encodeURIComponent(TZ);
    return json(url);
  }

  function rows(doc) {
    const d = doc && doc.daily;
    if (!d || !Array.isArray(d.time)) return [];
    return d.time.map((time, i) => ({
      time,
      year: Number(time.slice(0,4)),
      month: Number(time.slice(5,7)),
      day: Number(time.slice(8,10)),
      mean:n(d.temperature_2m_mean && d.temperature_2m_mean[i]),
      max:n(d.temperature_2m_max && d.temperature_2m_max[i]),
      min:n(d.temperature_2m_min && d.temperature_2m_min[i]),
      precip:n(d.precipitation_sum && d.precipitation_sum[i]) || 0
    }));
  }

  function average(a) {
    const v = a.filter(x => x != null);
    return v.length ? v.reduce((s,x)=>s+x,0)/v.length : null;
  }

  function currentDayValue(current, key) {
    const today = dateKey(new Date());
    const i = current.daily && current.daily.time
      ? current.daily.time.indexOf(today) : -1;
    return i >= 0 ? n(current.daily[key] && current.daily[key][i]) : null;
  }

  function renderMonth(data, current, model) {
    const now = todayParts();
    const monthRows = rows(data).filter(r => r.year === now.year && r.month === now.month && r.day <= now.day);
    const means = monthRows.map(r=>r.mean).filter(v=>v!=null);
    const highs = monthRows.map(r=>r.max).filter(v=>v!=null);
    const lows = monthRows.map(r=>r.min).filter(v=>v!=null);
    const precip = monthRows.reduce((s,r)=>s+(r.precip||0),0);

    setText("climate-period",
      monthName(new Date()) + " · NOV 1 – " + now.day + " · MODEL DAILY DATA");
    setText("climate-avg-temp", fmt(average(means)) + "°C");
    setText("climate-month-high", fmt(highs.length ? Math.max(...highs) : null) + "°C");
    setText("climate-month-low", fmt(lows.length ? Math.min(...lows) : null) + "°C");
    setText("climate-month-precip", fmt(precip) + " mm");

    // Daily archive does not expose a true monthly mean wind consistently
    // across all three model datasets. Use the forecast hourly field for the
    // current month only when available; otherwise keep the card honest.
    setText("climate-avg-wind", "— km/h");
    setText("climate-max-wind", "— km/h");

    const meta = MODEL_META[model];
    setText("climate-long-title",
      "LONG TERM FOR " + now.day + " " + monthName(new Date()) +
      " · " + meta.label + " · " + meta.years + " · " + meta.resolution);
  }

  function renderLongTerm(hist, current, model) {
    const now = todayParts();
    const all = rows(hist).filter(r => r.month === now.month && r.day === now.day && r.mean != null);
    if (!all.length) {
      setText("climate-now", "now —°C");
      setText("climate-min-label", "—");
      setText("climate-avg-label", "avg —°C");
      setText("climate-max-label", "—");
      return;
    }

    const values = all.map(r=>r.mean);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = average(values);
    const currentNow = n(current && current.current && current.current.temperature_2m);
    const todayMean = currentDayValue(current, "temperature_2m_mean");
    const nowValue = currentNow != null ? currentNow : todayMean;

    const minRow = all.find(r=>r.mean === min);
    const maxRow = all.find(r=>r.mean === max);

    let pct = 50;
    if (max > min && nowValue != null) {
      pct = Math.max(0, Math.min(100, ((nowValue-min)/(max-min))*100));
    }
    const dot = $("climate-now-dot");
    const label = $("climate-now-label");
    if (dot) dot.style.left = pct + "%";
    if (label) {
      label.style.left = pct + "%";
      label.textContent = "now " + fmt(nowValue) + "°C";
    }

    setText("climate-min-label", fmt(min) + "°C · " + minRow.year);
    setText("climate-avg-label", "avg " + fmt(avg) + "°C");
    setText("climate-max-label", fmt(max) + "°C · " + maxRow.year);

    setText("climate-today-mean", fmt(todayMean) + "°C");
    const delta = todayMean != null && avg != null ? todayMean - avg : null;
    setText("climate-today-diff",
      delta == null ? "uzun dönem karşılaştırması yok" :
      "today " + (delta >= 0 ? "+" : "") + fmt(delta) + "°C vs long-term avg");

    // Record daily precipitation for the same calendar day.
    const wet = all.map(r=>({precip:r.precip||0,year:r.year}));
    const record = wet.reduce((best,r)=>!best || r.precip > best.precip ? r : best, null);
    const todayPrecip = currentDayValue(current, "precipitation_sum");
    setText("climate-record-precip", fmt(record ? record.precip : null) + " mm");
    setText("climate-record-year", record ? String(record.year) : "—");
    setText("climate-today-precip", fmt(todayPrecip) + " mm");

    const ratio = record && record.precip > 0 && todayPrecip != null
      ? (todayPrecip / record.precip) * 100 : null;
    setText("climate-precip-ratio",
      ratio == null ? "—" : Math.round(ratio) + "% of the record");
  }

  function renderAnomaly(hist, current, model) {
    const now = todayParts();
    const currentRows = rows(hist).filter(r => r.year === now.year && r.month === now.month && r.day <= now.day);
    const currentTotal = currentRows.reduce((s,r)=>s+(r.precip||0),0);

    const byYear = new Map();
    rows(hist).filter(r => r.month === now.month).forEach(r => {
      if (!byYear.has(r.year)) byYear.set(r.year, 0);
      byYear.set(r.year, byYear.get(r.year) + (r.precip || 0));
    });

    const totals = [...byYear.entries()]
      .filter(([year]) => year < now.year)
      .map(([,total]) => total);
    const normal = average(totals);
    const anomaly = normal != null && normal !== 0
      ? ((currentTotal-normal)/normal)*100 : null;

    setText("climate-anomaly-value",
      anomaly == null ? "—" :
      (anomaly >= 0 ? "+" : "") + fmt(anomaly,1) + "%");
    setText("climate-anomaly-detail",
      normal == null
        ? "Uzun dönem Kasım normali hesaplanamadı."
        : "Kasım uzun dönem ortalaması " + fmt(normal,1) +
          " mm · şimdi " + fmt(currentTotal,1) + " mm");

    const bar = $("climate-anomaly-bar");
    if (bar && anomaly != null) {
      const clamped = Math.max(-100, Math.min(100, anomaly));
      bar.style.setProperty("--anomaly", clamped + "%");
      bar.classList.toggle("positive", anomaly >= 0);
    }

    setText("climate-anomaly-source",
      MODEL_META[model].label + " · " + START_YEAR + "–" + (now.year-1) +
      " aynı ay toplamları");
  }

  async function loadModel(model) {
    const meta = MODEL_META[model];
    document.querySelectorAll(".climate-tab").forEach(t => {
      const active = t.dataset.model === model;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });

    setText("climate-status", meta.label + " verisi yükleniyor…");

    try {
      const now = todayParts();
      const end = now.year + "-" + String(now.month).padStart(2,"0") + "-" + String(now.day).padStart(2,"0");
      const hist = await json(archiveUrl(model, START_YEAR + "-01-01", end));
      const current = await fetchCurrent();

      renderMonth(hist, current, model);
      renderLongTerm(hist, current, model);
      renderAnomaly(hist, current, model);

      setText("climate-status",
        "Güncellendi · " + new Intl.DateTimeFormat("tr-TR", {
          timeZone:TZ, day:"2-digit", month:"2-digit",
          hour:"2-digit", minute:"2-digit"
        }).format(new Date()) + " TSİ");
    } catch (e) {
      console.error("Köy klimatoloji paneli:", e);
      setText("climate-status", "Veri alınamadı · tekrar denenecek");
    }
  }

  document.querySelectorAll(".climate-tab").forEach(tab => {
    tab.addEventListener("click", () => loadModel(tab.dataset.model));
  });

  loadModel("cerra");
})();