const PALETTE = ["#7DD3D7", "#8ABCE8", "#F1C98B", "#B38BE8"];
const PANELS = [
  { id: "temperature", field: "temperature_2m_c", title: "Sıcaklık", unit: "°C" },
  { id: "temperature_850", field: "temperature_850hpa_c", title: "850 hPa sıcaklık", unit: "°C" },
  { id: "precipitation", field: "precipitation_6h_mm", title: "Yağış", unit: "mm / 3 saat" },
  { id: "wind_10m", field: "wind_speed_10m_kmh", title: "10 m rüzgâr hızı", unit: "km/sa" },
];
const TR_OFFSET_MS = 3 * 60 * 60 * 1000;
const FONT = "system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[char]);
}

function isoMinute(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16) : null;
}

function localDate(value) {
  return new Date(new Date(value).getTime() + TR_OFFSET_MS);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatTrDate(date, includeTime = true) {
  const base = pad2(date.getUTCDate()) + "." + pad2(date.getUTCMonth() + 1) + "." + date.getUTCFullYear();
  return includeTime ? base + " " + pad2(date.getUTCHours()) + ":" + pad2(date.getUTCMinutes()) : base;
}

function formatUtcDate(date) {
  return pad2(date.getUTCDate()) + "." + pad2(date.getUTCMonth() + 1) + "." + date.getUTCFullYear() + " " +
    pad2(date.getUTCHours()) + ":" + pad2(date.getUTCMinutes());
}

function formatNumber(value, digits = 1) {
  const n = numeric(value);
  return n === null ? "—" : n.toFixed(digits);
}

function runLabel(runId, latest) {
  const date = new Date(runId);
  const label = pad2(date.getUTCHours()) + "Z | " + pad2(date.getUTCDate()) + "." +
    pad2(date.getUTCMonth() + 1) + " " + pad2(date.getUTCHours()) + ":00";
  return latest ? "YENİ · " + label : label;
}

function runStamp(runId) {
  const date = new Date(runId);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid GFS run id for publication asset");
  return date.getUTCFullYear() + pad2(date.getUTCMonth() + 1) + pad2(date.getUTCDate()) +
    "T" + pad2(date.getUTCHours()) + "Z";
}

function buildSeries(runs) {
  const docs = (Array.isArray(runs) ? runs : [])
    .filter(run => run && run.run_id_utc && Array.isArray(run.forecast_6_hourly))
    .slice()
    .sort((a, b) => Date.parse(a.run_id_utc) - Date.parse(b.run_id_utc))
    .slice(-4);
  if (docs.length < 1) throw new Error("At least one complete GFS run is required; found " + docs.length);

  const series = docs.map((document, index) => {
    const points = new Map();
    for (const point of document.forecast_6_hourly) {
      const key = isoMinute(point?.valid_time_utc);
      if (key) points.set(key, point);
    }
    if (!points.size) throw new Error("No valid forecast points for " + document.run_id_utc);
    return {
      document,
      points,
      label: runLabel(document.run_id_utc, index === docs.length - 1),
      color: PALETTE[index],
    };
  });

  let common = [...series[series.length - 1].points.keys()];
  for (const item of series.slice(0, -1)) common = common.filter(key => item.points.has(key));
  common.sort();
  if (common.length < 2) throw new Error("The available GFS cycles have fewer than two common valid times");

  const firstMs = Date.parse(common[0] + ":00Z");
  const validKeys = common.filter(key => {
    const timestamp = Date.parse(key + ":00Z");
    return timestamp >= firstMs && timestamp <= firstMs + 180 * 3600000;
  });
  if (validKeys.length < 2) throw new Error("The common valid-time window is too short");

  const pointsBySeries = series.map(item => validKeys.map(key => item.points.get(key)));
  const localLabels = validKeys.map(key => {
    const utc = new Date(key + ":00Z");
    const local = localDate(utc);
    return {
      localKey: local.getUTCFullYear() + "-" + pad2(local.getUTCMonth() + 1) + "-" +
        pad2(local.getUTCDate()) + "T" + pad2(local.getUTCHours()) + ":" + pad2(local.getUTCMinutes()),
      label: formatTrDate(local) + " TSİ",
      utcLabel: formatUtcDate(utc) + " UTC",
    };
  });
  const dates = validKeys.map(key => new Date(key + ":00Z"));
  const offsets = dates.map(date => (date.getTime() - firstMs) / 3600000);
  return { series, validKeys, pointsBySeries, localLabels, dates, offsets };
}

export function buildIstanbulInteractiveSvg(runs) {
  const chart = buildSeries(runs);
  const { series, validKeys, pointsBySeries, localLabels, dates, offsets } = chart;
  const W = 1152;
  const H = 838;
  const panelWidth = 505;
  const panelHeight = 250;
  const panelLeft = [55, 592];
  const panelTop = [214, 493];
  const firstOffset = offsets[0];
  const spanHours = offsets[offsets.length - 1] - firstOffset;
  const xMin = -1;
  const xMax = spanHours + Math.max(1, spanHours * 0.015);
  const xRatio = value => (value - xMin) / (xMax - xMin);

  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-labelledby="istanbul-gfs-svg-title istanbul-gfs-svg-desc">',
    '<title id="istanbul-gfs-svg-title">İstanbul GFS · dört döngü valid-time karşılaştırması</title>',
    '<desc id="istanbul-gfs-svg-desc">Dört İstanbul GFS tahmin döngüsü aynı geçerlilik saatlerinde hizalanmıştır. Sıcaklık, 850 hPa sıcaklığı, yağış ve 10 metre rüzgârı karşılaştırılır.</desc>',
    '<g id="patch_1"><rect x="0" y="0" width="1152" height="838" style="fill: #0a1b29"/></g>',
    '<text x="63" y="34" fill="#7DD3D7" font-size="12" font-weight="700" letter-spacing="1.5" font-family="' + FONT + '">GFS · İSTANBUL</text>',
    '<text x="63" y="76" fill="#FFFFFF" font-size="27" font-weight="750" font-family="' + FONT + '">Son GFS raporu · ' + series.length + ' döngü karşılaştırması</text>',
    '<text x="63" y="108" fill="#E7F2F6" font-size="14" font-family="' + FONT + '">Mevcut GFS çıktıları aynı geçerlilik saatlerinde (TSİ) üst üste karşılaştırılır.</text>',
    '<rect x="850" y="20" width="245" height="36" rx="11" fill="#0A1B29" stroke="#416174" stroke-width="1"/>',
    '<text x="972.5" y="43" text-anchor="middle" fill="#B8D7DF" font-size="12" font-family="' + FONT + '">' + series.length + ' GFS döngüsü karşılaştırılıyor</text>',
  ];

  series.slice().reverse().forEach((item, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 335 + column * 290;
    const y = 148 + row * 26;
    const latest = item === series[series.length - 1];
    parts.push(
      '<line x1="' + x + '" y1="' + y + '" x2="' + (x + 38) + '" y2="' + y + '" stroke="' + item.color +
      '" stroke-width="' + (latest ? 3.2 : 1.8) + '"' + (latest ? "" : ' stroke-dasharray="4 3"') + ' stroke-linecap="round"/>',
      '<text x="' + (x + 49) + '" y="' + (y + 4) + '" fill="#FFFFFF" font-size="12" font-weight="' +
      (latest ? "700" : "500") + '" font-family="' + FONT + '">' + escapeXml(item.label) + '</text>'
    );
  });

  const metadata = [];
  PANELS.forEach((spec, panelIndex) => {
    const column = panelIndex % 2;
    const row = Math.floor(panelIndex / 2);
    const px = panelLeft[column];
    const py = panelTop[row];
    const plotX = px + 50;
    const plotY = py + 57;
    const plotWidth = panelWidth - 73;
    const plotHeight = 146;
    const valuesBySeries = pointsBySeries.map(points => points.map(point => numeric(point?.[spec.field])));
    const allValues = valuesBySeries.flat().filter(value => value !== null);
    let low = 0;
    let high = 1;
    if (allValues.length) {
      if (spec.field === "temperature_2m_c" || spec.field === "temperature_850hpa_c") {
        low = Math.min(...allValues);
        high = Math.max(...allValues);
        const span = high - low;
        if (span < 4) {
          const center = (low + high) / 2;
          low = center - 2;
          high = center + 2;
        } else {
          const margin = Math.max(0.5, span * 0.08);
          low -= margin;
          high += margin;
        }
      } else {
        low = 0;
        high = Math.max(1, Math.max(...allValues) * 1.18);
      }
    }
    if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
      low = 0;
      high = 1;
    }

    const xPositions = offsets.map(offset => plotX + xRatio(offset) * plotWidth);
    const yFor = value => plotY + (high - value) * plotHeight / (high - low);
    const patchId = ["patch_6", "patch_11", "patch_16", "patch_21"][panelIndex];
    parts.push(
      '<g id="' + patchId + '"><rect x="' + px + '" y="' + py + '" width="' + panelWidth + '" height="' +
      panelHeight + '" rx="13" style="fill: #102a3a" stroke="#416174" stroke-width="1"/></g>',
      '<g id="istanbul-panel-' + spec.id + '">',
      '<text x="' + (px + 18) + '" y="' + (py + 31) + '" fill="#FFFFFF" font-size="18" font-weight="700" font-family="' +
      FONT + '">' + escapeXml(spec.title) + '</text>',
      '<text x="' + (px + panelWidth - 17) + '" y="' + (py + 30) + '" text-anchor="end" fill="#E7F2F6" font-size="12" font-weight="650" font-family="' +
      FONT + '">' + escapeXml(spec.unit) + '</text>'
    );

    for (let tick = 0; tick <= 4; tick += 1) {
      const value = high - (high - low) * tick / 4;
      const y = plotY + plotHeight * tick / 4;
      parts.push(
        '<line x1="' + plotX + '" y1="' + y + '" x2="' + (plotX + plotWidth) + '" y2="' + y +
        '" stroke="#456579" stroke-width="1" stroke-dasharray="2 4" opacity=".65"/>',
        '<text x="' + (plotX - 10) + '" y="' + (y + 4) + '" text-anchor="end" fill="#E7F2F6" font-size="11" font-weight="600" font-family="' +
        FONT + '">' + value.toFixed(1) + '</text>'
      );
    }

    const tickIndexes = [];
    offsets.forEach((offset, index) => {
      if (index === 0 || Math.abs(offset % 12) < 0.01) tickIndexes.push(index);
    });
    if (tickIndexes[tickIndexes.length - 1] !== offsets.length - 1) tickIndexes.push(offsets.length - 1);
    tickIndexes.forEach(index => {
      const d = localDate(dates[index]);
      const day = pad2(d.getUTCDate());
      const weekday = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"][d.getUTCDay()];
      const anchor = index === 0 ? "start" : index === offsets.length - 1 ? "end" : "middle";
      parts.push(
        '<text x="' + xPositions[index] + '" y="' + (plotY + plotHeight + 19) + '" text-anchor="' + anchor +
        '" fill="#E7F2F6" font-size="10" font-weight="650" font-family="' + FONT + '"><tspan x="' +
        xPositions[index] + '">' + day + '</tspan><tspan x="' + xPositions[index] + '" dy="13">' + weekday + '</tspan></text>'
      );
    });

    const panelSeries = [];
    series.forEach((item, seriesIndex) => {
      const values = valuesBySeries[seriesIndex];
      const yPositions = values.map(value => value === null ? null : Number(yFor(value).toFixed(3)));
      const leadHours = pointsBySeries[seriesIndex].map(point => {
        const n = Number(point?.forecast_hour);
        return Number.isFinite(n) ? Math.round(n) : null;
      });
      const directions = pointsBySeries[seriesIndex].map(point =>
        spec.field === "wind_speed_10m_kmh" ? numeric(point?.wind_direction_10m_deg) : null
      );
      let pathData = "";
      let open = false;
      values.forEach((value, index) => {
        if (value === null) { open = false; return; }
        pathData += (open ? " L " : " M ") + xPositions[index].toFixed(3) + " " + yPositions[index];
        open = true;
      });
      const latest = seriesIndex === series.length - 1;
      parts.push(
        '<path d="' + pathData + '" fill="none" stroke="' + item.color + '" stroke-width="' +
        (latest ? 3.2 : 1.8) + '"' + (latest ? "" : ' stroke-dasharray="4 3"') +
        ' stroke-linecap="round" stroke-linejoin="round" opacity="' + (latest ? "1" : ".94") + '"/>'
      );
      if (latest) values.forEach((value, index) => {
        if (value !== null) parts.push('<circle cx="' + xPositions[index].toFixed(3) + '" cy="' +
          yPositions[index] + '" r="2.8" fill="' + item.color + '"/>');
      });
      panelSeries.push({
        label: item.label,
        color: item.color,
        lead_hours: leadHours,
        values,
        y_positions: yPositions,
        directions_deg: directions,
      });
    });

    metadata.push({
      id: spec.id,
      title: spec.title,
      unit: spec.unit,
      plot: { x: plotX, y: plotY, width: plotWidth, height: plotHeight },
      x_positions: xPositions.map(value => Number(value.toFixed(3))),
      valid_times: localLabels.map(item => ({
        local_key: item.localKey,
        label: item.label,
        utc_label: item.utcLabel,
      })),
      series: panelSeries,
    });

    if (!allValues.length) {
      parts.push('<text x="' + (plotX + plotWidth / 2) + '" y="' + (plotY + plotHeight / 2) +
        '" text-anchor="middle" fill="#E7F2F6" font-size="13" font-family="' + FONT + '">Bu değişken için veri yok</text>');
    }
    parts.push("</g>");
  });

  const metadataText = JSON.stringify({ version: 1, renderer: "cloudflare-js-v1", panels: metadata })
    .replace(/\]\]>/g, "]]\\u003e");
  parts.push(
    '<text x="63" y="810" fill="#E7F2F6" font-size="11" font-family="' + FONT + '">Aynı geçerlilik saatleri (TSİ) · ' +
    validKeys.length + ' ortak nokta · ' + series.length + ' döngü</text>',
    '<text x="1090" y="810" text-anchor="end" fill="#E7F2F6" font-size="10" font-family="' + FONT +
    '">Kaynak: MeteoPT GFS · İstanbul nokta tahmini</text>',
    '<metadata id="gfs-renderer-version">cloudflare-js-v1</metadata>',
    '<metadata id="gfs-interactive-data"><![CDATA[' + metadataText + ']]></metadata>',
    '<g id="gfs-interaction-layer">'
  );
  metadata.forEach(panel => {
    const plot = panel.plot;
    const xStart = panel.x_positions[0];
    parts.push(
      '<g class="gfs-panel-interaction" data-panel-id="' + panel.id + '">',
      '<rect class="gfs-hit-area" data-panel-id="' + panel.id + '" x="' + plot.x + '" y="' + plot.y +
      '" width="' + plot.width + '" height="' + plot.height + '" fill="transparent" pointer-events="all" tabindex="0" role="group" aria-label="' +
      escapeXml(panel.title) + ' grafiği; ok tuşlarıyla geçerlilik saatleri arasında gezinin"/>',
      '<line class="gfs-tooltip-crosshair" x1="' + xStart + '" x2="' + xStart + '" y1="' + plot.y +
      '" y2="' + (plot.y + plot.height) + '" stroke="#EAF5F8" stroke-width="1.1" stroke-dasharray="4 4" opacity=".78" visibility="hidden" pointer-events="none"/>',
      '<g class="gfs-tooltip-markers" pointer-events="none"></g>',
      "</g>"
    );
  });
  parts.push("</g></svg>");
  const body = parts.join("");
  if (body.length > 1800000) throw new Error("Generated Istanbul SVG exceeds the D1 publication row safety limit");
  const latest = series[series.length - 1].document;
  return {
    key: "notifications/istanbul-gfs-" + runStamp(latest.run_id_utc) + "-comparison.svg",
    run_id_utc: latest.run_id_utc,
    body,
    common_valid_time_count: validKeys.length,
  };
}

export function buildIstanbulReportText(document, now = new Date(), stationObservation = null) {
  const run = new Date(document.run_id_utc);
  if (!Number.isFinite(run.getTime())) throw new Error("Invalid Istanbul GFS report run");
  const nowLocal = localDate(now);
  const forecast = Array.isArray(document.forecast_6_hourly) ? document.forecast_6_hourly : [];
  const todayKey = nowLocal.getUTCFullYear() + "-" + pad2(nowLocal.getUTCMonth() + 1) + "-" + pad2(nowLocal.getUTCDate());

  const lines = [
    "🌦 İstanbul'un Havası",
    "İSTANBUL GFS TAHMİN RAPORU",
    "🛰 Model döngüsü: " + formatUtcDate(run) + " UTC (" + pad2(run.getUTCHours()) + "Z)",
    "🕒 Rapor zamanı: " + formatTrDate(nowLocal) + " TSİ",
    "📍 Konum: İstanbul, Türkiye",
    "",
    "📡 ENKA BALMUMCU İSTASYON GÖZLEMİ",
    "",
    "",
    stationObservation && stationObservation.temperature_2m_c !== null && stationObservation.temperature_2m_c !== undefined
      ? "🌡 Sıcaklık: " + formatNumber(stationObservation.temperature_2m_c) + "°C"
      : "🌡 Sıcaklık: —",
    stationObservation && stationObservation.humidity_percent !== null && stationObservation.humidity_percent !== undefined
      ? "💧 Nem: " + formatNumber(stationObservation.humidity_percent) + "%"
      : "💧 Nem: —",
    stationObservation && stationObservation.station_pressure_hpa !== null && stationObservation.station_pressure_hpa !== undefined
      ? "🧭 İstasyon basıncı: " + formatNumber(stationObservation.station_pressure_hpa) + " hPa"
      : "🧭 İstasyon basıncı: —",
    stationObservation && stationObservation.wind_speed_10m_kmh !== null && stationObservation.wind_speed_10m_kmh !== undefined
      ? "💨 Rüzgâr: " + formatNumber(stationObservation.wind_speed_10m_kmh) + " km/sa" + (stationObservation.wind_direction_cardinal ? " " + stationObservation.wind_direction_cardinal : "")
      : "💨 Rüzgâr: —",
    stationObservation && stationObservation.observed_at_utc
      ? "🕒 Ölçüm: " + formatTrDate(localDate(stationObservation.observed_at_utc)) + " TSİ" +
        (Number.isFinite(Number(stationObservation.age_minutes)) ? " · " + Math.round(Number(stationObservation.age_minutes)) + " dk önce" : "")
      : "🕒 Ölçüm zamanı: —",
    stationObservation && stationObservation.is_stale
      ? "⚠️ İstasyon verisi 20 dakikadan eski; paneldeki son başarılı ölçüm kullanıldı."
      : stationObservation
        ? "✅ Veri: aktif ENKA Balmumcu istasyon panosundan alındı."
        : "⚠️ Aktif istasyon panosuna erişilemedi; istasyon verisi eklenemedi.",
    "",
    "🌆 GÜNÜN KALANINDA",
  ];

  const todayPoints = forecast.filter(point => {
    const valid = new Date(point.valid_time_utc);
    if (!Number.isFinite(valid.getTime())) return false;
    const local = localDate(valid);
    const key = local.getUTCFullYear() + "-" + pad2(local.getUTCMonth() + 1) + "-" + pad2(local.getUTCDate());
    return key === todayKey && local.getTime() > nowLocal.getTime();
  });
  const midnightLocal = new Date(Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate() + 1));
  lines.push("⏳ Süre: " + formatTrDate(nowLocal) + " – " + formatTrDate(midnightLocal) + " TSİ");
  if (todayPoints.length) {
    const temps = todayPoints.map(point => numeric(point.temperature_2m_c)).filter(value => value !== null);
    const winds = todayPoints.map(point => numeric(point.wind_speed_10m_kmh)).filter(value => value !== null);
    const rain = todayPoints.map(point => numeric(point.precipitation_6h_mm)).filter(value => value !== null)
      .reduce((sum, value) => sum + Math.max(0, value), 0);
    if (temps.length) lines.push("🌡 Sıcaklık: " + Math.min(...temps).toFixed(1) + "–" + Math.max(...temps).toFixed(1) + "°C");
    if (winds.length) lines.push("💨 Rüzgâr: en fazla " + Math.max(...winds).toFixed(1) + " km/sa");
    lines.push("🌧 Beklenen yağış: " + rain.toFixed(1) + " mm");
  } else {
    lines.push("Bu gece yarısına kadar kullanılabilir tahmin noktası bulunmuyor.");
  }

  lines.push("", "📅 ÖNÜMÜZDEKİ 3 GÜN");
  const days = (Array.isArray(document.daily_summary) ? document.daily_summary : [])
    .filter(day => String(day.date_istanbul || "") > todayKey)
    .slice(0, 3);
  const dayNames = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
  for (const day of days) {
    const parts = String(day.date_istanbul).split("-").map(Number);
    const year = parts[0], month = parts[1], date = parts[2];
    const local = new Date(Date.UTC(year, month - 1, date));
    const label = dayNames[local.getUTCDay()] + " " + pad2(date) + "." + pad2(month);
    const low = numeric(day.temperature_min_c);
    const high = numeric(day.temperature_max_c);
    const rain = numeric(day.precipitation_total_mm);
    const wind = numeric(day.wind_speed_max_10m_kmh);
    const tag = wind !== null && wind > 20 ? " | Rüzgârlı" : "";
    lines.push("• " + label + ": " + formatNumber(low) + "–" + formatNumber(high) +
      "°C | Yağış: " + formatNumber(rain) + " mm | Maks. rüzgâr: " + formatNumber(wind) + " km/sa" + tag);
    if (rain !== null && rain <= 0) lines.push("  ↳ Belirgin yağış beklenmiyor.");
  }
  if (!days.length) lines.push("Önümüzdeki üç gün için günlük özet bulunmuyor.");

  lines.push("", "📊 Karşılaştırma: Son dört GFS döngüsü aynı geçerlilik saatlerinde hizalandı.");
  return lines.join("\n");
}
