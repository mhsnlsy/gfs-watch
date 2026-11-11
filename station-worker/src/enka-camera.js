import jpeg from "jpeg-js";

export const ENKA_CAMERA_URL = "https://w.enka.com/camhd/cam1/c.jpg";
export const KNOTS_TO_KMH = 1.852;
const CARDINALS = new Set([
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"
]);

export function knotsToKmh(knots) {
  const n = Number(knots);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * KNOTS_TO_KMH * 10) / 10;
}

export function shouldUseCameraFallback(observation, staleAfterMinutes = 20) {
  if (!observation) return true;
  if (observation.is_stale === true || observation.status === "stale") return true;
  if (observation.temperature_2m_c == null || observation.observed_at_utc == null) return true;
  const age = Number(observation.age_minutes);
  if (!Number.isFinite(age) || age > staleAfterMinutes || age < -5) return true;
  return false;
}

function holes(bits) {
  const height = bits.length;
  const width = height ? bits[0].length : 0;
  if (!height || !width) return 0;
  const seen = bits.map(() => Array(width).fill(false));
  const queue = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height || seen[y][x] || bits[y][x]) return;
    seen[y][x] = true;
    queue.push([x, y]);
  };
  for (let x = 0; x < width; x += 1) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y += 1) { push(0, y); push(width - 1, y); }
  while (queue.length) {
    const [x, y] = queue.pop();
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
  }
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (bits[y][x] || seen[y][x]) continue;
      count += 1;
      const fill = [[x, y]];
      seen[y][x] = true;
      while (fill.length) {
        const [cx, cy] = fill.pop();
        for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || bits[ny][nx] || seen[ny][nx]) continue;
          seen[ny][nx] = true;
          fill.push([nx, ny]);
        }
      }
    }
  }
  return count;
}

function density(bits, y0, y1, x0, x1) {
  const height = bits.length;
  const width = height ? bits[0].length : 0;
  y0 = Math.max(0, Math.min(height, y0));
  y1 = Math.max(0, Math.min(height, y1));
  x0 = Math.max(0, Math.min(width, x0));
  x1 = Math.max(0, Math.min(width, x1));
  if (y1 <= y0 || x1 <= x0) return 0;
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) { n += 1; sum += bits[y][x]; }
  }
  return sum / n;
}

function classifyGlyph(bits) {
  const height = bits.length;
  const width = height ? bits[0].length : 0;
  if (!height || !width) return "";
  if (height <= 3 && width >= 4) return "-";
  if (width <= 3 && height >= 8) return ":";
  if (height <= 4 && width <= 4) return ".";
  const inkRows = [];
  bits.forEach((row, index) => { if (row.some(Boolean)) inkRows.push(index); });
  if (inkRows.length && inkRows[inkRows.length - 1] - inkRows[0] <= 3 && width <= 4) {
    return inkRows[0] > height * 0.55 ? "." : "°";
  }
  const holeCount = holes(bits);
  const aspect = width / Math.max(1, height);
  const top = density(bits, 0, Math.max(1, Math.floor(height / 3)), 0, width);
  const mid = density(bits, Math.floor(height / 3), Math.max(Math.floor(height / 3) + 1, Math.floor(2 * height / 3)), 0, width);
  const bot = density(bits, Math.floor(2 * height / 3), height, 0, width);
  const left = density(bits, 0, height, 0, Math.max(1, Math.floor(width / 3)));
  const right = density(bits, 0, height, Math.floor(2 * width / 3), width);
  const center = density(bits, Math.floor(height / 3), Math.floor(2 * height / 3), Math.floor(width / 3), Math.max(Math.floor(width / 3) + 1, Math.floor(2 * width / 3)));
  if (aspect < 0.5 && right > 0.7 && holeCount === 0 && width <= 8) return "1";
  if (right > left + 0.2 && bot > 0.35 && top < 0.42 && mid < 0.5) return "4";
  if (holeCount >= 2 && aspect < 0.85) return "8";
  if (holeCount === 1 && center < 0.15) return "0";
  if (holeCount === 1 && left > right + 0.04 && bot + 0.05 >= top) return "6";
  if (holeCount === 1 && center >= 0.15 && bot < mid - 0.02) return "9";
  if (holeCount === 0 && mid < 0.18 && bot > 0.35 && top > 0.3) return "2";
  if (holeCount === 0 && top > 0.38 && bot < 0.22 && mid < 0.28) return "7";
  if (holeCount === 0 && right > left + 0.2 && bot > 0.35 && top < 0.4) return "4";
  if (holeCount === 0 && left + 0.02 >= right && mid > 0.28 && top > 0.3 && bot > 0.25 && center > 0.15) return "5";
  if (holeCount === 0 && right > left + 0.08 && mid >= 0.16 && top > 0.25 && bot > 0.2) return "3";
  if (holeCount === 0 && aspect > 1.2) return "W";
  if (holeCount === 0 && aspect >= 0.65 && aspect <= 1.05 && top > 0.25 && bot > 0.25 && mid < 0.32) return "S";
  return "?";
}

function readRegion(luma, width, height, x0, y0, x1, y1, threshold = 190) {
  const bright = (x, y) => luma[y * width + x] > threshold;
  const rows = [];
  for (let y = y0; y < y1; y += 1) {
    let count = 0;
    for (let x = x0; x < x1; x += 1) if (bright(x, y)) count += 1;
    rows.push(count);
  }
  const bands = [];
  let open = false;
  let start = 0;
  rows.forEach((count, index) => {
    if (count >= 2 && !open) { open = true; start = index; }
    else if (count < 2 && open) {
      open = false;
      if (index - start >= 4) bands.push([y0 + start, y0 + index]);
    }
  });
  if (open && rows.length - start >= 4) bands.push([y0 + start, y0 + rows.length]);
  return bands.map(([top, bottom]) => {
    const chars = [];
    let run = false;
    let runStart = 0;
    const close = end => {
      if (end - runStart < 1) return;
      const ys = [];
      const xs = [];
      for (let y = top; y < bottom; y += 1) {
        for (let x = runStart; x < end; x += 1) if (bright(x, y)) { ys.push(y); xs.push(x); }
      }
      if (!ys.length) return;
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const bits = [];
      let ink = 0;
      for (let y = minY; y <= maxY; y += 1) {
        const row = [];
        for (let x = minX; x <= maxX; x += 1) {
          const on = bright(x, y) ? 1 : 0;
          ink += on;
          row.push(on);
        }
        bits.push(row);
      }
      if (ink < 3) return;
      chars.push(classifyGlyph(bits));
    };
    for (let x = x0; x < x1; x += 1) {
      let count = 0;
      for (let y = top; y < bottom; y += 1) if (bright(x, y)) count += 1;
      if (count >= 1 && !run) { run = true; runStart = x; }
      else if (count < 1 && run) { run = false; close(x); }
    }
    if (run) close(x1);
    return chars.join("");
  });
}

function firstNumber(text, pattern) {
  const match = String(text || "").match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function directionFrom(text) {
  const letters = String(text || "").replace(/[^NSEW]/g, "");
  for (let size = Math.min(3, letters.length); size >= 1; size -= 1) {
    const candidate = letters.slice(-size);
    if (CARDINALS.has(candidate)) return candidate;
  }
  return null;
}

export function parseCameraOverlayText(metricLines, timeText) {
  const lines = Array.isArray(metricLines) ? metricLines : [];
  const metricsText = lines.join(" | ");

  // Do not depend on the overlay being segmented into exactly four OCR lines.
  // Camera compression/exposure can merge or split glyph bands, so parse the
  // measurements from the complete metric region as well.
  const temperature = firstNumber(lines[0], /(-?\d{1,2}[.,]\d)/)
    ?? firstNumber(metricsText, /(-?\d{1,2}[.,]\d)/);
  const humidityMatch = metricsText.match(/(\d{1,3})\s*%/);
  const pressureCandidates = [...metricsText.matchAll(/(\d{3,4}[.,]\d)/g)]
    .map(m => Number(m[1].replace(",", ".")))
    .filter(v => v >= 900 && v <= 1100);
  const pressure = pressureCandidates[0] ?? firstNumber(lines[2], /(\d{3,4}[.,]\d)/);
  const windLine = String(lines[3] || "");
  const windMatch = windLine.match(/(\d{1,2}[.,]\d)/);
  const windKnots = windMatch
    ? Number(windMatch[1].replace(",", "."))
    : (() => {
        const candidates = [...metricsText.matchAll(/(\d{1,2}[.,]\d)\s*(?:kt|kts|knots)/ig)];
        return candidates.length ? Number(candidates[0][1].replace(",", ".")) : null;
      })();
  const windDirection = directionFrom(
    windLine.replace(/^.*?(\d{1,2}[.,]\d)/, "")
  );

  const normalizedTime = String(timeText || "")
    .replace(/[Oo]/g, "0")
    .replace(/[Il]/g, "1")
    .replace(/\s+/g, " ")
    .trim();
  const stamp = normalizedTime.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})\s*(\d{1,2})[:.](\d{2})[:.](\d{2})/)
    || normalizedTime.match(/(\d{2})(\d{2})(\d{4})\s*(\d{2})[:.](\d{2})[:.](\d{2})/);

  if (temperature == null || humidity == null || pressure == null || windKnots == null || !stamp) return null;
  if (temperature < -40 || temperature > 50) return null;
  if (humidity < 0 || humidity > 100) return null;
  if (pressure < 900 || pressure > 1100) return null;
  if (windKnots < 0 || windKnots > 80) return null;

  const day = Number(stamp[1]);
  const month = Number(stamp[2]);
  let year = Number(stamp[3]);
  if (year < 100) year += 2000;
  const hour = Number(stamp[4]);
  const minute = Number(stamp[5]);
  const second = Number(stamp[6]);
  const observedAt = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - 3 * 60 * 60 * 1000);
  if (!Number.isFinite(observedAt.getTime())) return null;

  return {
    temperature_c: temperature,
    humidity_percent: humidity,
    pressure_hpa: pressure,
    wind_knots: windKnots,
    wind_direction_cardinal: windDirection,
    observed_at_utc: observedAt.toISOString()
  };
}
export function recognizeCameraOverlay(jpegBytes) {
  const decoded = jpeg.decode(jpegBytes, { useTArray: true, formatAsRGBA: true });
  const { width, height, data } = decoded;
  const luma = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < luma.length; i += 1, p += 4) {
    luma[i] = (data[p] + data[p + 1] + data[p + 2]) / 3;
  }

  // The ENKA camera overlay is a real image rather than a text endpoint.
  // Use several luminance thresholds so compression, glare and night/day
  // exposure changes do not make the backup OCR fail on a single threshold.
  const thresholds = [150, 160, 175, 190, 205, 220, 235];
  const metricRegions = [
    [0.72, 0.70, 1.00, 0.99],
    [0.76, 0.68, 1.00, 0.99],
    [0.68, 0.72, 1.00, 0.99],
    [0.55, 0.65, 1.00, 0.99]
  ];
  const timeRegions = [
    [0.00, 0.72, 0.72, 0.99],
    [0.20, 0.68, 0.90, 0.99],
    [0.00, 0.55, 1.00, 0.99]
  ];
  let lastMetrics = [];
  let lastTimeText = "";

  for (const threshold of thresholds) {
    for (const mr of metricRegions) {
      const metrics = readRegion(
        luma, width, height,
        Math.floor(width * mr[0]),
        Math.floor(height * mr[1]),
        Math.floor(width * mr[2]),
        Math.floor(height * mr[3]),
        threshold
      );
      lastMetrics = metrics;
      for (const tr of timeRegions) {
        const timeLines = readRegion(
          luma, width, height,
          Math.floor(width * tr[0]),
          Math.floor(height * tr[1]),
          Math.floor(width * tr[2]),
          Math.floor(height * tr[3]),
          threshold
        );
        const timeText = timeLines.join(" ");
        lastTimeText = timeText;
        const reading = parseCameraOverlayText(metrics, timeText);
        if (reading) {
          return { ...reading, metric_lines: metrics, time_text: timeText, ocr_threshold: threshold };
        }
      }
    }
  }

  const error = new Error(
    "ENKA kamera OCR yazısı okunamadı: " +
    lastMetrics.join(" / ") +
    " | " +
    lastTimeText
  );
  error.metric_lines = lastMetrics;
  error.time_text = lastTimeText;
  throw error;
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function dewPoint(temp, humidity) {
  if (temp == null || humidity == null || humidity <= 0 || humidity > 100) return null;
  const a = 17.27;
  const b = 237.7;
  const g = Math.log(humidity / 100) + (a * temp) / (b + temp);
  const dp = (b * g) / (a - g);
  return Number.isFinite(dp) ? round1(dp) : null;
}

function feelsLike(tempC, humidity, windKmh) {
  if (!Number.isFinite(tempC)) return null;
  const rh = Number.isFinite(humidity) ? Math.max(0, Math.min(100, humidity)) : 50;
  const windMs = Number.isFinite(windKmh) ? Math.max(0, windKmh / 3.6) : 0;
  const e = (rh / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
  const at = tempC + 0.348 * e - 0.7 * windMs - 4.25;
  return Number.isFinite(at) ? round1(at) : null;
}

export function observationFromCameraReading(reading, staleAfterMinutes = 20, now = Date.now()) {
  if (!reading) return null;
  const windKmh = knotsToKmh(reading.wind_knots);
  const observed = Date.parse(reading.observed_at_utc);
  const age = Number.isFinite(observed) ? Math.max(0, (now - observed) / 60000) : null;
  const fresh = age !== null && age <= staleAfterMinutes && age >= -5;
  return {
    station_id: "ENKA-BALMUMCU-WEATHERLINK",
    station_name: "ENKA Balmumcu",
    source: "ENKA · OCR",
    source_url: ENKA_CAMERA_URL,
    observed_at_utc: reading.observed_at_utc,
    fetched_at_utc: new Date(now).toISOString(),
    age_minutes: age === null ? null : round1(age),
    status: fresh ? "live" : "stale",
    is_stale: !fresh,
    temperature_2m_c: round1(reading.temperature_c),
    humidity_percent: round1(reading.humidity_percent),
    station_pressure_hpa: round1(reading.pressure_hpa),
    actual_station_pressure_hpa: round1(reading.pressure_hpa),
    wind_speed_10m_kmh: windKmh,
    wind_speed_10m_knots: round1(reading.wind_knots),
    wind_direction_cardinal: reading.wind_direction_cardinal,
    wind_direction_degrees: null,
    wind_direction_tr: null,
    dew_point_c: dewPoint(reading.temperature_c, reading.humidity_percent),
    feels_like_c: feelsLike(reading.temperature_c, reading.humidity_percent, windKmh),
    precipitation_1h_mm: null,
    precipitation_10m_mm: null,
    precipitation_6h_mm: null,
    precipitation_12h_mm: null,
    precipitation_24h_mm: null,
    precipitation_daily_mm: null,
    precipitation_source: null,
    observation_method: "enka-camera-overlay"
  };
}
