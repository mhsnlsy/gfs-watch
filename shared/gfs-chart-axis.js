// Shared Y-axis scale for the Istanbul and Köy GFS comparison charts.
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
  const allValues = valuesBySeries.flat().filter(value => value !== null);
  const latestValues = (valuesBySeries[valuesBySeries.length - 1] || []).filter(value => value !== null);
  const latestPeak = latestValues.length ? Math.max(...latestValues) : null;
  const temperature = isTemperatureField(field);
  const maxValue = allValues.length ? Math.max(...allValues) : null;
  const step = axisStep(field, maxValue);

  let low = 0;
  let high = step;
  if (allValues.length) {
    if (temperature) {
      low = Math.floor(Math.min(...allValues) / step) * step;
      high = Math.ceil(Math.max(...allValues) / step) * step;
    } else {
      low = 0;
      high = Math.ceil(Math.max(0, ...allValues) / step) * step;
    }
  }
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    low = temperature && Number.isFinite(low) ? low : 0;
    high = low + step;
  }

  const ticks = [];
  for (let value = low; value <= high + 1e-9; value += step) {
    ticks.push(Math.round(value));
  }
  return { low, high, ticks, step, latestPeak };
}
