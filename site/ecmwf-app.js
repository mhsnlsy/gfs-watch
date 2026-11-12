(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const num = v => typeof v === "number" && Number.isFinite(v);
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
  const fmt = (v, d=1) => num(v)
    ? Number(v).toLocaleString("tr-TR",{minimumFractionDigits:d,maximumFractionDigits:d})
    : "—";

  const COLORS = ["#8ABCE8", "#7DD3D7", "#F1C98B", "#B38BE8"];
  const CYCLE_COLORS = COLORS;
  const PANELS = [
    { id: "temperature", field: "temperature_2m_c", title: "Sıcaklık", unit: "°C" },
    { id: "temperature_850", field: "temperature_850hpa_c", title: "850 hPa sıcaklık", unit: "°C" },
    { id: "precipitation", field: "precipitation_6h_mm", title: "Yağış", unit: "mm / 3 saat" },
    { id: "wind_10m", field: "wind_speed_10m_kmh", title: "10 m rüzgâr hızı", unit: "km/sa" },
  ];
  const TR_OFFSET_MS = 3 * 60 * 60 * 1000;
  const FONT = "system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
  const APP_VERSION = "1.5.0";

  function tsLabel(utc) {
    const d = new Date(utc);
    const day = new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"2-digit"}).format(d);
    const weekday = new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",weekday:"long"}).format(d);
    const clock = new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(d);
    return day+" "+weekday+" · "+clock+" TSİ";
  }
  function utcLabel(utc) {
    const d = new Date(utc);
    const day = new Intl.DateTimeFormat("tr-TR",{timeZone:"UTC",day:"2-digit",month:"2-digit",year:"numeric"}).format(d);
    const clock = new Intl.DateTimeFormat("tr-TR",{timeZone:"UTC",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(d);
    return day+" "+clock+" UTC";
  }
  function shortRun(utc) {
    return new Intl.DateTimeFormat("tr-TR",{timeZone:"UTC",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(utc));
  }

  function dewPointFromTempRh(t, rh) {
    if(!num(t) || !num(rh) || rh <= 0) return null;
    const a=17.62,b=243.12;
    const gamma=Math.log(rh/100)+(a*t)/(b+t);
    return b*gamma/(a-gamma);
  }

  // ECMWF uses the same four-cycle valid-time renderer and axis rules as homepage GFS.
function isTemperatureField(field) {
  return field === "temperature_2m_c" || field === "temperature_850hpa_c";
}

function axisStep(field, maxValue) {
  if (field === "precipitation_6h_mm") {
    return Number.isFinite(maxValue) && maxValue > 16 ? 2 : 1;
  }
  if (field === "wind_speed_10m_kmh") return 10;
  return 5;
}

function peakUnit(field) {
  if (field === "precipitation_6h_mm") return "mm";
  if (field === "wind_speed_10m_kmh") return "km/sa";
  return "°C";
}

function formatAxisTick(value) {
  return String(Math.round(value));
}

function formatPeakValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(n);
}

function buildPanelAxis(field, valuesBySeries, options = {}) {
  const includeOlderSeriesForScale = options.includeOlderSeriesForScale !== false;
  const latestValues = (valuesBySeries[valuesBySeries.length - 1] || []).filter(value => value !== null);
  // Do not let an older dashed cycle change the scale of the current output.
  // This is especially important for precipitation, where an obsolete spike
  // can otherwise create a huge 0–24 mm axis for a current 0–4 mm forecast.
  const latestPeak = latestValues.length ? Math.max(...latestValues) : null;
  const latestMin = latestValues.length ? Math.min(...latestValues) : null;
  const temperature = isTemperatureField(field);
  const latestTrough = temperature && latestPeak !== null && latestMin !== null && Math.abs(latestPeak - latestMin) > 1e-9
    ? latestMin
    : null;
  const allValues = valuesBySeries.flat().filter(value => value !== null);
  // Precipitation can opt out for Köy, where only the latest cycle defines
  // the rainfall scale. Temperature panels remain comparison-stable across
  // all cycles so an older cold/warm cycle is not clipped from the axis.
  const scaleValues =
    field === "precipitation_6h_mm"
      ? (includeOlderSeriesForScale ? allValues : latestValues)
      : allValues;
  const scaleMax = scaleValues.length ? Math.max(...scaleValues) : null;
  const step = axisStep(field, scaleMax);

  let low = 0;
  let high = step;
  if (latestValues.length) {
    if (temperature) {
      // Keep temperature charts readable around the latest cycle instead of
      // collapsing a nearly-flat forecast into a single 5-degree band.
      low = Math.floor(Math.min(...scaleValues) / step) * step;
      high = Math.ceil(Math.max(...scaleValues) / step) * step;
    } else {
      low = 0;
      high = Math.ceil(Math.max(0, ...scaleValues) / step) * step;
    }
  }
  // Reserve headroom when the newest peak is on/near the top tick.
  // This keeps the latest marker and value label fully inside the chart.
  if ((temperature || field === "precipitation_6h_mm") && latestValues.length && Number.isFinite(high) && Number.isFinite(latestPeak) &&
      high - latestPeak <= step * 0.25) {
    high += step;
  }
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    low = temperature && Number.isFinite(low) ? low : 0;
    high = low + step;
  }

  const ticks = [];
  for (let value = low; value <= high + 1e-9; value += step) {
    ticks.push(Math.round(value));
  }
  return { low, high, ticks, step, latestPeak, latestTrough };
}


function buildSeries(runs) {
  const docs = (Array.isArray(runs) ? runs : [])
    .filter(run => run && run.run_id_utc && Array.isArray(run.forecast_6_hourly))
    .slice()
    .sort((a, b) => Date.parse(a.run_id_utc) - Date.parse(b.run_id_utc))
    .slice(-4);
  if (docs.length < 1) throw new Error("At least one complete ECMWF run is required; found " + docs.length);

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
  if (common.length < 2) throw new Error("The available ECMWF cycles have fewer than two common valid times");

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

function buildSvg(runs) {
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
    '<title id="istanbul-gfs-svg-title">İstanbul ECMWF · dört döngü valid-time karşılaştırması</title>',
    '<desc id="istanbul-gfs-svg-desc">Dört İstanbul ECMWF tahmin döngüsü aynı geçerlilik saatlerinde hizalanmıştır. Sıcaklık, 850 hPa sıcaklığı, yağış ve 10 metre rüzgârı karşılaştırılır.</desc>',
    '<g id="patch_1"><rect x="0" y="0" width="1152" height="838" style="fill: #0a1b29"/></g>',
    '<text x="63" y="34" fill="#7DD3D7" font-size="12" font-weight="700" letter-spacing="1.5" font-family="' + FONT + '">ECMWF IFS · İSTANBUL</text>',
    '<text x="1090" y="34" text-anchor="end" fill="#8EAEB7" font-size="8" font-weight="500" font-family="' + FONT + '">İstanbul Havası v' + APP_VERSION + '</text>',
    '<text x="63" y="76" fill="#FFFFFF" font-size="27" font-weight="750" font-family="' + FONT + '">Son ECMWF raporu · ' + series.length + ' döngü karşılaştırması</text>',
    '<text x="63" y="108" fill="#E7F2F6" font-size="14" font-family="' + FONT + '">Mevcut ECMWF çıktıları aynı geçerlilik saatlerinde (TSİ) üst üste karşılaştırılır.</text>',
    '<rect x="850" y="20" width="245" height="36" rx="11" fill="#0A1B29" stroke="#416174" stroke-width="1"/>',
    '<text x="972.5" y="43" text-anchor="middle" fill="#B8D7DF" font-size="12" font-family="' + FONT + '">' + series.length + ' ECMWF döngüsü karşılaştırılıyor</text>',
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

  const metadataText = JSON.stringify({ version: 1, renderer: "cloudflare-js-v3", panels: metadata })
    .replace(/\]\]>/g, "]]\\u003e");
  parts.push(
    '<text x="63" y="810" fill="#E7F2F6" font-size="11" font-family="' + FONT + '">Aynı geçerlilik saatleri (TSİ) · ' +
    validKeys.length + ' ortak nokta · ' + series.length + ' döngü</text>',
    '<text x="1090" y="810" text-anchor="end" fill="#E7F2F6" font-size="10" font-family="' + FONT +
    '">Kaynak: MeteoPT ECMWF · İstanbul nokta tahmini</text>',
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
  if (body.length > 1800000) throw new Error("Generated Istanbul ECMWF SVG exceeds the D1 publication row safety limit");
  const latest = series[series.length - 1].document;
  return {
    key: "notifications/istanbul-ecmwf-" + runStamp(latest.run_id_utc) + "-comparison.svg",
    run_id_utc: latest.run_id_utc,
    body,
    common_valid_time_count: validKeys.length,
  };
}


  function renderSvg(runs) {
    const host=$("ecmwf-gfs-comparison-container");
    if(!host)return;
    const chart=host.querySelector(".gfs-interactive-chart");
    if(!chart)return;
    chart.innerHTML="";
    const svgText=buildSvg(runs);
    const doc=new DOMParser().parseFromString(svgText,"image/svg+xml");
    const svg=doc.documentElement;
    chart.appendChild(document.importNode(svg,true));
    const liveSvg=chart.querySelector("svg");
    const metadataNode=liveSvg&&liveSvg.querySelector("#gfs-interactive-data");
    if(!liveSvg||!metadataNode)return;
    let metadata;
    try{metadata=JSON.parse(metadataNode.textContent||"{}");}catch(_){return;}
    if(typeof attachGfsSvgInteractions==="function"){
      attachGfsSvgInteractions(chart,liveSvg,metadata,null,isMobileGfsLayout());
    }
  }

  function tableFinite(value) {
    return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  }
  function tableNumber(value) {
    return tableFinite(value) ? Number(value) : null;
  }
  function tableColour(field, value) {
    if (value === null) return "";
    const v = value;
    if (field === "wind") return v < 10 ? "mt-blue" : v < 20 ? "mt-green" : v < 30 ? "mt-yellow" : v < 45 ? "mt-orange" : v < 60 ? "mt-red" : "mt-purple";
    if (field === "precip") return Number(v.toFixed(1)) === 0 ? "mt-gray" : v < .1 ? "mt-blue" : v < 1 ? "mt-green" : v < 2.5 ? "mt-yellow" : v < 5 ? "mt-orange" : v < 10 ? "mt-red" : "mt-purple";
    if (field === "t2m" || field === "dewpoint") return v < 0 ? "mt-blue" : v < 8 ? "mt-green" : v < 16 ? "mt-yellow" : v < 24 ? "mt-orange" : v < 32 ? "mt-red" : "mt-purple";
    if (field === "rh2m") return v < 30 ? "rh2m-warm-1" : v < 45 ? "rh2m-warm-2" : v < 60 ? "rh2m-warm-3" : v < 75 ? "rh2m-cool-1" : v < 90 ? "rh2m-cool-2" : "rh2m-cool-3";
    if (field === "t850") return v < -10 ? "mt-blue" : v < -2 ? "mt-green" : v < 6 ? "mt-yellow" : v < 14 ? "mt-orange" : v < 22 ? "mt-red" : "mt-purple";
    if (field === "snowln") return v < 1000 ? "mt-blue" : v < 1500 ? "mt-green" : v < 2000 ? "mt-yellow" : v < 2500 ? "mt-orange" : v < 3000 ? "mt-red" : "mt-purple";
    return "";
  }
  function tableDisplay(value, digits=1) {
    return value === null ? "—" : Number(value).toLocaleString("en-GB",{minimumFractionDigits:digits,maximumFractionDigits:digits});
  }
  function tableDewpoint(temp, humidity) {
    if (temp === null || humidity === null || humidity <= 0 || humidity > 100) return null;
    const a=17.62,b=243.12;
    const gamma=Math.log(humidity/100)+(a*temp)/(b+temp);
    const result=(b*gamma)/(a-gamma);
    return Number.isFinite(result)?result:null;
  }
  function tableValueCell(value, field, digits=1) {
    if (value === null) return '<span class="meteopt-value">—</span>';
    return '<span class="meteopt-value '+tableColour(field,value)+'">'+tableDisplay(value,digits)+'</span>';
  }
  function tableWindCell(speed, direction, digits=0) {
    if (speed === null) return '<span class="meteopt-value">—</span>';
    const arrow=direction===null?"":'<span class="meteopt-wind-arrow" style="--wind-angle:'+((Number(direction)+180)%360)+'deg" aria-label="Rüzgâr yönü '+Math.round(direction)+'°">↑</span>';
    return '<span class="meteopt-value '+tableColour("wind",speed)+' meteopt-wind-value">'+tableDisplay(speed,digits)+arrow+'</span>';
  }
  function ecmwfTableDateLabel(point, runId, step) {
    const rawDate=point&&point.valid_time_utc?new Date(point.valid_time_utc):new Date(new Date(runId).getTime()+step*3600000);
    if(!Number.isFinite(rawDate.getTime()))return "—";
    // Homepage GFS table convention is intentionally retained: valid timestamp
    // is shifted back 3h before the TSİ display.
    const date=new Date(rawDate.getTime()-3*3600000);
    const datePart=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Istanbul",weekday:"short",day:"numeric",month:"short"}).format(date);
    const hour=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Istanbul",hour:"2-digit",hourCycle:"h23"}).format(date);
    return datePart+" "+hour+" TSİ";
  }
  function renderTable(doc) {
    const body=$("meteopt-table-body");
    if(!body)return;
    const points=Array.isArray(doc.forecast_6_hourly)?doc.forecast_6_hourly:[];
    const hours=points.map(point=>({step:Number(point.forecast_hour),point}))
      .filter(item=>Number.isFinite(item.step)&&item.step>0&&item.step<=180&&item.step%3===0)
      .sort((a,b)=>a.step-b.step);
    if(!hours.length){
      body.innerHTML='<tr><td colspan="10" class="meteopt-table-empty">ECMWF F180 tahmin adımları henüz yok.</td></tr>';
      $("ecmwf-table-status").textContent="Tahmin adımı bulunamadı";
      return;
    }
    const rows=hours.map(item=>{
      const p=item.point||{};
      const t850=p.temperature_850hpa&&p.temperature_850hpa.mean_c;
      const w850=p.wind_850hpa&&p.wind_850hpa.mean_kmh;
      const d10=tableNumber(p.wind_direction_10m_deg);
      const d850=tableNumber(p.wind_direction_850hpa_deg ?? (p.wind_850hpa&&p.wind_850hpa.direction_deg));
      const temp=tableNumber(p.temperature_2m_c);
      const rh=tableNumber(p.humidity_2m_percent);
      const snow=tableNumber(p.snowln);
      const vals=[
        tableValueCell(temp,"t2m"),
        tableValueCell(tableNumber(p.precipitation_interval_mm ?? p.precipitation_6h_mm),"precip"),
        tableWindCell(tableNumber(p.wind_speed_10m_kmh),d10,0),
        tableValueCell(tableNumber(t850),"t850"),
        tableWindCell(tableNumber(w850),d850,0),
        tableValueCell(rh,"rh2m",0),
        tableValueCell(tableDewpoint(temp,rh),"dewpoint"),
        tableValueCell(snow,"snowln",0)
      ];
      return '<tr><td>'+item.step+'</td><td>'+esc(ecmwfTableDateLabel(p,doc.run_id_utc,item.step))+'</td>'+vals.map(v=>'<td>'+v+'</td>').join("")+'</tr>';
    });
    body.innerHTML=rows.join("");
    const run=doc.run_id_utc?new Date(doc.run_id_utc):null;
    $("ecmwf-table-run").textContent=run&&Number.isFinite(run.getTime())
      ?"Run: "+new Intl.DateTimeFormat("en-GB",{timeZone:"UTC",weekday:"short",day:"numeric",month:"short",year:"numeric",hour:"2-digit",hourCycle:"h23"}).format(run)+"Z"
      :"ECMWF döngüsü";
    $("ecmwf-table-updated").textContent=doc.updated_at_utc
      ?"Yayın: "+new Intl.DateTimeFormat("tr-TR",{timeZone:"Europe/Istanbul",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(doc.updated_at_utc))+" TSİ"
      :"Yayın zamanı bilinmiyor";
    const intervals=Array.from(new Set(hours.slice(1).map((item,index)=>item.step-hours[index].step).filter(v=>Number.isFinite(v)&&v>0))).sort((a,b)=>a-b);
    const cadence=intervals.length?intervals.map(v=>v+" saat").join("/"):"model";
    $("ecmwf-table-status").textContent=rows.length+" adım · "+cadence+" aralıklı · 180. saate kadar";
  }

  async function load() {
    const status=$("ecmwf-table-status");
    try{
      const response=await fetch("/data/ecmwf/latest.json?t="+Date.now(),{cache:"no-store"});
      if(!response.ok)throw new Error("HTTP "+response.status);
      const doc=await response.json();
      if(!doc||doc.schema!=="gfs-watch.ecmwf-eps.v1"||doc.status!=="ready")throw new Error("ECMWF veri paketi hazır değil.");
      const runs=(Array.isArray(doc.comparison_runs)?doc.comparison_runs:[]).filter(Boolean).slice(-4);
      const allRuns=runs.length?[...runs].sort((a,b)=>Date.parse(a.run_id_utc)-Date.parse(b.run_id_utc)):[doc];
      renderSvg(allRuns);
      renderTable(doc);
      $("ecmwf-run-meta").textContent="Döngü: "+shortRun(doc.run_id_utc)+" UTC · Geçerlilik: +"+doc.forecast_horizon_hours+" saat";
      $("ecmwf-updated").textContent="Yayınlandı: "+shortRun(doc.updated_at_utc)+" TSİ";
      $("ecmwf-table-run").textContent="Döngü: "+shortRun(doc.run_id_utc)+" UTC";
      $("ecmwf-table-updated").textContent="Yayınlandı: "+shortRun(doc.updated_at_utc)+" TSİ";
      status.textContent="Güncel · MeteoPT ECMWF";
    }catch(error){
      status.textContent="ECMWF verisi alınamadı · "+(error.message||"geçici bağlantı sorunu");
    }
  }

  load();
  window.setInterval(load,300000);
})();