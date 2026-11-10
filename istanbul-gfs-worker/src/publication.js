import { buildPanelAxis, formatAxisTick, formatPeakValue, peakUnit } from "../../shared/gfs-chart-axis.js";

const CYCLE_COLORS = ["#8ABCE8", "#7DD3D7", "#F1C98B", "#B38BE8"];
const PANELS = [
  { id: "temperature", field: "temperature_2m_c", title: "Sıcaklık", unit: "°C" },
  { id: "temperature_850", field: "temperature_850hpa_c", title: "850 hPa sıcaklık", unit: "°C" },
  { id: "precipitation", field: "precipitation_6h_mm", title: "Yağış", unit: "mm / 3 saat" },
  { id: "wind_10m", field: "wind_speed_10m_kmh", title: "10 m rüzgâr hızı", unit: "km/sa" },
];
const TR_OFFSET_MS = 3 * 60 * 60 * 1000;
const FONT = "system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
const APP_NAME = "İstanbul Havası";
const APP_VERSION = "1.5.0";

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
  return n === null ? "—" : new Intl.NumberFormat("tr-TR", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
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
      color: CYCLE_COLORS.slice(-docs.length)[index],
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
    '<text x="1090" y="34" text-anchor="end" fill="#8EAEB7" font-size="8" font-weight="500" font-family="' + FONT + '">İstanbul Havası v' + APP_VERSION + '</text>',
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
  // Rüzgâr yönü sabit tek satır: oklar meteorolojik FROM yönünün
  // tersine, yani rüzgârın GİDİŞ yönüne bakar. Örn. GB rüzgârı → KD.
  const directionLegend = [
    ["↓", "K → G"], ["↙", "KD → GB"], ["←", "D → B"], ["↖", "GD → KB"],
    ["↑", "G → K"], ["↗", "GB → KD"], ["→", "B → D"], ["↘", "KB → GD"]
  ];
  parts.push(
    '<text x="335" y="201" fill="#8EAEB7" font-size="10" font-weight="700" font-family="' + FONT + '">RÜZGÂR · GİDİŞ YÖNÜ</text>'
  );
  directionLegend.forEach((item, index) => {
    const x = 430 + index * 66;
    parts.push(
      '<text x="' + x + '" y="201" text-anchor="middle" fill="#FFFFFF" font-size="15" font-weight="800" font-family="' + FONT + '">' +
      item[0] + '</text>',
      '<text x="' + x + '" y="213" text-anchor="middle" fill="#8EAEB7" font-size="7.5" font-weight="650" font-family="' + FONT + '">' +
      item[1] + '</text>'
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
    const axis = buildPanelAxis(spec.field, valuesBySeries);
    const { low, high, ticks, latestPeak } = axis;

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

    ticks.slice().reverse().forEach(value => {
      const y = yFor(value);
      parts.push(
        '<line x1="' + plotX + '" y1="' + y + '" x2="' + (plotX + plotWidth) + '" y2="' + y +
        '" stroke="#456579" stroke-width="1" stroke-dasharray="2 4" opacity=".65"/>',
        '<text x="' + (plotX - 10) + '" y="' + (y + 4) + '" text-anchor="end" fill="#E7F2F6" font-size="11" font-weight="600" font-family="' +
        FONT + '" data-axis-tick="true">' + formatAxisTick(value) + '</text>'
      );
    });

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
        '<path id="gfs-series-' + spec.id + '-' + seriesIndex + '" data-gfs-series-run-id="' +
        escapeXml(item.document.run_id_utc) + '" d="' + pathData + '" fill="none" stroke="' + item.color + '" stroke-width="' +
        (latest ? 3.2 : 1.8) + '"' + (latest ? "" : ' stroke-dasharray="4 3"') +
        ' stroke-linecap="round" stroke-linejoin="round" opacity="' + (latest ? "1" : ".94") + '"/>'
      );
      if (latest) values.forEach((value, index) => {
        if (value !== null) parts.push('<circle cx="' + xPositions[index].toFixed(3) + '" cy="' +
          yPositions[index] + '" r="2.8" fill="' + item.color + '"/>');
      });
      if (latest && latestPeak !== null) {
        let peakIndex = -1;
        values.forEach((value, index) => {
          if (value !== null && Math.abs(value - latestPeak) < 1e-9 && peakIndex < 0) peakIndex = index;
        });
        if (peakIndex >= 0) {
          const peakX = xPositions[peakIndex];
          const peakY = yPositions[peakIndex];
          const label = formatPeakValue(latestPeak) + " " + peakUnit(spec.field);
          const timeLabel = localLabels[peakIndex]?.label || "";
          const nearTop = peakY - plotY < 18;
          const nearRight = peakX > plotX + plotWidth - 56;
          const labelX = nearRight ? peakX - 10 : peakX + 10;
          const labelY = nearTop ? peakY + 18 : peakY - 12;
          const labelWidth = Math.max(36, label.length * 6.8 + 12);
          const boxX = (nearRight ? labelX - labelWidth : labelX - 5);
          const boxY = labelY - 12;
          parts.push(
            '<g class="gfs-latest-peak-marker" data-latest-peak-value="' + escapeXml(label) +
            '" data-latest-peak-time="' + escapeXml(timeLabel) + '">',
            '<circle cx="' + Number(peakX).toFixed(3) + '" cy="' + peakY +
            '" r="5.2" fill="' + item.color + '" stroke="#F7FDFF" stroke-width="1.4"/>',
            '<rect x="' + Number(boxX).toFixed(3) + '" y="' + Number(boxY).toFixed(3) +
            '" width="' + labelWidth.toFixed(1) + '" height="16" rx="3" fill="#0A1B29" fill-opacity=".88"/>',
            '<text x="' + Number(labelX).toFixed(3) + '" y="' + Number(labelY).toFixed(3) +
            '" text-anchor="' + (nearRight ? "end" : "start") +
            '" fill="#F7FDFF" font-size="11" font-weight="800" font-family="' + FONT + '">' +
            escapeXml(label) + '</text>',
            '</g>'
          );
        }
      }

      panelSeries.push({
        label: item.label,
        run_id_utc: item.document.run_id_utc,
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

  const metadataText = JSON.stringify({ version: 1, renderer: "cloudflare-js-v3", panels: metadata })
    .replace(/\]\]>/g, "]]\\u003e");
  parts.push(
    '<text x="63" y="810" fill="#E7F2F6" font-size="11" font-family="' + FONT + '">Aynı geçerlilik saatleri (TSİ) · ' +
    validKeys.length + ' ortak nokta · ' + series.length + ' döngü</text>',
    '<text x="1090" y="810" text-anchor="end" fill="#E7F2F6" font-size="10" font-family="' + FONT +
    '">Kaynak: MeteoPT GFS · İstanbul nokta tahmini</text>',
    '<metadata id="gfs-renderer-version">cloudflare-js-v2</metadata>',
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
  const forecast = (Array.isArray(document.forecast_6_hourly) ? document.forecast_6_hourly : [])
    .filter(point => Number.isFinite(Date.parse(point?.valid_time_utc || "")))
    .slice()
    .sort((a, b) => Date.parse(a.valid_time_utc) - Date.parse(b.valid_time_utc));
  const todayKey = nowLocal.getUTCFullYear() + "-" + pad2(nowLocal.getUTCMonth() + 1) + "-" + pad2(nowLocal.getUTCDate());
  const dayNames = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
  const fullDayNames = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];

  const localParts = value => {
    const date = localDate(value);
    return {
      date,
      key: date.getUTCFullYear() + "-" + pad2(date.getUTCMonth() + 1) + "-" + pad2(date.getUTCDate()),
      day: fullDayNames[date.getUTCDay()],
      shortDay: dayNames[date.getUTCDay()],
      dateLabel: pad2(date.getUTCDate()) + "." + pad2(date.getUTCMonth() + 1),
      time: pad2(date.getUTCHours()) + ":" + pad2(date.getUTCMinutes()),
    };
  };
  const formatRange = (values, suffix) => {
    const clean = values.filter(value => value !== null && value !== undefined && Number.isFinite(Number(value)))
      .map(Number);
    if (!clean.length) return null;
    const low = Math.min(...clean);
    const high = Math.max(...clean);
    const value = Math.abs(high - low) < 0.05
      ? formatNumber(low) + suffix
      : formatNumber(low) + "–" + formatNumber(high) + suffix;
    return value;
  };
  const windDirection = degrees => {
    const value = numeric(degrees);
    if (value === null) return "";
    const names = ["K", "KD", "D", "GD", "G", "GB", "B", "KB"];
    return names[Math.round((((value % 360) + 360) % 360) / 45) % 8];
  };
  const windText = point => {
    const speed = numeric(point?.wind_speed_10m_kmh);
    if (speed === null) return null;
    const direction = windDirection(point?.wind_direction_10m_deg);
    return formatNumber(speed) + " km/sa" + (direction ? " " + direction : "");
  };
  const timeLabel = value => {
    const part = localParts(value);
    return part.shortDay + " " + part.time;
  };

  const sections = [];
  sections.push([
    "🌦 İSTANBUL GFS · " + pad2(run.getUTCHours()) + "Z",
    "🕒 " + formatTrDate(nowLocal) + " TSİ · Model: " + formatUtcDate(run) + " UTC",
    "📡 Kaynak: MeteoPT GFS · " + (Number(document.forecast_horizon_hours) || 180) + " saat tahmin",
  ].join("\n"));

  // Station block is shown only when at least one real measurement is present.
  // A failed station request must not create a wall of meaningless em dashes.
  const station = stationObservation && typeof stationObservation === "object" ? stationObservation : null;
  if (station) {
    const temperature = numeric(station.temperature_2m_c);
    const humidity = numeric(station.humidity_percent);
    const pressure = numeric(station.station_pressure_hpa ?? station.actual_station_pressure_hpa);
    const wind = numeric(station.wind_speed_10m_kmh);
    const rain = numeric(station.precipitation_daily_mm);
    const measurements = [];
    if (temperature !== null) measurements.push("🌡 " + formatNumber(temperature) + "°C");
    if (humidity !== null) measurements.push("💧 %" + formatNumber(humidity));
    if (pressure !== null) measurements.push("🧭 " + formatNumber(pressure) + " hPa");
    const windDirectionLabel = String(station.wind_direction_cardinal || "").trim();
    if (wind !== null) measurements.push("💨 " + (windDirectionLabel ? windDirectionLabel + " " : "") + formatNumber(wind) + " km/sa");
    if (rain !== null) measurements.push("🌧 " + formatNumber(rain) + " mm bugün");
    if (measurements.length) {
      const stationLines = [
        "📍 " + String(station.station_name || "ENKA Balmumcu").toLocaleUpperCase("tr-TR"),
        measurements.join(" · "),
      ];
      if (station.observed_at_utc) {
        const observed = localParts(station.observed_at_utc);
        const age = numeric(station.age_minutes);
        stationLines.push("🕒 Ölçüm: " + observed.dateLabel + " " + observed.time +
          " TSİ" + (age !== null ? " · " + Math.round(age) + " dk önce" : ""));
      }
      const age = numeric(station.age_minutes);
      if (station.is_stale === true || (age !== null && age > 20)) {
        stationLines.push("⚠️ İstasyon ölçümü güncel değil.");
      }
      sections.push(stationLines.join("\n"));
    }
  }

  // A compact 24-hour outlook adds humidity and direction without pretending
  // a single model point is a min/max range.
  const next24End = now.getTime() + 24 * 3600000;
  const next24 = forecast.filter(point => {
    const time = Date.parse(point.valid_time_utc);
    return time > now.getTime() && time <= next24End;
  });
  const outlook = ["⏱ ÖNÜMÜZDEKİ 24 SAAT"];
  if (next24.length) {
    const firstTime = localParts(next24[0].valid_time_utc);
    const lastTime = localParts(next24[next24.length - 1].valid_time_utc);
    outlook.push("Tahmin noktaları: " + firstTime.dateLabel + " " + firstTime.time +
      " – " + lastTime.dateLabel + " " + lastTime.time + " TSİ");
    const temperatures = formatRange(next24.map(point => numeric(point.temperature_2m_c)), "°C");
    const humidities = formatRange(next24.map(point => numeric(point.humidity_2m_percent)), "%");
    const rainValues = next24.map(point => numeric(point.precipitation_6h_mm))
      .filter(value => value !== null);
    const winds = next24.map(point => point).filter(point => numeric(point.wind_speed_10m_kmh) !== null);
    if (temperatures) {
      let line = "🌡 " + temperatures;
      if (next24.map(point => numeric(point.temperature_2m_c)).filter(value => value !== null).length === 1) {
        line += " · " + timeLabel(next24.find(point => numeric(point.temperature_2m_c) !== null).valid_time_utc);
      }
      outlook.push(line);
    }
    if (humidities) outlook.push("💧 Nem: " + humidities);
    if (rainValues.length) {
      const totalRain = rainValues.reduce((sum, value) => sum + Math.max(0, value), 0);
      outlook.push(totalRain < 0.1 ? "🌧 Yağış beklenmiyor" : "🌧 Beklenen toplam: " + formatNumber(totalRain) + " mm");
    }
    if (winds.length) {
      const peak = winds.reduce((best, point) =>
        numeric(point.wind_speed_10m_kmh) > numeric(best.wind_speed_10m_kmh) ? point : best
      );
      outlook.push("💨 En yüksek rüzgâr: " + windText(peak));
    }
  } else {
    outlook.push("Bu zaman aralığında kullanılabilir tahmin noktası yok.");
  }
  sections.push(outlook.join("\n"));

  // Five full forecast days are available in the F180 payload.
  const days = (Array.isArray(document.daily_summary) ? document.daily_summary : [])
    .filter(day => String(day.date_istanbul || "") > todayKey)
    .slice(0, 5);
  const dailyLines = ["📅 5 GÜNLÜK TAHMİN"];
  for (const day of days) {
    const [year, month, date] = String(day.date_istanbul).split("-").map(Number);
    if (!year || !month || !date) continue;
    const local = new Date(Date.UTC(year, month - 1, date));
    const label = dayNames[local.getUTCDay()] + " " + pad2(date) + "." + pad2(month);
    const values = [];
    const tempRange = formatRange([
      numeric(day.temperature_min_c), numeric(day.temperature_max_c)
    ], "°C");
    if (tempRange) values.push(tempRange);
    const humidityRange = formatRange([
      numeric(day.humidity_min_percent), numeric(day.humidity_max_percent)
    ], "%");
    if (humidityRange) values.push("Nem " + humidityRange);
    const rain = numeric(day.precipitation_total_mm);
    if (rain !== null) values.push(rain < 0.1 ? "Yağış yok" : "Yağış " + formatNumber(rain) + " mm");
    const windSpeed = numeric(day.wind_speed_max_10m_kmh);
    if (windSpeed !== null) {
      const direction = windDirection(day.wind_direction_max_10m_deg);
      values.push("Rüzgâr " + formatNumber(windSpeed) + " km/sa" + (direction ? " " + direction : ""));
    }
    if (values.length) dailyLines.push("• " + label + " · " + values.join(" · "));
  }
  if (dailyLines.length === 1) dailyLines.push("Günlük özet verisi bulunmuyor.");
  sections.push(dailyLines.join("\n"));

  // Convert non-zero forecast precipitation points into concise time windows.
  const rainHorizonEnd = now.getTime() + 72 * 3600000;
  const rainPoints = forecast.filter(point => {
    const time = Date.parse(point.valid_time_utc);
    const amount = numeric(point.precipitation_6h_mm);
    return time > now.getTime() && time <= rainHorizonEnd && amount !== null;
  });
  const rainEvents = [];
  let activeEvent = null;
  const flushRainEvent = () => {
    if (activeEvent) rainEvents.push(activeEvent);
    activeEvent = null;
  };
  for (const point of rainPoints) {
    const amount = Math.max(0, numeric(point.precipitation_6h_mm));
    if (amount < 0.2) {
      flushRainEvent();
      continue;
    }
    const time = Date.parse(point.valid_time_utc);
    if (!activeEvent) {
      activeEvent = { start: point.valid_time_utc, end: point.valid_time_utc, total: amount, count: 1, endTime: time };
    } else {
      activeEvent.end = point.valid_time_utc;
      activeEvent.endTime = time;
      activeEvent.total += amount;
      activeEvent.count += 1;
    }
  }
  flushRainEvent();
  const rainLines = ["🌧 YAĞIŞ ZAMANLARI · 72 SAAT"];
  if (rainEvents.length) {
    for (const event of rainEvents.slice(0, 4)) {
      const start = localParts(event.start);
      const end = localParts(event.end);
      const label = event.start === event.end
        ? start.day + " " + start.time
        : start.day + " " + start.time + " – " +
          (start.key === end.key ? end.time : end.day + " " + end.time);
      rainLines.push("• " + label + " · yaklaşık " + formatNumber(event.total) + " mm");
    }
    if (rainEvents.length > 4) rainLines.push("Diğer yağış sinyalleri günlük toplamda gösteriliyor.");
  } else {
    rainLines.push("Anlamlı yağış sinyali beklenmiyor.");
  }
  sections.push(rainLines.join("\n"));

  return sections.filter(Boolean).join("\n\n");
}