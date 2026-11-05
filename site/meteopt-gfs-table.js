(() => {
  "use strict";
  const ROOT = "meteopt-gfs-table";
  // The table is populated from the independent f72 publication, not the f180 report bundle.
  const DATA_URL = "./data/meteopt-gfs-first72.json";
  const $ = (id) => document.getElementById(id);
  const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const number = (value) => finite(value) ? Number(value) : null;
  function colour(field, value) {
    if (value === null) return "";
    const v = value;
    let band = "mt-blue";
    if (field === "wind") band = v < 10 ? "mt-blue" : v < 20 ? "mt-green" : v < 30 ? "mt-yellow" : v < 45 ? "mt-orange" : v < 60 ? "mt-red" : "mt-purple";
    else if (field === "precip") band = Number(v.toFixed(1)) === 0 ? "mt-gray" : v < .1 ? "mt-blue" : v < 1 ? "mt-green" : v < 2.5 ? "mt-yellow" : v < 5 ? "mt-orange" : v < 10 ? "mt-red" : "mt-purple";
    else if (field === "li") band = v <= -6 ? "mt-purple" : v <= -4 ? "mt-red" : v <= -2 ? "mt-orange" : v <= 0 ? "mt-yellow" : v <= 2 ? "mt-green" : "mt-blue";
    else if (field === "t2m") band = v < 0 ? "mt-blue" : v < 8 ? "mt-green" : v < 16 ? "mt-yellow" : v < 24 ? "mt-orange" : v < 32 ? "mt-red" : "mt-purple";
    else if (field === "rh2m") band = v < 30 ? "mt-blue" : v < 50 ? "mt-green" : v < 70 ? "mt-yellow" : v < 85 ? "mt-orange" : v < 95 ? "mt-red" : "mt-purple";
    else if (field === "t850") band = v < -10 ? "mt-blue" : v < -2 ? "mt-green" : v < 6 ? "mt-yellow" : v < 14 ? "mt-orange" : v < 22 ? "mt-red" : "mt-purple";
    else if (field === "t500") band = v < -35 ? "mt-blue" : v < -25 ? "mt-green" : v < -15 ? "mt-yellow" : v < -5 ? "mt-orange" : v < 5 ? "mt-red" : "mt-purple";
    else if (field === "clouds") band = v < 10 ? "mt-blue" : v < 30 ? "mt-green" : v < 50 ? "mt-yellow" : v < 75 ? "mt-orange" : v < 90 ? "mt-red" : "mt-purple";
    else if (field === "snowln") band = v < 1000 ? "mt-blue" : v < 1500 ? "mt-green" : v < 2000 ? "mt-yellow" : v < 2500 ? "mt-orange" : v < 3000 ? "mt-red" : "mt-purple";
    return band;
  }
  function display(value, digits = 1) {
    return value === null ? "—" : value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function valueCell(value, field, digits = 1) {
    if (value === null) return '<span class="meteopt-value">—</span>';
    const cls = colour(field, value);
    return '<span class="meteopt-value ' + cls + '">' + display(value, digits) + '</span>';
  }
  function dateLabel(point, runId, step) {
    let date = point && point.valid_time_utc ? new Date(point.valid_time_utc) : new Date(new Date(runId).getTime() + step * 3600000);
    if (!Number.isFinite(date.getTime())) return "—";
    // MeteoPT panel convention: the forecast step is displayed on the Istanbul
    // clock with the feed's 3-hour UTC/TSI alignment corrected here. This keeps
    // Step 3 of the 12Z run at 15 TSİ (not 18 TSİ), while preserving the data values.
    date = new Date(date.getTime() - 3 * 3600000);
    const datePart = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Istanbul", weekday: "short", day: "numeric", month: "short" }).format(date);
    const hour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Istanbul", hour: "2-digit", hourCycle: "h23" }).format(date);
    return datePart + " " + hour + " TSİ";
  }
  function render(document) {
    const body = $("meteopt-table-body");
    if (!body) return;
    const points = Array.isArray(document.forecast_6_hourly) ? document.forecast_6_hourly : [];
    const pointsThrough72h = points.filter(point => Number(point.forecast_hour) > 0 && Number(point.forecast_hour) <= 72);
    const pointByHour = new Map(points.map(point => [Number(point.forecast_hour), point]));
    const rows = [];
    const hours = pointsThrough72h.map(point => ({ step: Number(point.forecast_hour), point })).sort((a, b) => a.step - b.step);
    for (const item of hours) {
      if (!Number.isFinite(item.step) || item.step <= 0 || item.step > 72) continue;
      const point = item.point || pointByHour.get(item.step) || null;
      const wind10 = point ? number(point.wind_speed_10m_kmh) : null;
      const wind850 = point ? number(point.wind_speed_850hpa_kmh) : null;
      const precip = point ? number(point.precipitation_6h_mm) : null;
      const temp2 = point ? number(point.temperature_2m_c) : null;
      const temp850 = point ? number(point.temperature_850hpa_c) : null;
      const values = [
        valueCell(wind10, "wind", 0),
        valueCell(wind850, "wind", 0),
        valueCell(precip, "precip"),
        valueCell(temp2, "t2m"),
        valueCell(temp850, "t850")
      ];
      rows.push('<tr><td>' + item.step + '</td><td>' + dateLabel(point, document.run_id_utc, item.step) + '</td>' + values.map(value => '<td>' + value + '</td>').join("") + '</tr>');
    }
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="meteopt-table-empty">Bu GFS çıktısında tablo satırı bulunamadı.</td></tr>';
      $("meteopt-table-status").textContent = "Tahmin adımı bulunamadı";
      return;
    }
    body.innerHTML = rows.join("");
    const run = document.run_id_utc ? new Date(document.run_id_utc) : null;
    $("meteopt-table-run").textContent = run && Number.isFinite(run.getTime())
      ? "Run: " + new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", hourCycle: "h23" }).format(run) + "Z"
      : "GFS döngüsü";
    $("meteopt-table-updated").textContent = document.published_at_utc
      ? "Yayın: " + new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(document.published_at_utc)) + " TSİ"
      : "Yayın zamanı bilinmiyor";
    $("meteopt-table-status").textContent = rows.length + " / 24 adım · 72. saate kadar";
  }
  async function refresh() {
    const status = $("meteopt-table-status");
    try {
      const response = await fetch(DATA_URL + "?meteopt-table=" + Date.now(), { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const document = await response.json();
      if (!document || document.forecast_source !== "meteopt" || !Array.isArray(document.forecast_6_hourly)) {
        throw new Error("MeteoPT GFS f72 tablosu henüz yayınlanmadı; f72 bekleniyor.");
      }
      render(document);
    } catch (error) {
      if (status) status.textContent = "MeteoPT tablosu yüklenemedi: " + error.message;
      const body = $("meteopt-table-body");
      if (body && !body.querySelector("tr")) body.innerHTML = '<tr><td colspan="12" class="meteopt-table-empty">Veri bekleniyor…</td></tr>';
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refresh, { once: true });
  else refresh();
  window.setInterval(() => {
    if (document.visibilityState !== "hidden") refresh();
  }, 300000);
})();