const API_BASE = "https://api.meteopt.com/gfs/json";
const LOCATION = {
  name: "Giresun / Çanakçı",
  latitude: 40.9557,
  longitude: 39.0065,
};
const CYCLES = [18, 12, 6, 0];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function runKey(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(0, 10) : digits;
}

function parseRun(value, fallback) {
  const key = runKey(value);
  if (key.length === 10) {
    const y = Number(key.slice(0, 4));
    const m = Number(key.slice(4, 6)) - 1;
    const d = Number(key.slice(6, 8));
    const h = Number(key.slice(8, 10));
    const date = new Date(Date.UTC(y, m, d, h, 0, 0));
    if (Number.isFinite(date.getTime())) return date;
  }
  return fallback;
}

function asNumber(values, index) {
  try {
    const n = Number(values?.[index]);
    return Number.isFinite(n) && Math.abs(n) !== Infinity ? n : null;
  } catch (_) {
    return null;
  }
}

async function fetchCycle(requestedHour) {
  const url = new URL(API_BASE);
  url.searchParams.set("lat", String(LOCATION.latitude));
  url.searchParams.set("lon", String(LOCATION.longitude));
  url.searchParams.set("run", String(requestedHour).padStart(2, "0"));
  url.searchParams.set("lang", "en");

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "GFS-Watch-Koy-Cloudflare/1.0",
      "Cache-Control": "no-cache",
    },
  });
  if (!response.ok) throw new Error("MeteoPT HTTP " + response.status);

  const document = await response.json();
  const apiRun = String(document?.run || "").trim();
  if (!apiRun) throw new Error("MeteoPT returned no run id");

  return { apiRun, document, url: url.toString() };
}

async function fetchAvailableCycles() {
  const candidates = [];
  // Fetch all four available MeteoPT cycle selectors on every Cloudflare poll.
  // This deliberately keeps the previous three cycles available for the four-run
  // comparison instead of only persisting the newest cycle.
  const preferred = [6, ...CYCLES.filter(h => h !== 6)];
  for (const requestedHour of preferred) {
    try {
      candidates.push(await fetchCycle(requestedHour));
    } catch (error) {
      console.log(JSON.stringify({
        event: "meteopt_cycle_unavailable",
        requested_hour: requestedHour,
        message: String(error?.message || error),
      }));
    }
  }

  const unique = new Map();
  for (const candidate of candidates) {
    const key = runKey(candidate.apiRun);
    if (key) unique.set(key, candidate);
  }

  const sorted = [...unique.values()].sort((a, b) =>
    runKey(b.apiRun).localeCompare(runKey(a.apiRun))
  );

  if (!sorted.length) {
    throw new Error("MeteoPT returned no usable GFS cycle");
  }

  return sorted;
}

async function fetchNewestCycle() {
  return (await fetchAvailableCycles())[0];
}

function normalizeDocument(candidate, now) {
  const fallbackCycle = new Date(now);
  fallbackCycle.setUTCMinutes(0, 0, 0);
  const cycle = parseRun(candidate.apiRun, fallbackCycle);
  const runId = cycle.toISOString().slice(0, 13).replace(/[-:T]/g, "");

  const steps = [];
  for (const value of (candidate.document?.steps?.values || [])) {
    const n = Number(value);
    if (Number.isFinite(n)) steps.push(n);
  }
  if (!steps.length) throw new Error("MeteoPT returned no forecast steps");

  const data = candidate.document?.data || {};
  const series = name => data?.[name]?.values || [];

  const points = [];
  for (let i = 0; i < steps.length; i += 1) {
    const lead = steps[i];
    if (lead <= 0) continue;
    const valid = new Date(cycle.getTime() + lead * 3600000);
    points.push({
      forecast_hour: lead,
      valid_time_utc: valid.toISOString(),
      temperature_2m_c: asNumber(series("tmp2m"), i),
      temperature_850hpa_c: asNumber(series("tmp850mb"), i),
      wind_speed_10m_kmh: asNumber(series("wind10m"), i),
      wind_speed_850hpa_kmh: asNumber(series("wind850"), i),
      precipitation_6h_mm: asNumber(series("apcp"), i),
    });
  }

  const base = {
    location: LOCATION,
    source: "MeteoPT GFS",
    source_url: candidate.url,
    run_id_utc: cycle.toISOString(),
    published_at_utc: new Date(now).toISOString(),
    forecast_source: "meteopt",
  };

  const f72Ready = Math.max(...steps) >= 72 && points.filter(p => p.forecast_hour > 0 && p.forecast_hour <= 72).length >= 12;
  const f72 = f72Ready
    ? {
        ...base,
        schema: "koy-gfs.first72.v1",
        forecast_6_hourly: points.filter(p => p.forecast_hour > 0 && p.forecast_hour <= 72),
      }
    : null;

  const ready180 = Math.max(...steps) >= 180 && points.filter(p => p.forecast_hour > 0 && p.forecast_hour <= 180).length >= 30;
  const full = ready180
    ? {
        ...base,
        schema: "koy-gfs.run.v1",
        forecast_6_hourly: points,
      }
    : null;

  return {
    runId,
    f72,
    full,
    maxForecastHour: Math.max(...steps),
    stepCount: steps.length,
  };
}

async function currentRun(env, key) {
  const row = await env.GFS_DB.prepare(
    "SELECT run_id_utc, payload_json, updated_at_utc FROM gfs_current WHERE key = ?"
  ).bind(key).first();
  if (!row) return null;
  return {
    run_id_utc: row.run_id_utc,
    payload: JSON.parse(row.payload_json),
    updated_at_utc: row.updated_at_utc,
  };
}

async function persistRun(env, full) {
  const existing = await env.GFS_DB.prepare(
    "SELECT run_id_utc FROM gfs_runs WHERE run_id_utc = ?"
  ).bind(full.run_id_utc).first();

  if (existing) return false;

  const storedAt = new Date().toISOString();
  await env.GFS_DB.prepare(
    "INSERT INTO gfs_runs (run_id_utc, payload_json, published_at_utc, stored_at_utc) VALUES (?, ?, ?, ?)"
  ).bind(
    full.run_id_utc,
    JSON.stringify(full),
    full.published_at_utc,
    storedAt,
  ).run();

  return true;
}

async function persistF72(env, f72) {
  const stored = await currentRun(env, "f72");
  if (stored?.run_id_utc === f72.run_id_utc) return false;

  await env.GFS_DB.prepare(
    "INSERT INTO gfs_current (key, run_id_utc, payload_json, updated_at_utc) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET run_id_utc=excluded.run_id_utc, payload_json=excluded.payload_json, updated_at_utc=excluded.updated_at_utc"
  ).bind(
    "f72",
    f72.run_id_utc,
    JSON.stringify(f72),
    new Date().toISOString(),
  ).run();

  return true;
}

async function getPublicationAsset(env, key) {
  return await env.GFS_DB.prepare(
    "SELECT asset_key, run_id_utc, content_type, body, updated_at_utc " +
    "FROM gfs_publication_assets WHERE asset_key = ?"
  ).bind(key).first();
}

async function putPublicationAsset(env, asset) {
  await env.GFS_DB.prepare(
    "INSERT INTO gfs_publication_assets (asset_key, run_id_utc, content_type, body, updated_at_utc) " +
    "VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(asset_key) DO UPDATE SET run_id_utc=excluded.run_id_utc, " +
    "content_type=excluded.content_type, body=excluded.body, updated_at_utc=excluded.updated_at_utc"
  ).bind(
    asset.key,
    asset.run_id_utc || null,
    asset.content_type,
    asset.body,
    new Date().toISOString(),
  ).run();
}

function decodePublicationAsset(row) {
  const headers = new Headers({
    "Content-Type": row.content_type || "image/svg+xml; charset=utf-8",
    "Cache-Control": "public, max-age=3600, s-maxage=86400",
    "Access-Control-Allow-Origin": "*",
    "X-GFS-Publication-Source": "D1",
  });
  if (row.updated_at_utc) headers.set("Last-Modified", row.updated_at_utc);
  return new Response(row.body, { status: 200, headers });
}

const KOY_SVG_RENDERER_VERSION = "cloudflare-js-v1";
const KOY_SVG_COLORS = ["#7DD3D7", "#8ABCE8", "#F1C98B", "#B38BE8"];
const KOY_SVG_PANELS = [
  { id: "temperature", field: "temperature_2m_c", title: "Sıcaklık", unit: "°C" },
  { id: "temperature_850", field: "temperature_850hpa_c", title: "850 hPa sıcaklık", unit: "°C" },
  { id: "precipitation", field: "precipitation_6h_mm", title: "Yağış", unit: "mm / 6 saat" },
  { id: "wind_10m", field: "wind_speed_10m_kmh", title: "10 m rüzgâr hızı", unit: "km/sa" },
];

function svgEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[char]);
}

function svgNumber(value) {
  const number = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(number)
    ? null
    : number;
}

function svgFixed(value, digits = 1) {
  return Number(value).toLocaleString("tr-TR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function svgValidKey(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return null;
  return new Date(Math.floor(timestamp / 60000) * 60000).toISOString();
}

function svgRunStamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.getUTCFullYear().toString() +
    String(date.getUTCMonth() + 1).padStart(2, "0") +
    String(date.getUTCDate()).padStart(2, "0") +
    "T" + String(date.getUTCHours()).padStart(2, "0") + "Z";
}

function svgRunLabel(value, latest) {
  const date = new Date(value);
  const label = String(date.getUTCHours()).padStart(2, "0") + "Z | " +
    String(date.getUTCDate()).padStart(2, "0") + "." +
    String(date.getUTCMonth() + 1).padStart(2, "0") + " " +
    String(date.getUTCHours()).padStart(2, "0") + ":00";
  return latest ? "YENİ · " + label : label;
}

function buildKoyInteractiveSvg(comparison) {
  const documents = (Array.isArray(comparison?.runs) ? comparison.runs : [])
    .filter(item => item && item.forecast_source === "meteopt" &&
      Array.isArray(item.forecast_6_hourly) && item.run_id_utc)
    .slice()
    .sort((a, b) => Date.parse(a.run_id_utc) - Date.parse(b.run_id_utc))
    .slice(-4);

  if (documents.length !== 4) return null;

  const series = documents.map((document, index) => {
    const points = new Map();
    for (const point of document.forecast_6_hourly || []) {
      const key = svgValidKey(point?.valid_time_utc);
      if (key) points.set(key, point);
    }
    if (!points.size) return null;
    return {
      document,
      points,
      label: svgRunLabel(document.run_id_utc, index === documents.length - 1),
      color: KOY_SVG_COLORS[index],
    };
  });

  if (series.some(item => !item)) return null;

  let common = [...series[series.length - 1].points.keys()];
  for (const item of series.slice(0, -1)) {
    const available = item.points;
    common = common.filter(key => available.has(key));
  }
  common.sort();
  if (common.length < 2) return null;

  const firstTimestamp = Date.parse(common[0]);
  const endTimestamp = firstTimestamp + 180 * 3600000;
  const validKeys = common.filter(key => {
    const timestamp = Date.parse(key);
    return timestamp >= firstTimestamp && timestamp <= endTimestamp;
  });
  if (validKeys.length < 2) return null;

  const validDates = validKeys.map(key => new Date(key));
  const offsets = validDates.map(date => (date.getTime() - firstTimestamp) / 3600000);
  const spanHours = offsets[offsets.length - 1] - offsets[0];
  const xMin = -1;
  const xMax = spanHours + Math.max(1, spanHours * 0.015);
  const xRatio = offset => (offset - xMin) / (xMax - xMin);

  const W = 1152;
  const H = 838;
  const panelWidth = 505;
  const panelHeight = 250;
  const panelLeft = [55, 592];
  const panelTop = [214, 493];
  const svgParts = [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-labelledby="koy-gfs-svg-title koy-gfs-svg-desc">',
    '<title id="koy-gfs-svg-title">Köy GFS · Giresun / Çanakçı · Dört döngü karşılaştırması</title>',
    '<desc id="koy-gfs-svg-desc">Dört GFS tahmin döngüsü aynı UTC geçerlilik saatlerinde hizalanmıştır. Grafikler sıcaklık, 850 hPa sıcaklık, yağış ve 10 metre rüzgârını gösterir.</desc>',
    '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#0A1B29"/>',
    '<text x="63" y="34" fill="#7DD3D7" font-size="12" font-weight="700" letter-spacing="1.5" font-family="system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">GFS · GİRESUN ÇANAKÇI</text>',
    '<text x="63" y="76" fill="#FFFFFF" font-size="27" font-weight="750" font-family="system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">Son GFS raporu · 4’lü döngü karşılaştırması</text>',
    '<text x="63" y="108" fill="#E7F2F6" font-size="14" font-family="system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">Dört Köy GFS çıktısı aynı geçerlilik saatlerinde (TSİ) üst üste karşılaştırılır.</text>',
    '<rect x="850" y="20" width="245" height="36" rx="11" fill="#0A1B29" stroke="#416174" stroke-width="1"/>',
    '<text x="972.5" y="43" text-anchor="middle" fill="#B8D7DF" font-size="12" font-family="system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">4 GFS döngüsü karşılaştırılıyor</text>',
  ];

  // A two-column legend preserves the four-cycle order used by the historical SVG.
  series.slice().reverse().forEach((item, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 335 + column * 290;
    const y = 148 + row * 26;
    const latest = item === series[series.length - 1];
    svgParts.push(
      '<line x1="' + x + '" y1="' + y + '" x2="' + (x + 38) + '" y2="' + y + '" stroke="' + item.color + '" stroke-width="' + (latest ? 3.2 : 1.8) + '"' +
      (latest ? "" : ' stroke-dasharray="4 3"') + ' stroke-linecap="round"/>',
      '<text x="' + (x + 49) + '" y="' + (y + 4) + '" fill="#FFFFFF" font-size="12" font-weight="' + (latest ? "700" : "500") + '" font-family="system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">' + svgEscape(item.label) + '</text>'
    );
  });

  const panelMetadata = [];

  KOY_SVG_PANELS.forEach((spec, panelIndex) => {
    const column = panelIndex % 2;
    const row = Math.floor(panelIndex / 2);
    const px = panelLeft[column];
    const py = panelTop[row];
    const plotX = px + 50;
    const plotY = py + 57;
    const plotWidth = panelWidth - 73;
    const plotHeight = 146;
    const panelRight = px + panelWidth;
    const panelBottom = py + panelHeight;

    const valuesBySeries = series.map(item =>
      validKeys.map(key => svgNumber(item.points.get(key)?.[spec.field]))
    );
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
    svgParts.push(
      '<g id="koy-panel-' + spec.id + '">',
      '<rect x="' + px + '" y="' + py + '" width="' + panelWidth + '" height="' + panelHeight + '" rx="13" fill="#102A3A" stroke="#416174" stroke-width="1"/>',
      '<text x="' + (px + 18) + '" y="' + (py + 31) + '" fill="#FFFFFF" font-size="18" font-weight="700" font-family="system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">' + svgEscape(spec.title) + '</text>',
      '<text x="' + (panelRight - 17) + '" y="' + (py + 30) + '" text-anchor="end" fill="#E7F2F6" font-size="12" font-weight="650" font-family="system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">' + svgEscape(spec.unit) + '</text>'
    );

    // Horizontal grid and value axis.
    for (let tick = 0; tick <= 4; tick += 1) {
      const value = high - (high - low) * tick / 4;
      const y = plotY + plotHeight * tick / 4;
      svgParts.push(
        '<line x1="' + plotX + '" y1="' + y + '" x2="' + (plotX + plotWidth) + '" y2="' + y + '" stroke="#456579" stroke-width="1" stroke-dasharray="2 4" opacity=".65"/>',
        '<text x="' + (plotX - 10) + '" y="' + (y + 4) + '" text-anchor="end" fill="#E7F2F6" font-size="11" font-weight="600" font-family="system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">' + svgEscape(svgFixed(value, 1)) + '</text>'
      );
    }

    // Date ticks follow the same 12-hour cadence as the former Matplotlib report.
    const tickIndexes = [];
    offsets.forEach((offset, index) => {
      if (index === 0 || Math.abs(offset % 12) < 0.01) tickIndexes.push(index);
    });
    if (tickIndexes[tickIndexes.length - 1] !== offsets.length - 1) {
      tickIndexes.push(offsets.length - 1);
    }
    tickIndexes.forEach(index => {
      const date = validDates[index];
      const x = xPositions[index];
      const day = String(date.getUTCDate()).padStart(2, "0");
      const weekdays = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
      const weekday = weekdays[date.getUTCDay()];
      const anchor = index === 0 ? "start" : index === offsets.length - 1 ? "end" : "middle";
      svgParts.push(
        '<text x="' + x + '" y="' + (plotY + plotHeight + 19) + '" text-anchor="' + anchor + '" fill="#E7F2F6" font-size="10" font-weight="650" font-family="system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">' +
        '<tspan x="' + x + '">' + day + '</tspan><tspan x="' + x + '" dy="13">' + weekday + '</tspan></text>'
      );
    });

    const panelSeries = [];
    series.forEach((item, seriesIndex) => {
      const values = valuesBySeries[seriesIndex];
      const yPositions = values.map(value => value === null ? null : Number(yFor(value).toFixed(3)));
      const leadHours = validKeys.map(key => {
        const value = Number(item.points.get(key)?.forecast_hour);
        return Number.isFinite(value) ? Math.round(value) : null;
      });
      const directions = validKeys.map(key => {
        if (spec.field !== "wind_speed_10m_kmh") return null;
        return svgNumber(item.points.get(key)?.wind_direction_10m_deg);
      });

      let pathData = "";
      let open = false;
      values.forEach((value, index) => {
        if (value === null) {
          open = false;
          return;
        }
        pathData += (open ? " L " : " M ") + xPositions[index].toFixed(3) + " " + yPositions[index];
        open = true;
      });

      const latest = seriesIndex === series.length - 1;
      svgParts.push(
        '<path d="' + pathData + '" fill="none" stroke="' + item.color + '" stroke-width="' + (latest ? 3.2 : 1.8) + '"' +
        (latest ? "" : ' stroke-dasharray="4 3"') +
        ' stroke-linecap="round" stroke-linejoin="round" opacity="' + (latest ? "1" : ".94") + '"/>'
      );
      if (latest) {
        values.forEach((value, index) => {
          if (value === null) return;
          svgParts.push(
            '<circle cx="' + xPositions[index].toFixed(3) + '" cy="' + yPositions[index] + '" r="2.8" fill="' + item.color + '"/>'
          );
        });
      }

      panelSeries.push({
        label: item.label,
        color: item.color,
        lead_hours: leadHours,
        values,
        y_positions: yPositions,
        directions_deg: directions,
      });
    });

    const validTimeRecords = validKeys.map(key => {
      const date = new Date(key);
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const day = String(date.getUTCDate()).padStart(2, "0");
      const hour = String(date.getUTCHours()).padStart(2, "0");
      const minute = String(date.getUTCMinutes()).padStart(2, "0");
      const label = day + "." + month + "." + year + " " + hour + ":" + minute + " TSİ";
      return {
        local_key: year + "-" + month + "-" + day + "T" + hour + ":" + minute,
        label,
        utc_label: year + "-" + month + "-" + day + " " + hour + ":" + minute + " UTC",
      };
    });

    panelMetadata.push({
      id: spec.id,
      title: spec.title,
      unit: spec.unit,
      plot: { x: plotX, y: plotY, width: plotWidth, height: plotHeight },
      x_positions: xPositions.map(value => Number(value.toFixed(3))),
      valid_times: validTimeRecords,
      series: panelSeries,
    });

    if (!allValues.length) {
      svgParts.push(
        '<text x="' + (plotX + plotWidth / 2) + '" y="' + (plotY + plotHeight / 2) + '" text-anchor="middle" fill="#E7F2F6" font-size="13" font-family="system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">Bu değişken için veri yok</text>'
      );
    }
    svgParts.push("</g>");
  });

  const location = comparison.location || LOCATION;
  const locationName = String(location.name || "Giresun / Çanakçı");
  const sourceName = String(series[series.length - 1].document.source || "MeteoPT GFS").trim();
  const metadata = { version: 1, renderer: KOY_SVG_RENDERER_VERSION, panels: panelMetadata };
  const metadataText = JSON.stringify(metadata).replace(/\]\]>/g, "]]\\u003e");
  const footer = "Kaynak: Köy GFS · " + sourceName + " · " + locationName + " nokta tahmini";
  svgParts.push(
    '<text x="63" y="810" fill="#E7F2F6" font-size="11" font-family="system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">Aynı geçerlilik saatleri (TSİ) · ' + validKeys.length + ' ortak nokta</text>',
    '<text x="1090" y="810" text-anchor="end" fill="#E7F2F6" font-size="10" font-family="system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">' + svgEscape(footer) + '</text>',
    '<metadata id="gfs-renderer-version">' + KOY_SVG_RENDERER_VERSION + '</metadata>',
    '<metadata id="gfs-interactive-data"><![CDATA[' + metadataText + ']]></metadata>',
    '<g id="gfs-interaction-layer">'
  );

  panelMetadata.forEach(panel => {
    const plot = panel.plot;
    const xStart = panel.x_positions[0];
    svgParts.push(
      '<g class="gfs-panel-interaction" data-panel-id="' + panel.id + '">',
      '<rect class="gfs-hit-area" data-panel-id="' + panel.id + '" x="' + plot.x + '" y="' + plot.y + '" width="' + plot.width + '" height="' + plot.height + '" fill="transparent" pointer-events="all" tabindex="0" role="group" aria-label="' + svgEscape(panel.title) + ' grafiği; ok tuşlarıyla geçerlilik saatleri arasında gezinin"/>',
      '<line class="gfs-tooltip-crosshair" x1="' + xStart + '" x2="' + xStart + '" y1="' + plot.y + '" y2="' + (plot.y + plot.height) + '" stroke="#EAF5F8" stroke-width="1.1" stroke-dasharray="4 4" opacity=".78" visibility="hidden" pointer-events="none"/>',
      '<g class="gfs-tooltip-markers" pointer-events="none"></g>',
      "</g>"
    );
  });

  svgParts.push("</g></svg>");
  const body = svgParts.join("");
  if (body.length > 1900000) throw new Error("Generated Köy SVG exceeds the D1 row safety limit");
  return {
    key: "media/koy-gfs-" + svgRunStamp(series[series.length - 1].document.run_id_utc) + "-comparison.svg",
    run_id_utc: series[series.length - 1].document.run_id_utc,
    body,
  };
}

async function publishLatestKoySvg(env, expectedKey = null) {
  const result = await env.GFS_DB.prepare(
    "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
  ).all();
  const runs = (result.results || []).map(row => JSON.parse(row.payload_json));
  if (runs.length < 4) return null;

  const latest = runs.slice().sort((a, b) =>
    Date.parse(a.run_id_utc) - Date.parse(b.run_id_utc)
  );
  const comparison = {
    schema: "koy-gfs.comparison.v1",
    location: LOCATION,
    updated_at_utc: latest[latest.length - 1]?.published_at_utc || null,
    runs: latest,
  };
  const built = buildKoyInteractiveSvg(comparison);
  if (!built || (expectedKey && expectedKey !== built.key)) return null;

  const existing = await getPublicationAsset(env, built.key);
  if (!existing || existing.body !== built.body ||
      existing.content_type !== "image/svg+xml; charset=utf-8" ||
      existing.run_id_utc !== built.run_id_utc) {
    await putPublicationAsset(env, {
      key: built.key,
      body: built.body,
      content_type: "image/svg+xml; charset=utf-8",
      run_id_utc: built.run_id_utc,
    });
  }
  const stored = await getPublicationAsset(env, built.key);
  return stored ? { key: built.key, row: stored, renderer: KOY_SVG_RENDERER_VERSION } : null;
}

async function collect(env) {
  const now = new Date();
  const candidates = await fetchAvailableCycles();
  const normalizedRuns = candidates.map(candidate => normalizeDocument(candidate, now));
  const normalized = normalizedRuns[0];

  let f72Changed = false;
  let f180Changed = false;
  let archivedRunsChanged = 0;
  let comparisonSvgPublished = false;

  // The newest cycle remains the canonical F72/F180 output.
  if (normalized.f72) {
    f72Changed = await persistF72(env, normalized.f72);
  }

  // Persist every available F180-ready cycle. This backfills the previous three
  // cycles on the first Cloudflare poll and maintains the four-run comparison
  // automatically thereafter.
  for (const run of normalizedRuns) {
    if (run.full && await persistRun(env, run.full)) {
      archivedRunsChanged += 1;
      f180Changed = true;
    }
  }

  // Render the four-cycle interactive SVG in this Worker and keep the canonical copy in D1.
  // A rendering problem must not interrupt the successful GFS data collection.
  if (archivedRunsChanged > 0) {
    try {
      comparisonSvgPublished = Boolean(await publishLatestKoySvg(env));
    } catch (error) {
      console.error(JSON.stringify({
        event: "koy_gfs_svg_publish_error",
        message: String(error?.message || error),
      }));
    }
  }

  // Keep the F72 endpoint on the same canonical F180-ready cycle once it exists.
  if (normalized.full && f180Changed) {
    f72Changed = await persistF72(env, normalized.full) || f72Changed;
  }

  console.log(JSON.stringify({
    event: "koy_gfs_collect",
    run_id_utc: normalized.runId,
    fetched_cycles: normalizedRuns.length,
    archived_runs_changed: archivedRunsChanged,
    f72_ready: Boolean(normalized.f72),
    f72_changed: f72Changed,
    f180_ready: Boolean(normalized.full),
    f180_changed: f180Changed,
    comparison_svg_published: comparisonSvgPublished,
    max_forecast_hour: normalized.maxForecastHour,
    step_count: normalized.stepCount,
  }));

  return {
    ok: true,
    run_id_utc: normalized.runId,
    fetched_cycles: normalizedRuns.length,
    archived_runs_changed: archivedRunsChanged,
    f72_ready: Boolean(normalized.f72),
    f72_changed: f72Changed,
    f180_ready: Boolean(normalized.full),
    f180_changed: f180Changed,
    comparison_svg_published: comparisonSvgPublished,
    max_forecast_hour: normalized.maxForecastHour,
    step_count: normalized.stepCount,
    checked_at_utc: now.toISOString(),
  };
}

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (request.method === "OPTIONS") return json({ ok: true });

  if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);

  if (path === "/api/comparison.svg") {
    try {
      const published = await publishLatestKoySvg(env);
      if (!published?.row) return json({ ok: false, error: "Four complete Köy GFS cycles are not available" }, 404);
      return decodePublicationAsset(published.row);
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path.startsWith("/api/publication-asset/")) {
    const key = decodeURIComponent(path.slice("/api/publication-asset/".length)).replace(/^\/+/, "");
    try {
      let row = await getPublicationAsset(env, key);
      if (!row || !String(row.body || "").includes('id="gfs-renderer-version">')) {
        const published = await publishLatestKoySvg(env, key);
        if (published?.row) row = published.row;
      }
      if (!row) return json({ ok: false, error: "Publication asset not found" }, 404);
      return decodePublicationAsset(row);
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/health") {
    try {
      const current = await currentRun(env, "f72");
      const count = await env.GFS_DB.prepare("SELECT COUNT(*) AS count FROM gfs_runs").first();
      const assetCount = await env.GFS_DB.prepare("SELECT COUNT(*) AS count FROM gfs_publication_assets").first();
      return json({
        ok: true,
        service: "gfs-watch-koy-gfs",
        storage: "D1",
        cron: "*/10 * * * *",
        location: LOCATION,
        latest_run_id_utc: current?.run_id_utc || null,
        latest_updated_at_utc: current?.updated_at_utc || null,
        archived_runs: Number(count?.count || 0),
        publication_assets: Number(assetCount?.count || 0),
        svg_renderer: KOY_SVG_RENDERER_VERSION,
      });
    } catch (error) {
      return json({ ok: false, service: "gfs-watch-koy-gfs", error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/f72") {
    try {
      let current = await currentRun(env, "f72");
      // Bootstrap the first dataset on demand. This removes the cold-start gap
      // between Worker deployment and the first 10-minute Cron tick.
      if (!current) {
        await collect(env);
        current = await currentRun(env, "f72");
      }
      if (!current) return json({ ok: false, error: "F72 data not collected yet" }, 404);
      return json(current.payload);
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/comparison") {
    try {
      let result = await env.GFS_DB.prepare(
        "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
      ).all();
      let runs = (result.results || []).map(row => JSON.parse(row.payload_json));

      // If the comparison archive is incomplete (for example immediately after
      // migration), fetch all currently available MeteoPT cycles before replying.
      if (runs.length < 4) {
        await collect(env);
        result = await env.GFS_DB.prepare(
          "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
        ).all();
        runs = (result.results || []).map(row => JSON.parse(row.payload_json));
      }

      return json({
        schema: "koy-gfs.comparison.v1",
        location: LOCATION,
        updated_at_utc: runs[0]?.published_at_utc || null,
        runs,
      });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  if (path === "/api/latest") {
    try {
      let current = await currentRun(env, "f72");
      // Same cold-start bootstrap for clients that use the aggregate endpoint.
      if (!current) {
        await collect(env);
        current = await currentRun(env, "f72");
      }
      const comparison = await env.GFS_DB.prepare(
        "SELECT payload_json FROM gfs_runs ORDER BY run_id_utc DESC LIMIT 4"
      ).all();
      return json({
        ok: true,
        f72: current?.payload || null,
        comparison: {
          schema: "koy-gfs.comparison.v1",
          location: LOCATION,
          updated_at_utc: current?.updated_at_utc || null,
          runs: (comparison.results || []).map(row => JSON.parse(row.payload_json)),
        },
      });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 503);
    }
  }

  return json({ ok: false, error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    return api(request, env);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      collect(env).catch(error => {
        console.error(JSON.stringify({
          event: "koy_gfs_cron_error",
          message: String(error?.message || error),
          scheduled_time: new Date(controller.scheduledTime).toISOString(),
        }));
      })
    );
  },
};
