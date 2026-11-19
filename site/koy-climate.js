(() => {
  "use strict";

  const TZ = "Europe/Istanbul";
  const CLIMATE_API = "https://gfs-watch-koy-gfs.muhsin-ulusoy.workers.dev/api/climate";
  const STATION_MONTH_API = "https://gfs-watch-stations.muhsin-ulusoy.workers.dev/api/climate/month/canakci";

  const $ = id => document.getElementById(id);
  const fmt = (value, digits = 1) => {
    if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "—";
    return Number(value).toLocaleString("tr-TR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  };

  const MODEL_META = {
    cerra: {
      label: "CERRA",
      resolution: "5 km",
      note: "Avrupa bölgesel yeniden analizi · 1985–Haziran 2021"
    },
    era5: {
      label: "ERA5",
      resolution: "~25 km",
      note: "Küresel yeniden analiz · 1940–güncel (yaklaşık 5 gün gecikmeli)"
    },
    era5_land: {
      label: "ERA5-Land",
      resolution: "~11 km",
      note: "Kara yüzeyi yeniden analizi · 1950–güncel; yağış ve rüzgâr bu veri setinde sunulmuyor"
    }
  };

  let selectedModel = "cerra";
  let stationMonthCache = null;
  let stationMonthFetchedAt = 0;
  let requestSequence = 0;

  function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  function clearValues() {
    [
      ["climate-avg-temp", "—°C"],
      ["climate-month-high", "—°C"],
      ["climate-month-low", "—°C"],
      ["climate-month-precip", "— mm"],
      ["climate-avg-wind", "— km/h"],
      ["climate-max-wind", "— km/h"],
      ["climate-min-label", "—"],
      ["climate-avg-label", "avg —°C"],
      ["climate-max-label", "—"],
      ["climate-today-mean", "—°C"],
      ["climate-today-diff", "—"],
      ["climate-record-precip", "— mm"],
      ["climate-record-year", "—"],
      ["climate-today-precip", "— mm"],
      ["climate-precip-ratio", "—"],
      ["climate-anomaly-value", "—"],
      ["climate-anomaly-detail", "Model veya istasyon verisi yüklenemedi."],
      ["climate-anomaly-source", "—"]
    ].forEach(([id, value]) => setText(id, value));

    const dot = $("climate-now-dot");
    const label = $("climate-now-label");
    if (dot) dot.style.left = "0%";
    if (label) {
      label.style.left = "0%";
      label.textContent = "now —°C";
    }
  }

  async function getJSON(url, attempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          headers: { "Accept": "application/json" }
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          const error = new Error(body?.error || ("HTTP " + response.status));
          error.status = response.status;
          throw error;
        }
        return body;
      } catch (error) {
        lastError = error;
        if (attempt === attempts || (error.status && error.status < 500 && error.status !== 429)) break;
        await new Promise(resolve => setTimeout(resolve, attempt * 1200));
      }
    }
    throw lastError || new Error("API request failed");
  }

  async function loadStationMonth() {
    if (stationMonthCache && Date.now() - stationMonthFetchedAt < 120000) {
      return stationMonthCache;
    }
    const document = await getJSON(STATION_MONTH_API);
    if (document?.ok !== true || document?.schema !== "koy-station-month.v1") {
      throw new Error(document?.error || "MGM aylık istasyon verisi geçersiz");
    }
    if (document.station?.key !== "canakci") {
      throw new Error("Aylık gözlem verisi Çanakçı istasyonuna ait değil");
    }
    stationMonthCache = document;
    stationMonthFetchedAt = Date.now();
    return document;
  }

  function localDateLabel(date) {
    const value = new Date(date + "T12:00:00+03:00");
    return new Intl.DateTimeFormat("tr-TR", {
      timeZone: TZ,
      day: "numeric",
      month: "long",
      year: "numeric"
    }).format(value);
  }

  function render(historical, station) {
    if (!historical || historical.model !== selectedModel) {
      throw new Error("İstenen modelin kendi klimatoloji verisi dönmedi");
    }
    const meta = MODEL_META[selectedModel];
    const month = station.month || {};
    const today = station.today || {};
    const long = historical.long_term || {};
    const normal = historical.precipitation_normal_to_date || {};
    const supported = historical.supported || {};

    // "This month" is calculated only from actual MGM Çanakçı station
    // observations stored in the station Worker's Cloudflare D1 history.
    setText("climate-period",
      String(historical.month_name || "").toUpperCase() +
      " · " + localDateLabel(station.period_date) +
      " itibarıyla · MGM Çanakçı ölçümleri\n40.956°N, 39.007°E");

    setText("climate-avg-temp", fmt(month.avg_temp_c) + "°C");
    setText("climate-month-high", fmt(month.high_c) + "°C");
    setText("climate-month-low", fmt(month.low_c) + "°C");
    setText("climate-month-precip",
      month.precipitation_mm == null || !supported.precipitation
        ? "— mm"
        : fmt(month.precipitation_mm) + " mm");
    setText("climate-avg-wind",
      month.avg_wind_kmh == null || !supported.wind
        ? "— km/h"
        : fmt(month.avg_wind_kmh) + " km/h");
    setText("climate-max-wind",
      month.max_wind_kmh == null || !supported.wind
        ? "— km/h"
        : fmt(month.max_wind_kmh) + " km/h");

    setText("climate-long-title",
      "LONG TERM FOR " + String(station.period_date).slice(8, 10) +
      " " + String(historical.month_name || "").toUpperCase() +
      " · " + meta.label + " · " +
      String(historical.historical_start_year) + "–" +
      String(historical.historical_end_year) + " · " + meta.resolution);

    const current = station.current;
    const currentIsLive = current &&
      current.status === "live" &&
      current.is_stale !== true &&
      Number.isFinite(Number(current.temperature_c));
    const currentTemp = currentIsLive ? Number(current.temperature_c) : null;

    const rangeMin = Number(long.min_c);
    const rangeMax = Number(long.max_c);
    let position = 50;
    if (Number.isFinite(rangeMin) && Number.isFinite(rangeMax) &&
        rangeMax > rangeMin && currentTemp !== null) {
      position = Math.max(0, Math.min(100,
        (currentTemp - rangeMin) / (rangeMax - rangeMin) * 100));
    }
    const dot = $("climate-now-dot");
    const label = $("climate-now-label");
    if (dot) dot.style.left = position + "%";
    if (label) {
      label.style.left = position + "%";
      label.textContent = (currentIsLive ? "now " : "son canlı ölçüm yok · ") +
        fmt(currentTemp) + "°C";
      label.classList.toggle("stale", !currentIsLive);
    }

    setText("climate-min-label", fmt(long.min_c) + "°C · " + (long.min_year ?? "—"));
    setText("climate-avg-label", "avg " + fmt(long.avg_c) + "°C");
    setText("climate-max-label", fmt(long.max_c) + "°C · " + (long.max_year ?? "—"));

    setText("climate-today-mean",
      today.mean_temp_c == null ? "—°C" : fmt(today.mean_temp_c) + "°C");
    const todayDelta = Number.isFinite(Number(today.mean_temp_c)) &&
      Number.isFinite(Number(long.avg_c))
      ? Number(today.mean_temp_c) - Number(long.avg_c)
      : null;
    setText("climate-today-diff",
      todayDelta == null
        ? "Aynı takvim günü için uzun dönem karşılaştırması yok"
        : (todayDelta >= 0 ? "+" : "") + fmt(todayDelta) +
          "°C · aynı günün uzun dönem ortalamasına göre");

    setText("climate-record-precip",
      supported.precipitation && long.record_daily_precipitation_mm != null
        ? fmt(long.record_daily_precipitation_mm) + " mm"
        : "— mm");
    setText("climate-record-year",
      supported.precipitation
        ? (long.record_daily_precipitation_year ?? "—")
        : "Bu modelde yağış değişkeni yok");
    setText("climate-today-precip",
      supported.precipitation && today.precipitation_mm != null
        ? fmt(today.precipitation_mm) + " mm"
        : "— mm");

    const record = Number(long.record_daily_precipitation_mm);
    const todayRain = today.precipitation_mm == null ? null : Number(today.precipitation_mm);
    const ratio = supported.precipitation &&
      Number.isFinite(record) && record > 0 &&
      todayRain !== null && Number.isFinite(todayRain)
      ? todayRain / record * 100
      : null;
    setText("climate-precip-ratio",
      ratio == null ? "Günlük kayıt karşılaştırması yok" :
      fmt(ratio, 0) + "% · tarihsel günlük rekorun");

    const currentRain = month.precipitation_mm == null ? null : Number(month.precipitation_mm);
    const normalRain = normal.normal_mm == null ? null : Number(normal.normal_mm);
    const anomaly = supported.precipitation &&
      currentRain !== null && Number.isFinite(currentRain) &&
      normalRain !== null && Number.isFinite(normalRain) && normalRain > 0
      ? (currentRain - normalRain) / normalRain * 100
      : null;
    setText("climate-anomaly-value",
      anomaly == null ? "—" :
      (anomaly >= 0 ? "+" : "") + fmt(anomaly) + "%");
    setText("climate-anomaly-detail",
      anomaly == null
        ? "Bu model için yağış anomalisini hesaplayacak veri bulunmuyor."
        : "MGM ay başından bugüne " + fmt(currentRain) +
          " mm · tarihsel aynı dönemin ortalaması " + fmt(normalRain) +
          " mm · " + (normal.years || 0) + " yıl");
    setText("climate-anomaly-label",
      String(historical.month_name || "").toUpperCase() + " " +
      String(station.period_date).slice(0, 4) + " YAĞIŞ ANOMALİSİ");
    setText("climate-anomaly-source",
      supported.precipitation
        ? meta.label + " · " + historical.historical_start_year +
          "–" + historical.historical_end_year
        : meta.label + " · yağış desteklenmiyor");

    const monthDate = new Intl.DateTimeFormat("tr-TR", {
      timeZone: TZ, month: "long", year: "numeric"
    }).format(new Date(station.period_date + "T12:00:00+03:00"));

    const coverage = station.coverage || {};
    const statusParts = [
      "MGM D1 · " + (month.days_with_temperature || 0) +
        "/" + (month.days_elapsed || 0) + " gün sıcaklık ölçümü",
      meta.label + " uzun dönem · " +
        historical.historical_day_sample_count + " aynı-gün örneği",
      "Güncelleme " + new Intl.DateTimeFormat("tr-TR", {
        timeZone: TZ, day: "2-digit", month: "2-digit",
        hour: "2-digit", minute: "2-digit"
      }).format(new Date(station.updated_at_utc || Date.now())) + " TSİ"
    ];
    setText("climate-status", statusParts.join(" · "));
    setText("climate-source-note",
      "Bu ay: MGM Çanakçı istasyon arşivi (" +
      (station.station?.station_id || "istasyon no yok") +
      ") · " + monthDate +
      " · Long term: " + meta.label + " yeniden analiz arşivi · " +
      meta.note + " · Eksik istasyon günleri tahminle doldurulmaz.");
  }

  function setSelectedTab(model) {
    document.querySelectorAll(".climate-tab").forEach(tab => {
      const active = tab.dataset.model === model;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  async function loadModel(model) {
    if (!MODEL_META[model]) return;
    selectedModel = model;
    const sequence = ++requestSequence;
    setSelectedTab(model);
    clearValues();
    setText("climate-status", MODEL_META[model].label + " · MGM ve uzun dönem verisi yükleniyor…");

    try {
      const [historicalDoc, stationDoc] = await Promise.all([
        getJSON(CLIMATE_API + "?model=" + encodeURIComponent(model)),
        loadStationMonth()
      ]);
      if (sequence !== requestSequence) return;
      if (historicalDoc?.ok !== true || historicalDoc?.data?.model !== model) {
        throw new Error(historicalDoc?.error || "İstenen modelin bağımsız arşiv verisi bulunamadı");
      }
      if (stationDoc?.ok !== true || stationDoc?.station?.key !== "canakci") {
        throw new Error("MGM Çanakçı aylık ölçüm verisi doğrulanamadı");
      }
      render(historicalDoc.data, stationDoc);
    } catch (error) {
      if (sequence !== requestSequence) return;
      console.error("Köy klimatoloji paneli:", error);
      clearValues();
      setText("climate-status",
        MODEL_META[model].label + " verisi kullanılamıyor · " +
        String(error?.message || error));
      setText("climate-source-note",
        "Bu modelin verisi alınamadığı için başka model veya eski istasyon değeri gösterilmedi.");
    }
  }

  document.querySelectorAll(".climate-tab").forEach(tab => {
    tab.addEventListener("click", () => loadModel(tab.dataset.model));
  });

  loadModel("cerra");
})();
