import { buildPanelAxis, formatAxisTick, formatPeakValue, peakUnit, seriesCalloutPlacement } from "../../shared/gfs-chart-axis.js";

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
      if (!key) continue;

      // Scraper/model rows can occasionally exist with a valid F-hour but
      // every chart field set to "-". Such a row is not a forecast point.
      // Keep its timestamp for alignment, but make every plotted value null
      // so no panel can invent a value or connect through the invalid row.
      const chartFields = [
        "temperature_2m_c",
        "temperature_850hpa_c",
        "precipitation_6h_mm",
        "wind_speed_10m_kmh",
      ];
      const hasChartValue = chartFields.some(field => numeric(point?.[field]) !== null);
      if (!hasChartValue) {
        points.set(key, {
          ...point,
          temperature_2m_c: null,
          temperature_850hpa_c: null,
          precipitation_6h_mm: null,
          wind_speed_10m_kmh: null,
          wind_direction_10m_deg: null,
          __invalid_chart_point: true,
        });
        continue;
      }
      points.set(key, point);
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
  const invalidBySeries = series.map(item => ({
    run_id_utc: item.document.run_id_utc,
    forecast_hours: [...item.points.values()]
      .filter(point => point?.__invalid_chart_point === true)
      .map(point => Number(point?.forecast_hour))
      .filter(Number.isFinite)
      .sort((a, b) => a - b),
  }));
  return { series, validKeys, pointsBySeries, localLabels, dates, offsets, invalidBySeries };
}

export function buildIstanbulInteractiveSvg(runs) {
  const chart = buildSeries(runs);
  const { series, validKeys, pointsBySeries, localLabels, dates, offsets, invalidBySeries } = chart;
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
    const valuesBySeries = pointsBySeries.map(points => points.map(point => {
      if (point?.__invalid_chart_point === true) return null;
      return numeric(point?.[spec.field]);
    }));
    const allValues = valuesBySeries.flat().filter(value => value !== null);
    const axis = buildPanelAxis(spec.field, valuesBySeries);
    const { low, high, ticks, latestPeak, latestTrough } = axis;

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
      // Older cycles may contain peaks outside the current/latest axis.
      // Do not connect those out-of-range points back into the plot: a huge
      // obsolete spike can otherwise create a diagonal/vertical line through
      // the current chart. Raw values remain in metadata for tooltips.
      const plotValues = values.map(value =>
        value === null || value < low || value > high ? null : value
      );
      const yPositions = plotValues.map(value => value === null ? null : Number(yFor(value).toFixed(3)));
      const leadHours = pointsBySeries[seriesIndex].map(point => {
        const n = Number(point?.forecast_hour);
        return Number.isFinite(n) ? Math.round(n) : null;
      });
      const directions = pointsBySeries[seriesIndex].map(point =>
        spec.field === "wind_speed_10m_kmh" ? numeric(point?.wind_direction_10m_deg) : null
      );
      let pathData = "";
      let open = false;
      plotValues.forEach((value, index) => {
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
      // Mark invalid forecast rows with a small X at the bottom of the plot.
      // The point itself remains unplotted and the line stays broken.
      values.forEach((value, index) => {
        if (value === null && pointsBySeries[seriesIndex][index]?.__invalid_chart_point === true) {
          const fx = xPositions[index];
          const fy = plotY + plotHeight - 7;
          const fHour = Number(pointsBySeries[seriesIndex][index]?.forecast_hour);
          const fLabel = Number.isFinite(fHour) ? "F" + Math.round(fHour) : "F?";
          parts.push(
            '<g class="gfs-invalid-point" data-forecast-hour="' + escapeXml(fLabel) + '">',
            '<text x="' + fx.toFixed(3) + '" y="' + fy.toFixed(3) + '" text-anchor="middle" fill="' + item.color + '" font-size="13" font-weight="900" font-family="' + FONT + '">×</text>',
            '<text x="' + fx.toFixed(3) + '" y="' + (fy + 11).toFixed(3) + '" text-anchor="middle" fill="' + item.color + '" font-size="7" font-weight="700" font-family="' + FONT + '">' + escapeXml(fLabel) + '</text>',
            '</g>'
          );
        }
      });
      if (latest) values.forEach((value, index) => {
        if (value !== null) parts.push('<circle cx="' + xPositions[index].toFixed(3) + '" cy="' +
          yPositions[index] + '" r="2.8" fill="' + item.color + '"/>');
      });
      const pushExtremeMarker = (kind, extreme, avoidBoxes) => {
        if (extreme === null) return null;
        let extremeIndex = -1;
        values.forEach((value, index) => {
          if (value !== null && Math.abs(value - extreme) < 1e-9 && extremeIndex < 0) extremeIndex = index;
        });
        if (extremeIndex < 0) return null;
        const pointX = xPositions[extremeIndex];
        const pointY = yPositions[extremeIndex];
        const label = formatPeakValue(extreme) + " " + peakUnit(spec.field);
        const timeLabel = localLabels[extremeIndex]?.label || "";
        const place = seriesCalloutPlacement({
          x: pointX, y: pointY, plotX, plotY, plotWidth, plotHeight, label, avoidBoxes
        });
        const valueAttr = kind === "trough" ? "data-latest-trough-value" : "data-latest-peak-value";
        const timeAttr = kind === "trough" ? "data-latest-trough-time" : "data-latest-peak-time";
        const className = kind === "trough" ? "gfs-latest-trough-marker" : "gfs-latest-peak-marker";
        parts.push(
          '<g class="' + className + '" ' + valueAttr + '="' + escapeXml(label) +
          '" ' + timeAttr + '="' + escapeXml(timeLabel) + '">',
          '<circle cx="' + Number(pointX).toFixed(3) + '" cy="' + pointY +
          '" r="5.2" fill="' + item.color + '" stroke="#F7FDFF" stroke-width="1.4"/>',
          '<rect x="' + Number(place.boxX).toFixed(3) + '" y="' + Number(place.boxY).toFixed(3) +
          '" width="' + place.labelWidth.toFixed(1) + '" height="16" rx="3" fill="#0A1B29" fill-opacity=".88"/>',
          '<text x="' + Number(place.labelX).toFixed(3) + '" y="' + Number(place.labelY).toFixed(3) +
          '" text-anchor="' + (place.nearRight ? "end" : "start") +
          '" fill="#F7FDFF" font-size="11" font-weight="800" font-family="' + FONT + '">' +
          escapeXml(label) + '</text>',
          '</g>'
        );
        return { box: place.box, x: pointX, y: pointY };
      };
      if (latest) {
        const peak = pushExtremeMarker("peak", latestPeak, []);
        const avoid = [];
        if (peak) {
          avoid.push(peak.box);
          avoid.push({ x: peak.x - 8, y: peak.y - 8, width: 16, height: 16 });
        }
        pushExtremeMarker("trough", latestTrough, avoid);
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

  const metadataText = JSON.stringify({ version: 1, renderer: "cloudflare-js-v4", panels: metadata })
    .replace(/\]\]>/g, "]]\\u003e");
  parts.push(
    '<text x="63" y="810" fill="#E7F2F6" font-size="11" font-family="' + FONT + '">Aynı geçerlilik saatleri (TSİ) · ' +
    validKeys.length + ' ortak nokta · ' + series.length + ' döngü</text>',
    '<text x="1090" y="810" text-anchor="end" fill="#E7F2F6" font-size="10" font-family="' + FONT +
    '">Kaynak: MeteoPT GFS · İstanbul nokta tahmini</text>',
    invalidBySeries.some(item => item.forecast_hours.length)
      ? '<text x="63" y="828" fill="#F3C96B" font-size="9" font-family="' + FONT + '">Veri kalite notu: ' +
        invalidBySeries.filter(item => item.forecast_hours.length).map(item =>
          escapeXml(runLabel(item.run_id_utc, item.run_id_utc === series[series.length - 1].document.run_id_utc)) +
          ' · geçersiz F: ' + item.forecast_hours.join(", ")
        ).join(" · ") + '</text>'
      : '',
    '<metadata id="gfs-renderer-version">cloudflare-js-v4</metadata>',
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


function briefingDayKey(date) {
  const d = localDate(date);
  return d.getUTCFullYear()+"-"+pad2(d.getUTCMonth()+1)+"-"+pad2(d.getUTCDate());
}
function briefingDayKeys(now) {
  const base = localDate(now);
  base.setUTCHours(0,0,0,0);
  return Array.from({length:5}, (_,i) => briefingDayKey(new Date(base.getTime()+i*86400000)));
}
function briefingDayTitle(key) {
  const d = new Date(key+"T12:00:00Z");
  const names=["Pazar","Pazartesi","Salı","Çarşamba","Perşembe","Cuma","Cumartesi"];
  return names[d.getUTCDay()];
}
function briefingClock(date) {
  const d=localDate(date);
  return pad2(d.getUTCHours())+":"+pad2(d.getUTCMinutes());
}
function briefingForecastPoints(document, now) {
  const keys=new Set(briefingDayKeys(now));
  return (Array.isArray(document?.forecast_6_hourly)?document.forecast_6_hourly:[])
    .map(p=>({...p, _ts:Date.parse(p?.valid_time_utc||"")}))
    .filter(p=>Number.isFinite(p._ts) && Number(p.forecast_hour)>0 && Number(p.forecast_hour)<=120 && Number(p.forecast_hour)%3===0 &&
      keys.has(briefingDayKey(p._ts)) && p._ts>=now.getTime()-30*60000)
    .sort((a,b)=>a._ts-b._ts);
}
function briefingRainLines(points) {
  const lines=[];
  const keys=briefingDayKeys(new Date());
  for (const key of keys) {
    const dayPoints=points.filter(p=>briefingDayKey(p._ts)===key);
    const wet=dayPoints.filter(p=>numeric(p.precipitation_6h_mm)>=0.2);
    if(!wet.length){ lines.push(briefingDayTitle(key)+" · yağış yok"); continue; }
    let current=null;
    const spells=[];
    for(const p of wet){
      if(!current || p._ts-current.end>4*3600000){
        current={start:p._ts,end:p._ts,sum:0}; spells.push(current);
      }
      current.end=p._ts;
      current.sum+=Math.max(0,numeric(p.precipitation_6h_mm)||0);
    }
    for(const s of spells.slice(0,2)){
      const end=s.end+3*3600000;
      lines.push(briefingDayTitle(key)+" · "+briefingClock(s.start)+"–"+briefingClock(end)+" · "+formatNumber(s.sum)+" mm");
    }
  }
  return lines;
}
function briefingTemperatureSummary(points, stationObservation) {
  const keys=briefingDayKeys(new Date());
  const means=keys.map(key=>{
    const vals=points.filter(p=>briefingDayKey(p._ts)===key).map(p=>numeric(p.temperature_2m_c)).filter(v=>v!==null);
    return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  });
  let firstDrop=-1, dropAmount=null;
  for(let i=1;i<means.length;i++){
    if(means[i]!==null&&means[i-1]!==null){
      const delta=means[i]-means[i-1];
      if(delta<=-0.5){ firstDrop=i; dropAmount=Math.abs(delta); break; }
    }
  }
  let text;
  if(firstDrop>0){
    text="Hava "+firstDrop+" gün sonra ("+briefingDayTitle(keys[firstDrop])+") soğumaya başlıyor; günlük ortalama yaklaşık "+formatNumber(dropAmount)+"°C düşüyor.";
    if(means.slice(firstDrop+1).every((v,i)=>v===null || means[firstDrop+i+1]===null || v<=means[firstDrop+i]+0.49)){
      text+=" Beş günlük tahmin aralığında yeniden ısınma görünmüyor.";
    }
  } else {
    text="Önümüzdeki beş gün boyunca sıcaklık belirgin değişim göstermeden stabil seyrediyor.";
  }
  const lodosDays=[];
  for(const key of keys){
    const lodos=points.filter(p=>briefingDayKey(p._ts)===key).map(p=>{
      const speed=numeric(p.wind_speed_10m_kmh), dir=numeric(p.wind_direction_10m_deg);
      const isLodos=dir!==null && (dir>=157.5 && dir<=247.5);
      return isLodos && speed!==null ? speed : null;
    }).filter(v=>v!==null);
    if(lodos.length && lodos.some(v=>v>=15)) lodosDays.push({key,wind:Math.max(...lodos)});
  }
  if(lodosDays.length){
    const start=lodosDays[0];
    let count=1;
    for(let i=1;i<lodosDays.length;i++){
      if(Date.parse(lodosDays[i].key+"T00:00:00Z")-Date.parse(lodosDays[i-1].key+"T00:00:00Z")===86400000) count++; else break;
    }
    text+=" "+briefingDayTitle(start.key)+" günü Lodos geliyor";
    if(count>1) text+=" ve "+count+" gün sürecek";
    text+=".";
    const peak=lodosDays.reduce((a,b)=>b.wind>a.wind?b:a,lodosDays[0]);
    if(peak.wind>=20) text+=" Rüzgâr "+briefingDayTitle(peak.key)+" günü "+Math.round(peak.wind)+" km/sa hıza çıkacak.";
  }
  const current=numeric(stationObservation?.temperature_2m_c);
  if(current!==null) text+=" Eyüpsultan şu an "+formatNumber(current)+"°C.";
  return text;
}
function briefingWrap(text,maxChars=38) {
  const words=String(text||"").split(/\s+/).filter(Boolean), lines=[]; let line="";
  for(const word of words){ const next=line?line+" "+word:word; if(next.length>maxChars&&line){lines.push(line);line=word;}else line=next; }
  if(line)lines.push(line); return lines;
}
export function buildIstanbulBriefingSvg(document, now=new Date(), stationObservation=null) {
  const points=briefingForecastPoints(document,now);
  const invalidSteps=[...new Set(points
    .filter(p => ["temperature_2m_c","temperature_850hpa_c","precipitation_6h_mm","wind_speed_10m_kmh"]
      .every(field => numeric(p?.[field]) === null))
    .map(p => Number(p?.forecast_hour))
    .filter(Number.isFinite)
    .sort((a,b)=>a-b))];
  const rainLines=briefingRainLines(points);
  const tempLines=briefingWrap(briefingTemperatureSummary(points,stationObservation),38);
  const W=1080,H=1920, outerX=56, outerW=968, firstY=300, gap=28;
  const rowH=lines=>72+Math.max(1,lines.length)*58+72;
  const rainH=rowH(rainLines), tempH=rowH(tempLines);
  const secondY=firstY+rainH+gap, footerY=secondY+tempH+64;
  const esc=escapeXml;
  const draw=(y,label,lines,h)=>'<rect x="'+outerX+'" y="'+y+'" width="'+outerW+'" height="'+h+'" rx="28" fill="#0D2433" stroke="#294654" stroke-width="2"/>'+
    '<text x="'+(outerX+40)+'" y="'+(y+64)+'" fill="#8FD0C8" font-family="Inter, sans-serif" font-size="26" font-weight="700" letter-spacing="2.2">'+esc(label.toUpperCase())+'</text>'+
    lines.map((line,i)=>'<text x="'+(outerX+40)+'" y="'+(y+116+i*58)+'" fill="#E7F2F6" font-family="Inter, sans-serif" font-size="40" font-weight="500">'+esc(line)+'</text>').join("");
  const body='<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'">'+
    '<rect width="'+W+'" height="'+H+'" fill="#081827"/>'+
    '<text x="'+outerX+'" y="180" fill="#EDF5F8" font-family="Inter, sans-serif" font-size="64" font-weight="800">İstanbul Havası</text>'+
    '<text x="'+outerX+'" y="252" fill="#EDF5F8" font-family="Inter, sans-serif" font-size="64" font-weight="800">5 günlük özet</text>'+
    '<text x="'+outerX+'" y="298" fill="#9BB1BF" font-family="Inter, sans-serif" font-size="28" font-weight="500">Yağış saatleri ve sıcaklık eğilimi · Eyüpsultan</text>'+
    draw(firstY,"Yağış saatleri",rainLines.length?rainLines:["Önümüzdeki günler için çıktı yok."],rainH)+
    draw(secondY,"5 günlük sıcaklık",tempLines,tempH)+
    '<text x="'+outerX+'" y="'+footerY+'" fill="#6F8997" font-family="Inter, sans-serif" font-size="26">istanbulunhavasi.com</text>'+
    (invalidSteps.length
      ? '<text x="'+outerX+'" y="'+(footerY+42)+'" fill="#F3C96B" font-family="Inter, sans-serif" font-size="21">Veri kalite notu · geçersiz: '+esc(invalidSteps.map(v=>"F"+v).join(", "))+'</text>'
      : '')+
    '</svg>';
  return { key:"notifications/istanbul-gfs-"+runStamp(document.run_id_utc)+"-5day-briefing.svg", run_id_utc:document.run_id_utc, body, width:W, height:H };
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

  // Chronological daily narrative: each forecast day gets its own block so
  // the site report reads like a timeline rather than a compressed data row.
  const days = (Array.isArray(document.daily_summary) ? document.daily_summary : [])
    .filter(day => String(day.date_istanbul || "") >= todayKey)
    .slice(0, 5);
  const dailyLines = ["📅 KRONOLOJİK HAVA ÖZETİ"];
  const dayRecords = [];
  for (const day of days) {
    const [year, month, date] = String(day.date_istanbul).split("-").map(Number);
    if (!year || !month || !date) continue;
    const local = new Date(Date.UTC(year, month - 1, date));
    const avg = [numeric(day.temperature_min_c), numeric(day.temperature_max_c)]
      .filter(value => value !== null);
    const avgTemp = avg.length ? avg.reduce((sum, value) => sum + value, 0) / avg.length : null;
    dayRecords.push({ day, local, avgTemp });
  }

  // The source may arrive in any order. The report itself must always read
  // from the earliest forecast day to the latest forecast day.
  dayRecords.sort((a, b) => a.local.getTime() - b.local.getTime());

  for (let index = 0; index < dayRecords.length; index += 1) {
    const { day, local, avgTemp } = dayRecords[index];
    const label = fullDayNames[local.getUTCDay()] + " " + pad2(local.getUTCDate()) + "." + pad2(local.getUTCMonth() + 1);
    dailyLines.push("• " + label);

    const tempRange = formatRange([
      numeric(day.temperature_min_c), numeric(day.temperature_max_c)
    ], "°C");
    if (tempRange) {
      let trend = "";
      const previous = index > 0 ? dayRecords[index - 1].avgTemp : null;
      if (previous !== null && avgTemp !== null) {
        const delta = avgTemp - previous;
        if (Math.abs(delta) >= 0.5) {
          trend = delta < 0
            ? " · günlük ortalama yaklaşık " + formatNumber(Math.abs(delta)) + "°C düşüyor"
            : " · günlük ortalama yaklaşık " + formatNumber(delta) + "°C yükseliyor";
        } else {
          trend = " · sıcaklık stabil";
        }
      }
      dailyLines.push("  Sıcaklık: " + tempRange + trend);
    }

    const rain = numeric(day.precipitation_total_mm);
    if (rain !== null) {
      dailyLines.push(rain < 0.1
        ? "  Yağış: beklenmiyor"
        : "  Yağış: yaklaşık " + formatNumber(rain) + " mm");
    }

    const windSpeed = numeric(day.wind_speed_max_10m_kmh);
    if (windSpeed !== null) {
      const direction = windDirection(day.wind_direction_max_10m_deg);
      dailyLines.push("  Rüzgâr: " + formatNumber(windSpeed) + " km/sa" + (direction ? " " + direction : ""));
    }
  }

  if (station) {
    const stationTemperature = numeric(station.temperature_2m_c);
    if (stationTemperature !== null && dailyLines.length > 1) {
      dailyLines.splice(1, 0, "  Eyüpsultan şu an " + formatNumber(stationTemperature) + "°C");
    }
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