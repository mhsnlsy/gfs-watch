(() => {
  "use strict";
  const ROOT = "meteopt-gfs-table";
  // The homepage MeteoPT table uses the canonical F180-ready payload.
  // This is the same MeteoPT GFS run, not a second forecast source.
  const API_BASE = () => String(window.ISTANBUL_GFS_API_BASE || window.location.origin || "").replace(/\/+$/, "");
  const DATA_URL = () => API_BASE() + "/gfs/latest";
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
    else if (field === "t2m" || field === "dewpoint") band = v < 0 ? "mt-blue" : v < 8 ? "mt-green" : v < 16 ? "mt-yellow" : v < 24 ? "mt-orange" : v < 32 ? "mt-red" : "mt-purple";
    else if (field === "rh2m") band = v < 30 ? "rh2m-warm-1" : v < 45 ? "rh2m-warm-2" : v < 60 ? "rh2m-warm-3" : v < 75 ? "rh2m-cool-1" : v < 90 ? "rh2m-cool-2" : "rh2m-cool-3";
    else if (field === "t850") band = v < -10 ? "mt-blue" : v < -2 ? "mt-green" : v < 6 ? "mt-yellow" : v < 14 ? "mt-orange" : v < 22 ? "mt-red" : "mt-purple";
    else if (field === "t500") band = v < -35 ? "mt-blue" : v < -25 ? "mt-green" : v < -15 ? "mt-yellow" : v < -5 ? "mt-orange" : v < 5 ? "mt-red" : "mt-purple";
    else if (field === "clouds") band = v < 10 ? "mt-blue" : v < 30 ? "mt-green" : v < 50 ? "mt-yellow" : v < 75 ? "mt-orange" : v < 90 ? "mt-red" : "mt-purple";
    else if (field === "snowln") band = v < 1000 ? "mt-blue" : v < 1500 ? "mt-green" : v < 2000 ? "mt-yellow" : v < 2500 ? "mt-orange" : v < 3000 ? "mt-red" : "mt-purple";
    return band;
  }

  function display(value, digits = 1) {
    return value === null ? "—" : value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function dewpoint(temp, humidity) {
    if (temp === null || humidity === null || humidity <= 0 || humidity > 100) return null;
    const a = 17.62;
    const b = 243.12;
    const gamma = Math.log(humidity / 100) + (a * temp) / (b + temp);
    const result = (b * gamma) / (a - gamma);
    return Number.isFinite(result) ? result : null;
  }

  function valueCell(value, field, digits = 1) {
    if (value === null) return '<span class="meteopt-value">—</span>';
    const cls = colour(field, value);
    return '<span class="meteopt-value ' + cls + '">' + display(value, digits) + '</span>';
  }

  function dateLabel(point, runId, step) {
    let date = point && point.valid_time_utc
      ? new Date(point.valid_time_utc)
      : new Date(new Date(runId).getTime() + step * 3600000);

    if (!Number.isFinite(date.getTime())) return "—";

    // MeteoPT panel convention: Step 3 of the 12Z run is displayed as 15 TSİ,
    // not 18 TSİ. The published forecast values themselves are not changed.
    date = new Date(date.getTime() - 3 * 3600000);

    const datePart = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Istanbul",
      weekday: "short",
      day: "numeric",
      month: "short"
    }).format(date);

    const hour = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Istanbul",
      hour: "2-digit",
      hourCycle: "h23"
    }).format(date);

    return datePart + " " + hour + " TSİ";
  }

  function render(document) {
    const body = $("meteopt-table-body");
    if (!body) return;

    const points = Array.isArray(document.forecast_6_hourly)
      ? document.forecast_6_hourly
      : [];

    // Show all 3-hourly forecast steps from the F180-ready MeteoPT payload.
    const pointsThrough180h = points.filter(point => {
      const step = Number(point.forecast_hour);
      return Number.isFinite(step) && step > 0 && step <= 180 && step % 3 === 0;
    });

    const pointByHour = new Map(points.map(point => [Number(point.forecast_hour), point]));
    const rows = [];
    const hours = pointsThrough180h
      .map(point => ({ step: Number(point.forecast_hour), point }))
      .sort((a, b) => a.step - b.step);

    for (const item of hours) {
      if (!Number.isFinite(item.step) || item.step <= 0 || item.step > 180) continue;

      const point = item.point || pointByHour.get(item.step) || null;
      const wind10 = point ? number(point.wind_speed_10m_kmh) : null;
      const wind850 = point ? number(point.wind_speed_850hpa_kmh) : null;
      const precip = point ? number(point.precipitation_6h_mm) : null;
      const temp2 = point ? number(point.temperature_2m_c) : null;
      const rh2m = point ? number(point.humidity_2m_percent) : null;
      const temp850 = point ? number(point.temperature_850hpa_c) : null;
      const snowln = point ? number(point.snowln) : null;

      const values = [
        valueCell(temp2, "t2m"),
        valueCell(precip, "precip"),
        valueCell(wind10, "wind", 0),
        valueCell(temp850, "t850"),
        valueCell(wind850, "wind", 0),
        valueCell(rh2m, "rh2m", 0),
        valueCell(dewpoint(temp2, rh2m), "dewpoint"),
        valueCell(snowln, "snowln", 0)
      ];

      rows.push(
        '<tr><td>' + item.step + '</td><td>' + dateLabel(point, document.run_id_utc, item.step) +
        '</td>' + values.map(value => '<td>' + value + '</td>').join("") + '</tr>'
      );
    }

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="10" class="meteopt-table-empty">Bu GFS çıktısında tablo satırı bulunamadı.</td></tr>';
      $("meteopt-table-status").textContent = "Tahmin adımı bulunamadı";
      return;
    }

    body.innerHTML = rows.join("");

    const run = document.run_id_utc ? new Date(document.run_id_utc) : null;
    $("meteopt-table-run").textContent = run && Number.isFinite(run.getTime())
      ? "Run: " + new Intl.DateTimeFormat("en-GB", {
          timeZone: "UTC",
          weekday: "short",
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          hourCycle: "h23"
        }).format(run) + "Z"
      : "GFS döngüsü";

    $("meteopt-table-updated").textContent = document.published_at_utc
      ? "Yayın: " + new Intl.DateTimeFormat("tr-TR", {
          timeZone: "Europe/Istanbul",
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit"
        }).format(new Date(document.published_at_utc)) + " TSİ"
      : "Yayın zamanı bilinmiyor";

    $("meteopt-table-status").textContent = rows.length + " / 60 adım · 3 saatlik · 180. saate kadar";
  }

  async function refresh() {
    const status = $("meteopt-table-status");

    try {
      const response = await fetch(DATA_URL() + "?meteopt-table-f180=" + Date.now(), {
        cache: "no-store"
      });
      if (!response.ok) throw new Error("F180 HTTP " + response.status);

      const document = await response.json();

      if (
        !document ||
        document.forecast_source !== "meteopt" ||
        !Array.isArray(document.forecast_6_hourly)
      ) {
        throw new Error("MeteoPT GFS verisi henüz yayınlanmadı.");
      }

      // Render the live payload before publishing the shared event used by
      // the homepage rain badges. Without this call the fetch succeeds but
      // the visible table status never advances beyond its initial state.
      render(document);

      // Publish only the first 72h to the existing rain-badge event so its
      // current consumers keep their original near-term contract.
      const points72 = Array.isArray(document.forecast_6_hourly)
        ? document.forecast_6_hourly.map(point => ({
            modelLead: Number(point.forecast_hour),
            stamp: Date.parse(point.valid_time_utc),
            precipitation_6h_mm: number(point.precipitation_6h_mm)
          })).filter(point =>
            Number.isFinite(point.modelLead) &&
            Number.isFinite(point.stamp) &&
            point.modelLead > 0 &&
            point.modelLead <= 72 &&
            point.modelLead % 3 === 0
          )
        : [];
      window.__METEOPT_F180_DOCUMENT = document;
      window.__METEOPT_F72_DOCUMENT = document;
      window.dispatchEvent(new CustomEvent("meteopt-gfs-f72-updated", {
        detail: { document, points: points72 }
      }));
    } catch (error) {
      if (status) status.textContent = "MeteoPT tablosu yüklenemedi: " + error.message;

      const body = $("meteopt-table-body");
      if (body && !body.querySelector("tr")) {
        body.innerHTML = '<tr><td colspan="10" class="meteopt-table-empty">Veri bekleniyor…</td></tr>';
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", refresh, { once: true });
  } else {
    refresh();
  }

  window.setInterval(() => {
    if (document.visibilityState !== "hidden") refresh();
  }, 300000);
})();