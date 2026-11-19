(() => {
  "use strict";

  const TZ = "Europe/Istanbul";
  const API = "./api/climate";
  const CURRENT_API = "https://api.open-meteo.com/v1/forecast?latitude=40.955664&longitude=39.006648&current=temperature_2m&timezone=Europe%2FIstanbul";

  const $ = id => document.getElementById(id);
  const fmt = (v, digits = 1) => {
    const x = Number(v);
    return Number.isFinite(x) ? x.toLocaleString("tr-TR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }) : "—";
  };
  const MODEL_META = {
    cerra: { label:"CERRA", resolution:"5.5 KM" },
    era5: { label:"ERA5", resolution:"~31 KM" },
    era5_land: { label:"ERA5-LAND", resolution:"~9 KM" }
  };

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  async function getJSON(url) {
    const response = await fetch(url, { cache:"no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  }

  async function loadCurrentTemperature() {
    try {
      const doc = await getJSON(CURRENT_API);
      return Number.isFinite(Number(doc?.current?.temperature_2m))
        ? Number(doc.current.temperature_2m)
        : null;
    } catch (_) {
      return null;
    }
  }

  function render(data, model, currentTemp) {
    if (!data) throw new Error("Climate cache is empty");

    const meta = MODEL_META[model];
    const month = data.month || {};
    const long = data.long_term || {};
    const anomaly = data.precipitation_anomaly || {};
    const current = currentTemp != null ? currentTemp : long.current_temperature_c;

    setText("climate-period",
      String(data.month_name || "").toUpperCase() +
      " · NOV 1 – " + String(data.month_readings_through_day || "—") +
      " · STATION / MODEL READINGS<br>40.956°N, 39.007°E");

    setText("climate-avg-temp", fmt(month.avg_temp_c) + "°C");
    setText("climate-month-high", fmt(month.high_c) + "°C");
    setText("climate-month-low", fmt(month.low_c) + "°C");
    setText("climate-month-precip", fmt(month.precipitation_mm) + " mm");
    setText("climate-avg-wind", fmt(month.avg_wind_kmh) + " km/h");
    setText("climate-max-wind", fmt(month.max_wind_kmh) + " km/h");

    setText("climate-long-title",
      "LONG TERM FOR " + String(data.month_readings_through_day || "—") +
      " " + String(data.month_name || "").toUpperCase() +
      " · " + meta.label + " · " +
      String(data.historical_start_year) + "–" +
      String(data.historical_end_year) + " · " + meta.resolution);

    const min = Number(long.min_c);
    const max = Number(long.max_c);
    let pct = 50;
    if (Number.isFinite(min) && Number.isFinite(max) && max > min && current != null) {
      pct = Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100));
    }

    const dot = $("climate-now-dot");
    const label = $("climate-now-label");
    if (dot) dot.style.left = pct + "%";
    if (label) {
      label.style.left = pct + "%";
      label.textContent = "now " + fmt(current) + "°C";
    }

    setText("climate-min-label", fmt(long.min_c) + "°C · " + (long.min_year ?? "—"));
    setText("climate-avg-label", "avg " + fmt(long.avg_c) + "°C");
    setText("climate-max-label", fmt(long.max_c) + "°C · " + (long.max_year ?? "—"));

    setText("climate-today-mean", fmt(long.today_mean_c) + "°C");
    const delta = Number.isFinite(Number(long.today_mean_c)) && Number.isFinite(Number(long.avg_c))
      ? Number(long.today_mean_c) - Number(long.avg_c) : null;
    setText("climate-today-diff",
      delta == null ? "uzun dönem karşılaştırması yok" :
      "today " + (delta >= 0 ? "+" : "") + fmt(delta) + "°C vs long-term avg");

    setText("climate-record-precip", fmt(long.record_daily_precipitation_mm) + " mm");
    setText("climate-record-year", long.record_daily_precipitation_year ?? "—");
    setText("climate-today-precip", fmt(long.today_precipitation_mm) + " mm");

    const ratio = Number(long.record_daily_precipitation_mm) > 0 && Number.isFinite(Number(long.today_precipitation_mm))
      ? Number(long.today_precipitation_mm) / Number(long.record_daily_precipitation_mm) * 100
      : null;
    setText("climate-precip-ratio",
      ratio == null ? "—" : Math.round(ratio) + "% of the record");

    setText("climate-anomaly-value",
      anomaly.percent == null ? "—" :
      (Number(anomaly.percent) >= 0 ? "+" : "") + fmt(anomaly.percent) + "%");
    setText("climate-anomaly-detail",
      anomaly.normal_mm == null
        ? "Uzun dönem Kasım normali hesaplanamadı."
        : "Kasım uzun dönem ortalaması " + fmt(anomaly.normal_mm) +
          " mm · şimdi " + fmt(anomaly.current_mm) + " mm");
    setText("climate-anomaly-source",
      meta.label + " · " + data.historical_start_year + "–" + data.historical_end_year);

    setText("climate-status",
      "Cloudflare D1 · gece güncellendi · " +
      new Intl.DateTimeFormat("tr-TR", {
        timeZone:TZ, day:"2-digit", month:"2-digit",
        hour:"2-digit", minute:"2-digit"
      }).format(new Date(data.updated_at_utc || Date.now())) + " TSİ");
  }

  async function loadModel(model) {
    document.querySelectorAll(".climate-tab").forEach(tab => {
      const active = tab.dataset.model === model;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });

    setText("climate-status", MODEL_META[model].label + " · Cloudflare D1 verisi yükleniyor…");

    try {
      const [response, currentTemp] = await Promise.all([
        getJSON(API + "?model=" + encodeURIComponent(model)),
        loadCurrentTemperature()
      ]);
      if (!response.ok || !response.data) throw new Error(response.error || "Climate data unavailable");
      render(response.data, model, currentTemp);
    } catch (error) {
      console.error("Köy klimatoloji paneli:", error);
      setText("climate-status", "Cloudflare iklim verisi alınamadı");
    }
  }

  document.querySelectorAll(".climate-tab").forEach(tab => {
    tab.addEventListener("click", () => loadModel(tab.dataset.model));
  });

  loadModel("cerra");
})();