// Shared Y-axis scale for the Istanbul and Köy GFS comparison charts.
// The scale is determined ONLY from the newest (solid) GFS cycle.
// Older comparison cycles may therefore extend beyond the visible plot;
// their peaks are intentionally allowed to be clipped.
// Ticks are whole numbers. Temperature and 850 hPa step by 5, wind by 10.
// Precipitation steps by 1 (0, 1, 2, 3, …). Above 16 the labels get too dense,
// so that panel alone widens to a step of 2.

export function isTemperatureField(field) {
  return field === "temperature_2m_c" || field === "temperature_850hpa_c";
}

export function axisStep(field, maxValue) {
  if (field === "precipitation_6h_mm") {
    return Number.isFinite(maxValue) && maxValue > 16 ? 2 : 1;
  }
  if (field === "wind_speed_10m_kmh") return 10;
  return 5;
}

export function peakUnit(field) {
  if (field === "precipitation_6h_mm") return "mm";
  if (field === "wind_speed_10m_kmh") return "km/sa";
  return "°C";
}

export function formatAxisTick(value) {
  return String(Math.round(value));
}

export function formatPeakValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(n);
}

export function buildPanelAxis(field, valuesBySeries) {
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
  const maxValue = latestValues.length ? Math.max(...latestValues) : null;
  const step = axisStep(field, maxValue);

  let low = 0;
  let high = step;
  if (latestValues.length) {
    if (temperature) {
      low = Math.floor(Math.min(...latestValues) / step) * step;
      high = Math.ceil(Math.max(...latestValues) / step) * step;
    } else {
      low = 0;
      high = Math.ceil(Math.max(0, ...latestValues) / step) * step;
    }
  }
  // Reserve headroom when the newest peak is on/near the top tick.
  // This keeps the latest marker and value label fully inside the chart.
  if (latestValues.length && Number.isFinite(high) && Number.isFinite(latestPeak) &&
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

function boxesOverlap(a, b, pad = 4) {
  return a.x < b.x + b.width + pad && a.x + a.width + pad > b.x &&
    a.y < b.y + b.height + pad && a.y + a.height + pad > b.y;
}

export function seriesCalloutPlacement({ x, y, plotX, plotY, plotWidth, plotHeight, label, avoidBoxes = [] }) {
  const labelWidth = Math.max(36, String(label || "").length * 6.8 + 12);
  const preferredBelow = y - plotY < 18;
  const preferredRight = x > plotX + plotWidth - 56;
  const place = (below, right) => {
    const labelX = right ? x - 10 : x + 10;
    const labelY = below ? y + 18 : y - 12;
    const boxX = right ? labelX - labelWidth : labelX - 5;
    const boxY = labelY - 12;
    return {
      below,
      nearRight: right,
      labelX,
      labelY,
      labelWidth,
      boxX,
      boxY,
      box: { x: boxX, y: boxY, width: labelWidth, height: 16 }
    };
  };
  const candidates = [
    [preferredBelow, preferredRight],
    [!preferredBelow, preferredRight],
    [preferredBelow, !preferredRight],
    [!preferredBelow, !preferredRight]
  ];
  let fallback = null;
  for (const [below, right] of candidates) {
    const layout = place(below, right);
    const inside = layout.box.y >= plotY - 4 && layout.box.y + layout.box.height <= plotY + plotHeight + 20;
    if (!fallback) fallback = layout;
    if (inside && !avoidBoxes.some(box => boxesOverlap(layout.box, box))) return layout;
  }
  return fallback;
}
