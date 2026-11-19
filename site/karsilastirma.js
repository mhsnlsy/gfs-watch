(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const HOUR = 3600000;
  const base = String(window.GFS_WATCH_API_BASE || window.location.origin).replace(/\/$/, "");
  const COLORS = { gfs: "#F1C98B", ec: "#7DD3D7", ok: "#3FB58A", warn: "#F1C98B", major: "#F2706E" };
  const STATUS_TEXT = { ok: "tutarlı", warn: "orta fark", major: "belirgin ayrışma" };
  const RANK = { ok: 0, warn: 1, major: 2 };

  // Her değişken için eşikler: fark >= warn → orta, fark >= major → belirgin.
  const VARS = [
    { id: "t2m", label: "2 m sıcaklık", unit: "°C", field: "temperature_2m_c", warn: 1.5, major: 3, digits: 1 },
    { id: "t850", label: "850 hPa sıcaklık", unit: "°C", field: "temperature_850hpa_c", warn: 1.5, major: 3, digits: 1 },
    { id: "wind", label: "10 m rüzgâr", unit: "km/sa", field: "wind_speed_10m_kmh", warn: 8, major: 15, digits: 0 },
    { id: "rain", label: "Yağış (6 saatlik toplam)", unit: "mm", field: "precipitation_6h_mm", warn: 0.8, major: 2, digits: 1 },
  ];

  const num = value => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const fmt = (value, digits = 1) => value === null || value === undefined
    ? "—"
    : Number(value).toLocaleString("tr-TR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const pad2 = value => String(value).padStart(2, "0");

  function trLabel(ms) {
    const date = new Date(ms);
    const day = new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", weekday: "short", day: "2-digit", month: "2-digit" }).format(date);
    const clock = new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
    return day + " " + clock;
  }
  function runLabel(iso) {
    const date = new Date(iso);
    return pad2(date.getUTCHours()) + "Z · " + pad2(date.getUTCDate()) + "." + pad2(date.getUTCMonth() + 1);
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  // ---- Veri hazırlama -----------------------------------------------------
  function prepare(doc) {
    const initMs = Date.parse(doc.run_id_utc);
    const raw = (Array.isArray(doc.forecast_6_hourly) ? doc.forecast_6_hourly : [])
      .map(point => ({ point, fh: num(point?.forecast_hour), ms: Date.parse(point?.valid_time_utc) }))
      .filter(item => item.fh !== null && item.fh > 0 && Number.isFinite(item.ms))
      .sort((a, b) => a.fh - b.fh);
    let previous = 0;
    const rows = raw.map(item => {
      const row = { ...item, interval: item.fh - previous };
      previous = item.fh;
      return row;
    });
    const byMs = new Map(rows.map(row => [row.ms, row]));
    // Yağış adım başına aralık toplamıdır; 6 saatlik pencereyi tam kapsıyorsa toplanır.
    const rain6 = ms => {
      const window = rows.filter(row => row.ms > ms - 6 * HOUR && row.ms <= ms);
      const covered = window.reduce((sum, row) => sum + row.interval, 0);
      if (!window.length || covered !== 6) return null;
      const values = window.map(row => num(row.point.precipitation_6h_mm));
      return values.some(value => value === null) ? null : values.reduce((a, b) => a + b, 0);
    };
    return { initMs, run: doc.run_id_utc, byMs, rain6 };
  }

  function statusOf(variable, a, b) {
    if (a === null || b === null) return null;
    const diff = Math.abs(a - b);
    if (variable.id === "rain") {
      if (diff >= variable.major || (Math.max(a, b) >= 1 && Math.min(a, b) < 0.1)) return "major";
      return diff >= variable.warn ? "warn" : "ok";
    }
    if (diff >= variable.major) return "major";
    return diff >= variable.warn ? "warn" : "ok";
  }

  function compare(gfsDoc, ecDoc) {
    const gfs = prepare(gfsDoc);
    const ec = prepare(ecDoc);
    const refInit = Math.max(gfs.initMs, ec.initMs);
    const rows = [];
    for (const ms of [...gfs.byMs.keys()].sort((a, b) => a - b)) {
      if (!ec.byMs.has(ms)) continue;
      const date = new Date(ms);
      if (date.getUTCHours() % 6 !== 0) continue;
      const f = (ms - refInit) / HOUR;
      if (!(f > 0 && f <= 180)) continue;
      const g = gfs.byMs.get(ms).point;
      const e = ec.byMs.get(ms).point;
      const values = {};
      const statuses = {};
      let overall = null;
      for (const variable of VARS) {
        const a = variable.id === "rain" ? gfs.rain6(ms) : num(g[variable.field]);
        const b = variable.id === "rain" ? ec.rain6(ms) : num(e[variable.field]);
        values[variable.id] = { gfs: a, ec: b, diff: a === null || b === null ? null : a - b };
        statuses[variable.id] = statusOf(variable, a, b);
        const s = statuses[variable.id];
        if (s && (overall === null || RANK[s] > RANK[overall])) overall = s;
      }
      rows.push({ f, ms, values, statuses, overall });
    }
    return { gfs, ec, refInit, rows: rows.filter(row => row.overall !== null) };
  }

  // ---- Grafik -------------------------------------------------------------
  function niceTicks(lo, hi) {
    if (!(hi > lo)) hi = lo + 1;
    const span = hi - lo;
    const raw = span / 4;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map(m => m * pow).find(value => value >= raw) || 10 * pow;
    const start = Math.floor(lo / step) * step;
    const end = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = start; v <= end + 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
    return ticks;
  }

  function buildChart(result) {
    const rows = result.rows;
    const W = 720, L = 50, R = 16, plotW = W - L - R;
    const panelH = 178, plotTop = 30, plotH = 104, gap = 10;
    const stripTop = 24 + VARS.length * (panelH + gap) + 6;
    const H = stripTop + 92;
    const fMin = rows[0].f, fMax = rows[rows.length - 1].f;
    const xOf = f => L + ((f - fMin) / Math.max(1, fMax - fMin)) * plotW;
    const half = rows.length > 1 ? (rows[1].f - rows[0].f) / 2 : 3;
    const font = "system-ui,-apple-system,Segoe UI,sans-serif";
    const parts = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="GFS ve ECMWF F180 karşılaştırma grafiği">',
      '<rect width="' + W + '" height="' + H + '" fill="#0A1B29"/>',
    ];
    const tickFs = [];
    for (let f = Math.ceil(fMin / 24) * 24; f <= fMax; f += 24) tickFs.push(f);
    if (!tickFs.includes(fMin)) tickFs.unshift(fMin);

    VARS.forEach((variable, index) => {
      const top = 24 + index * (panelH + gap);
      const gValues = rows.map(row => row.values[variable.id].gfs);
      const eValues = rows.map(row => row.values[variable.id].ec);
      const all = gValues.concat(eValues).filter(value => value !== null);
      let lo = all.length ? Math.min(...all) : 0;
      let hi = all.length ? Math.max(...all) : 1;
      if (variable.id === "rain" || variable.id === "wind") lo = Math.min(0, lo);
      const ticks = niceTicks(lo, Math.max(hi, lo + (variable.id === "rain" ? 2 : 1)));
      const yLo = ticks[0], yHi = ticks[ticks.length - 1];
      const yOf = value => top + plotTop + (yHi - value) * plotH / (yHi - yLo);
      parts.push(
        '<rect x="6" y="' + top + '" width="' + (W - 12) + '" height="' + panelH + '" rx="12" fill="#102a3a" stroke="#416174"/>',
        '<text x="20" y="' + (top + 22) + '" fill="#FFFFFF" font-size="15" font-weight="700" font-family="' + font + '">' + esc(variable.label) + "</text>",
        '<text x="' + (W - 20) + '" y="' + (top + 22) + '" text-anchor="end" fill="#B8D7DF" font-size="12" font-family="' + font + '">' + esc(variable.unit) + "</text>"
      );
      // Ayrışma bantları
      rows.forEach(row => {
        const status = row.statuses[variable.id];
        if (status !== "warn" && status !== "major") return;
        const x1 = Math.max(L, xOf(row.f - half)), x2 = Math.min(L + plotW, xOf(row.f + half));
        parts.push('<rect x="' + x1.toFixed(1) + '" y="' + (top + plotTop) + '" width="' + Math.max(1, x2 - x1).toFixed(1) + '" height="' + plotH + '" fill="' + COLORS[status] + '" opacity="' + (status === "major" ? ".26" : ".13") + '"/>');
      });
      ticks.forEach(tick => {
        const y = yOf(tick);
        parts.push(
          '<line x1="' + L + '" x2="' + (L + plotW) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="#456579" stroke-dasharray="2 4" opacity=".6"/>',
          '<text x="' + (L - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" fill="#E7F2F6" font-size="11" font-family="' + font + '">' + fmt(tick, Math.abs(tick) < 10 && variable.id === "rain" ? 1 : 0) + "</text>"
        );
      });
      tickFs.forEach(f => {
        const x = xOf(f);
        parts.push(
          '<line x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + (top + plotTop) + '" y2="' + (top + plotTop + plotH) + '" stroke="#456579" stroke-dasharray="1 5" opacity=".45"/>',
          '<text x="' + x.toFixed(1) + '" y="' + (top + plotTop + plotH + 16) + '" text-anchor="middle" fill="#E7F2F6" font-size="10.5" font-weight="650" font-family="' + font + '">F' + Math.round(f) + "</text>",
          '<text x="' + x.toFixed(1) + '" y="' + (top + plotTop + plotH + 29) + '" text-anchor="middle" fill="#8EAEB7" font-size="9.5" font-family="' + font + '">' + esc(new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", weekday: "short", day: "2-digit" }).format(new Date(result.refInit + f * HOUR))) + "</text>"
        );
      });
      const path = (values, color, width) => {
        let d = "", open = false;
        values.forEach((value, i) => {
          if (value === null) { open = false; return; }
          d += (open ? " L " : " M ") + xOf(rows[i].f).toFixed(1) + " " + yOf(value).toFixed(1);
          open = true;
        });
        return '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + width + '" stroke-linecap="round" stroke-linejoin="round"/>';
      };
      if (variable.id === "rain") {
        // Yağış: yan yana sütunlar daha okunaklı
        const bw = Math.max(2, (plotW / rows.length) * 0.36);
        rows.forEach((row, i) => {
          [["gfs", -bw], ["ec", 0]].forEach(([key, offset]) => {
            const value = row.values.rain[key];
            if (value === null || value <= 0) return;
            const y = yOf(value), y0 = yOf(0);
            parts.push('<rect x="' + (xOf(row.f) + offset).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, y0 - y).toFixed(1) + '" fill="' + COLORS[key] + '" rx="1"/>');
          });
        });
      } else {
        parts.push(path(gValues, COLORS.gfs, 2.4), path(eValues, COLORS.ec, 2.4));
      }
    });

    // Durum şeridi
    parts.push(
      '<text x="20" y="' + (stripTop + 8) + '" fill="#FFFFFF" font-size="14" font-weight="700" font-family="' + font + '">Genel uyum (en kötü değişken)</text>'
    );
    const cell = Math.max(2, plotW / rows.length);
    rows.forEach(row => {
      parts.push('<rect x="' + (xOf(row.f) - cell / 2).toFixed(1) + '" y="' + (stripTop + 20) + '" width="' + cell.toFixed(1) + '" height="30" fill="' + COLORS[row.overall] + '" opacity=".92"/>');
    });
    tickFs.forEach(f => {
      parts.push('<text x="' + xOf(f).toFixed(1) + '" y="' + (stripTop + 68) + '" text-anchor="middle" fill="#E7F2F6" font-size="10.5" font-weight="650" font-family="' + font + '">F' + Math.round(f) + "</text>");
    });
    parts.push(
      '<line class="kars-xhair" x1="0" x2="0" y1="24" y2="' + (stripTop + 52) + '" stroke="#EAF5F8" stroke-width="1.2" stroke-dasharray="4 4" opacity=".8" visibility="hidden" pointer-events="none"/>',
      "</svg>"
    );
    return { svg: parts.join(""), W, L, plotW, fMin, fMax, xOf };
  }

  function attachReadout(host, chart, result) {
    const svg = host.querySelector("svg");
    const line = svg.querySelector(".kars-xhair");
    const readout = $("kars-readout");
    const show = event => {
      const box = svg.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width * chart.W;
      let best = result.rows[0];
      for (const row of result.rows) if (Math.abs(chart.xOf(row.f) - x) < Math.abs(chart.xOf(best.f) - x)) best = row;
      line.setAttribute("x1", chart.xOf(best.f));
      line.setAttribute("x2", chart.xOf(best.f));
      line.setAttribute("visibility", "visible");
      readout.innerHTML = "";
      readout.appendChild(el("strong", "", "F" + Math.round(best.f) + " · " + trLabel(best.ms) + " TSİ · " + STATUS_TEXT[best.overall]));
      VARS.forEach(variable => {
        const v = best.values[variable.id];
        const status = best.statuses[variable.id];
        const line2 = el("div", "", variable.label + ": GFS " + fmt(v.gfs, variable.digits) + " / ECMWF " + fmt(v.ec, variable.digits) + " " + variable.unit +
          (v.diff === null ? "" : " (fark " + fmt(Math.abs(v.diff), variable.digits) + ")"));
        if (status) line2.style.color = COLORS[status];
        readout.appendChild(line2);
      });
    };
    svg.addEventListener("pointermove", show);
    svg.addEventListener("pointerdown", show);
  }

  // ---- Yazılı analiz ------------------------------------------------------
  function groupRanges(rows, predicate) {
    const ranges = [];
    let current = null;
    rows.forEach((row, index) => {
      if (predicate(row)) {
        if (current && current.end === index - 1) { current.end = index; current.rows.push(row); }
        else { current = { start: index, end: index, rows: [row] }; ranges.push(current); }
      }
    });
    return ranges;
  }
  const rangeTitle = range => {
    const a = range.rows[0], b = range.rows[range.rows.length - 1];
    const f = Math.round(a.f) === Math.round(b.f) ? "F" + Math.round(a.f) : "F" + Math.round(a.f) + "–F" + Math.round(b.f);
    return f + " · " + trLabel(a.ms) + (a === b ? "" : " → " + trLabel(b.ms)) + " TSİ";
  };

  function driverLines(range, level) {
    const lines = [];
    VARS.forEach(variable => {
      const hits = range.rows.filter(row => RANK[row.statuses[variable.id] || "ok"] >= RANK[level] && row.statuses[variable.id] === level);
      if (!hits.length) return;
      const worst = hits.reduce((best, row) => {
        const d = Math.abs(row.values[variable.id].diff ?? 0);
        return d > Math.abs(best.values[variable.id].diff ?? 0) ? row : best;
      });
      const v = worst.values[variable.id];
      const lead = v.gfs > v.ec ? "GFS daha yüksek" : "ECMWF daha yüksek";
      lines.push(variable.label + ": en büyük fark F" + Math.round(worst.f) + "'de — GFS " + fmt(v.gfs, variable.digits) + " / ECMWF " + fmt(v.ec, variable.digits) + " " + variable.unit + " (" + lead + ", fark " + fmt(Math.abs(v.diff), variable.digits) + ")" + (hits.length > 1 ? " · " + hits.length + " adımda" : ""));
    });
    return lines;
  }

  function buildAnalysis(result) {
    const host = $("kars-analysis");
    host.innerHTML = "";
    const rows = result.rows;
    const count = status => rows.filter(row => row.overall === status).length;
    const total = rows.length;
    const summary = el("div", "kars-card");
    summary.appendChild(el("h3", "", "Özet"));
    summary.appendChild(el("p", "kars-summary",
      total + " karşılaştırma adımının (F" + Math.round(rows[0].f) + "–F" + Math.round(rows[total - 1].f) + ") " + count("ok") + "'i tutarlı, " + count("warn") + "'i orta farklı, " + count("major") + "'i belirgin ayrışıyor " +
      "(tutarlılık %" + Math.round(count("ok") / total * 100) + ")."));
    host.appendChild(summary);

    const major = groupRanges(rows, row => row.overall === "major");
    const majorCard = el("div", "kars-card kars-major");
    majorCard.appendChild(el("h3", "", "Belirgin ayrışan F değerleri"));
    if (!major.length) {
      majorCard.appendChild(el("p", "kars-summary", "F180'e kadar belirgin ayrışma yok. Modeller bu eşiklerde uyumlu."));
    } else {
      const ul = el("ul");
      major.forEach(range => {
        const li = el("li", "", rangeTitle(range));
        li.style.fontWeight = "700";
        driverLines(range, "major").forEach(text => li.appendChild(el("small", "", text)));
        ul.appendChild(li);
      });
      majorCard.appendChild(ul);
    }
    host.appendChild(majorCard);

    const warn = groupRanges(rows, row => row.overall === "warn");
    if (warn.length) {
      const warnCard = el("div", "kars-card kars-warn");
      warnCard.appendChild(el("h3", "", "Orta düzey fark"));
      const ul = el("ul");
      warn.forEach(range => {
        const names = VARS.filter(variable => range.rows.some(row => row.statuses[variable.id] === "warn")).map(variable => variable.label);
        const li = el("li", "", rangeTitle(range));
        li.style.fontWeight = "700";
        li.appendChild(el("small", "", "Fark çıkan değişkenler: " + names.join(", ")));
        ul.appendChild(li);
      });
      warnCard.appendChild(ul);
      host.appendChild(warnCard);
    }

    const ok = groupRanges(rows, row => row.overall === "ok");
    const okCard = el("div", "kars-card kars-ok");
    okCard.appendChild(el("h3", "", "Tutarlı F değerleri"));
    if (!ok.length) {
      okCard.appendChild(el("p", "kars-summary", "Tüm değişkenlerde birlikte uyumlu bir aralık yok."));
    } else {
      const ul = el("ul");
      ok.forEach(range => {
        const li = el("li", "", rangeTitle(range));
        li.appendChild(el("small", "", range.rows.length >= 2 ? "Sıcaklık, 850 hPa, rüzgâr ve yağış birlikte uyumlu — bu aralıkta tahmin güvenilirliği daha yüksek." : "Tek adım uyumlu."));
        ul.appendChild(li);
      });
      okCard.appendChild(ul);
    }
    host.appendChild(okCard);

    const statsCard = el("div", "kars-card");
    statsCard.appendChild(el("h3", "", "Değişken bazında fark"));
    const table = el("table", "kars-table");
    const head = el("tr");
    ["Değişken", "Ort. fark", "En büyük fark", "Uyumlu adım"].forEach(text => head.appendChild(el("th", "", text)));
    table.appendChild(head);
    VARS.forEach(variable => {
      const diffs = rows.filter(row => row.values[variable.id].diff !== null);
      if (!diffs.length) return;
      const abs = diffs.map(row => Math.abs(row.values[variable.id].diff));
      const maxIndex = abs.indexOf(Math.max(...abs));
      const okCount = diffs.filter(row => row.statuses[variable.id] === "ok").length;
      const tr = el("tr");
      [variable.label, fmt(abs.reduce((a, b) => a + b, 0) / abs.length, variable.digits === 0 ? 1 : variable.digits) + " " + variable.unit,
        fmt(abs[maxIndex], variable.digits) + " " + variable.unit + " (F" + Math.round(diffs[maxIndex].f) + ")",
        "%" + Math.round(okCount / diffs.length * 100)].forEach(text => tr.appendChild(el("td", "", text)));
      table.appendChild(tr);
    });
    statsCard.appendChild(table);
    statsCard.appendChild(el("p", "kars-note",
      "Eşikler — 2 m ve 850 hPa sıcaklık: ≥1,5 °C orta, ≥3 °C belirgin · 10 m rüzgâr: ≥8 orta, ≥15 km/sa belirgin · 6 saatlik yağış: ≥0,8 mm orta, ≥2 mm belirgin ya da biri ≥1 mm kuru/ıslak çelişkisi. " +
      "Yağış, her modelin adım aralıklarının 6 saatlik toplamıdır. F, daha yeni başlatılan modelin döngü saatine göre sayılır."));
    host.appendChild(statsCard);
  }

  // ---- Yükleme ------------------------------------------------------------
  async function getJson(path) {
    const response = await fetch(base + path + "?t=" + Date.now(), { cache: "no-store" });
    if (!response.ok) throw new Error(path + " HTTP " + response.status);
    return response.json();
  }

  async function load() {
    const chartHost = $("kars-chart");
    try {
      const [gfsDoc, ecDoc] = await Promise.all([getJson("/api/latest"), getJson("/api/ecmwf/latest")]);
      $("kars-gfs-run").textContent = "GFS: " + runLabel(gfsDoc.run_id_utc) + " · F" + (gfsDoc.forecast_horizon_hours || 180);
      $("kars-ec-run").textContent = "ECMWF: " + runLabel(ecDoc.run_id_utc) + " · F" + Math.min(180, ecDoc.forecast_horizon_hours || 180);
      const result = compare(gfsDoc, ecDoc);
      if (result.rows.length < 4) throw new Error("Ortak geçerlilik saati sayısı çok az (" + result.rows.length + ")");
      const chart = buildChart(result);
      chartHost.innerHTML = chart.svg;
      attachReadout(chartHost, chart, result);
      buildAnalysis(result);
    } catch (error) {
      chartHost.innerHTML = "";
      chartHost.appendChild(el("div", "", "Karşılaştırma oluşturulamadı: " + (error.message || "geçici bağlantı sorunu")));
      chartHost.firstChild.style.cssText = "padding:30px 14px;color:#F1C98B";
    }
  }

  window.__karsilastirma = { compare, statusOf, VARS };
  load();
  window.setInterval(load, 300000);
})();
