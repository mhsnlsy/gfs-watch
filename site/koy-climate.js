(() => {
  "use strict";

  const TZ = "Europe/Istanbul";
  const API = "https://gfs-watch-koy-gfs.muhsin-ulusoy.workers.dev/api/climate";
  const MONTH_API = "https://gfs-watch-stations.muhsin-ulusoy.workers.dev/api/climate/month/canakci";
  const $ = id => document.getElementById(id);
  const MODEL_META = {
    cerra: { label: "CERRA", resolution: "5 km" },
    era5: { label: "ERA5", resolution: "~25 km" },
    era5_land: { label: "ERA5-LAND", resolution: "~11 km" }
  };
  let activeRequest = 0;
  let monthlyData = null;

  const fmt = (value, digits = 1) => {
    if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "—";
    return Number(value).toLocaleString("tr-TR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  };

  const asNumber = value => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  function monthName(data) {
    return String(data?.month_name || "").toLocaleUpperCase("tr-TR");
  }

  function clearModelValues() {
    [
      ["climate-avg-temp", "—°C"],
      ["climate-month-high", "—°C"],
      ["climate-month-low", "—°C"],
      ["climate-month-precip", "— mm"],
      ["climate-avg-wind", "— km/h"],
      ["climate-max-wind", "— km/h"],
      ["climate-long-title", "LONG TERM · VERİ YÜKLENİYOR"],
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
      ["climate-anomaly-detail", "—"],
      ["climate-anomaly-source", "—"]
    ].forEach(([id, value]) => setText(id, value));

    const dot = $("climate-now-dot");
    const label = $("climate-now-label");
    if (dot) dot.style.display = "none";
    if (label) {
      label.style.display = "none";
      label.textContent = "now —°C";
    }
  }

  async function getJSON(url) {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });
    const text = await response.text();
    let document;
    try {
      document = JSON.parse(text);
    } catch (_) {
      throw new Error("Sunucu geçerli JSON döndürmedi (HTTP " + response.status + ")");
    }
    if (!response.ok) {
      throw new Error(document.error || ("HTTP " + response.status));
    }
    return document;
  }

  function renderMonth(monthData) {
    if (!monthData || monthData.ok !== true || !monthData.month) {
      throw new Error("MGM aylık istasyon özeti eksik");
    }
    monthlyData = monthData;
    const month = monthData.month;
    const current = monthData.current || {};
    const coverage = monthData.coverage || {};
    const today = monthData.today || {};

    setText("climate-period",
      monthName(monthData) + " · 1–" + month.days_elapsed +
      " · MGM ÇANAKÇI GERÇEK İSTASYON ÖLÇÜMLERİ\n40.956°N, 39.007°E");

    setText("climate-avg-temp", fmt(month.avg_temp_c) + "°C");
    setText("climate-month-high", fmt(month.high_c) + "°C");
    setText("climate-month-low", fmt(month.low_c) + "°C");
    setText("climate-month-precip", fmt(month.precipitation_mm) + " mm");
    setText("climate-avg-wind", fmt(month.avg_wind_kmh) + " km/h");
    setText("climate-max-wind", fmt(month.max_wind_kmh) + " km/h");

    const stamp = coverage.latest_sample_at_utc || current.fetched_at_utc || monthData.updated_at_utc;
    const stampText = stamp
      ? new Intl.DateTimeFormat("tr-TR", {
          timeZone: TZ, day: "2-digit", month: "2-digit",
          hour: "2-digit", minute: "2-digit"
        }).format(new Date(stamp)) + " TSİ"
      : "zaman bilgisi yok";
    setText("climate-status",
      "MGM Çanakçı · " +
      (coverage.temperature_days ?? month.days_with_temperature ?? 0) + "/" +
      month.days_elapsed + " gün · " +
      (month.sample_count ?? 0).toLocaleString("tr-TR") +
      " ölçüm · son kayıt " + stampText +
      (current.is_stale ? " · SON ÖLÇÜM ESKİ" : ""));
  }

  function renderLongTerm(data, model) {
    if (!data || data.schema !== "koy-climate.v2" || data.model !== model) {
      throw new Error("Tarihsel model verisi eksik veya model kimliği uyuşmuyor");
    }

    const meta = MODEL_META[model];
    const long = data.long_term || {};
    const normal = data.precipitation_normal_to_date || {};
    const supported = data.supported || {};
    const today = monthlyData?.today || {};
    const current = monthlyData?.current || {};
    const month = monthlyData?.month || {};
    const monthLabel = monthName(monthlyData);
    const currentTemperature = asNumber(current.temperature_c);
    const todayMean = asNumber(today.mean_temp_c);
    const sameDayAverage = asNumber(long.avg_c);

    setText("climate-long-title",
      "LONG TERM FOR " + String(data.period_date || "").slice(8, 10) +
      " " + monthLabel + " · " + meta.label + " · " +
      data.historical_start_year + "–" + data.historical_end_year +
      " · " + meta.resolution + " · " +
      (data.historical_year_count || data.historical_day_sample_count) + " YIL");

    const min = asNumber(long.min_c);
    const max = asNumber(long.max_c);
    let position = 50;
    if (min !== null && max !== null && max > min && currentTemperature !== null) {
      position = Math.max(0, Math.min(100, (currentTemperature - min) / (max - min) * 100));
    }

    const dot = $("climate-now-dot");
    const label = $("climate-now-label");
    if (dot) {
      dot.style.display = currentTemperature === null ? "none" : "block";
      dot.style.left = position + "%";
      dot.title = "MGM Çanakçı anlık sıcaklığı";
    }
    if (label) {
      label.style.display = currentTemperature === null ? "none" : "block";
      label.style.left = position + "%";
      label.textContent = "MGM now " + fmt(currentTemperature) + "°C";
    }

    setText("climate-min-label", fmt(long.min_c) + "°C · " + (long.min_year ?? "—"));
    setText("climate-avg-label", "avg " + fmt(long.avg_c) + "°C");
    setText("climate-max-label", fmt(long.max_c) + "°C · " + (long.max_year ?? "—"));

    setText("climate-today-mean",
      todayMean === null ? "—°C" : fmt(todayMean) + "°C");
    const delta = todayMean !== null && sameDayAverage !== null
      ? todayMean - sameDayAverage : null;
    setText("climate-today-diff",
      delta === null ? "Aynı takvim gününün uzun dönem ortalaması yok" :
      (delta >= 0 ? "+" : "") + fmt(delta) +
      "°C · aynı günün uzun dönem ortalamasına göre");

    if (supported.precipitation) {
      setText("climate-record-precip",
        long.record_daily_precipitation_mm === null
          ? "— mm" : fmt(long.record_daily_precipitation_mm) + " mm");
      setText("climate-record-year", long.record_daily_precipitation_year ?? "—");
      const todayPrecip = asNumber(today.precipitation_mm);
      setText("climate-today-precip",
        todayPrecip === null ? "— mm" : fmt(todayPrecip) + " mm");
      const record = asNumber(long.record_daily_precipitation_mm);
      const ratio = record !== null && record > 0 && todayPrecip !== null
        ? todayPrecip / record * 100 : null;
      setText("climate-precip-ratio",
        ratio === null ? "Kayıt karşılaştırması hesaplanamıyor" :
        fmt(ratio, 0) + "% · aynı takvim gününün rekoru");
    } else {
      setText("climate-record-precip", "Desteklenmiyor");
      setText("climate-record-year", "Bu modelde günlük yağış değişkeni yok");
      setText("climate-today-precip",
        today.precipitation_mm == null ? "— mm" : fmt(today.precipitation_mm) + " mm");
      setText("climate-precip-ratio", "Tarihsel yağış karşılaştırması yok");
    }

    if (supported.precipitation && normal.normal_mm !== null) {
      const actual = asNumber(month.precipitation_mm);
      const reference = asNumber(normal.normal_mm);
      const anomaly = actual !== null && reference !== null && reference > 0
        ? (actual / reference - 1) * 100 : null;
      setText("climate-anomaly-value",
        anomaly === null ? "—" : (anomaly >= 0 ? "+" : "") + fmt(anomaly) + "%");
      setText("climate-anomaly-detail",
        "MGM aylık yağış " + fmt(actual) + " mm · " +
        "uzun dönem aynı tarihe kadarki normal " + fmt(reference) +
        " mm · " + (normal.years || 0) + " yıllık karşılaştırma");
      setText("climate-anomaly-source",
        "MGM gerçekleşen / " + meta.label + " normali");
      const marker = $("climate-anomaly-bar")?.querySelector("i");
      if (marker && anomaly !== null) {
        marker.style.left = Math.max(3, Math.min(97, 50 + anomaly / 2)) + "%";
      }
    } else {
      setText("climate-anomaly-value", "—");
      setText("climate-anomaly-detail",
        supported.precipitation
          ? "Bu tarih aralığı için yağış normali hesaplanamadı."
          : "ERA5-Land bu arşiv uç noktasında yağış normali sağlamıyor.");
      setText("climate-anomaly-source", meta.label + " · desteklenmeyen değişken");
    }
  }

  async function loadModel(model) {
    const requestId = ++activeRequest;
    document.querySelectorAll(".climate-tab").forEach(tab => {
      const active = tab.dataset.model === model;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });

    clearModelValues();
    setText("climate-status", MODEL_META[model].label + " · Cloudflare verileri yükleniyor…");

    const results = await Promise.allSettled([
      getJSON(API + "?model=" + encodeURIComponent(model) + "&v=2"),
      getJSON(MONTH_API + "?v=1")
    ]);
    if (requestId !== activeRequest) return;

    const climateResult = results[0];
    const monthResult = results[1];
    if (monthResult.status === "fulfilled") {
      try {
        renderMonth(monthResult.value);
      } catch (error) {
        monthlyData = null;
        console.error("MGM aylık özet:", error);
        setText("climate-status", "MGM aylık istasyon verisi geçersiz");
      }
    } else {
      monthlyData = null;
      console.error("MGM aylık istasyon verisi:", monthResult.reason);
      setText("climate-status", "MGM aylık istasyon verisi alınamadı");
    }

    if (climateResult.status !== "fulfilled") {
      console.error("Köy tarihsel klimatoloji:", climateResult.reason);
      setText("climate-long-title", MODEL_META[model].label + " · TARİHSEL VERİ YOK");
      return;
    }

    const response = climateResult.value;
    if (!response.ok || !response.data) {
      setText("climate-long-title", MODEL_META[model].label + " · TARİHSEL VERİ YOK");
      setText("climate-status", "Cloudflare D1 · " + MODEL_META[model].label + " verisi bulunamadı");
      return;
    }

    try {
      renderLongTerm(response.data, model);
    } catch (error) {
      console.error("Köy tarihsel klimatoloji:", error);
      setText("climate-long-title", MODEL_META[model].label + " · VERİ DOĞRULAMASI BAŞARISIZ");
    }
  }

  document.querySelectorAll(".climate-tab").forEach(tab => {
    tab.addEventListener("click", () => loadModel(tab.dataset.model));
  });

  loadModel("cerra");
})();
