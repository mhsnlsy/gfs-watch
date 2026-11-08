import { Resvg } from "@cf-wasm/resvg";

const TELEGRAM_IMAGE_WIDTH = 2048;
const TELEGRAM_VIEWBOX = "-107 0 1366 838";
const TELEGRAM_FONT_KEY = "assets/fonts/Inter-Variable.ttf";
const TELEGRAM_FONT_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf";

let fontBytesPromise = null;

function isTrueTypeFont(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 100000) return false;
  const signature = String.fromCharCode(...bytes.slice(0, 4));
  return signature === "\u0000\u0001\u0000\u0000" || signature === "OTTO";
}

/** Load and persist the OFL-licensed Inter font so Workerd has deterministic glyph coverage. */
export async function loadIstanbulTelegramFont(archive) {
  if (fontBytesPromise) return fontBytesPromise;
  fontBytesPromise = (async () => {
    if (archive?.get) {
      try {
        const object = await archive.get(TELEGRAM_FONT_KEY);
        if (object) {
          const cached = new Uint8Array(await object.arrayBuffer());
          if (isTrueTypeFont(cached)) return cached;
        }
      } catch (_) {
        // A cache miss or temporary R2 read error falls through to the source fetch.
      }
    }

    const response = await fetch(TELEGRAM_FONT_URL, {
      headers: { "User-Agent": "Istanbul-Havasi-Telegram-Renderer/1.0" },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error("Telegram Inter font download failed: HTTP " + response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isTrueTypeFont(bytes)) throw new Error("Telegram Inter font payload is not a valid TTF/OTF file");

    if (archive?.put) {
      try {
        await archive.put(TELEGRAM_FONT_KEY, bytes, {
          httpMetadata: {
            contentType: "font/ttf",
            cacheControl: "public, max-age=31536000, immutable",
          },
        });
      } catch (error) {
        console.warn("Telegram font R2 cache write failed:", String(error?.message || error));
      }
    }
    return bytes;
  })();

  try {
    return await fontBytesPromise;
  } catch (error) {
    fontBytesPromise = null;
    throw error;
  }
}

function expandTelegramCanvas(svg) {
  const opening = svg.match(/<svg\\b[^>]*>/i);
  if (!opening) throw new Error("Istanbul GFS SVG root element is missing");
  let root = opening[0];
  root = root
    .replace(/\\bwidth="[^"]*"/i, 'width="' + TELEGRAM_IMAGE_WIDTH + '"')
    .replace(/\\bheight="[^"]*"/i, 'height="1257"')
    .replace(/\\bviewBox="[^"]*"/i, 'viewBox="' + TELEGRAM_VIEWBOX + '"')
    .replace(/\\spreserveAspectRatio="[^"]*"/i, "");
  root = root.slice(0, -1) + ' preserveAspectRatio="xMidYMid meet">';
  const frame = [
    '<rect x="-101" y="0" width="1354" height="838" rx="22" fill="#061724" stroke="#16364A" stroke-width="1.2"/>',
    '<rect x="-88" y="16" width="1328" height="806" rx="16" fill="#0A1B29" stroke="#0F2D41" stroke-width="0.7"/>',
  ].join("");
  const withRoot = svg.replace(opening[0], root + frame);
  return withRoot.replace(/font-family="[^"]*"/gi, 'font-family="Inter, sans-serif"');
}

/** Render the full desktop-style report card, not a text-stripped chart-only thumbnail. */
export async function renderIstanbulPhotoPng(svg, fontBytes) {
  if (typeof svg !== "string" || !svg.includes("<svg")) {
    throw new Error("Cannot rasterize an invalid Istanbul GFS SVG report");
  }
  if (!isTrueTypeFont(fontBytes)) {
    throw new Error("A valid embedded font is required for Telegram report rendering");
  }

  let renderer;
  let rendered;
  try {
    const photoSvg = expandTelegramCanvas(svg);
    renderer = await Resvg.async(photoSvg, {
      fitTo: { mode: "width", value: TELEGRAM_IMAGE_WIDTH },
      background: "#061724",
      textRendering: 1,
      languages: ["tr", "en"],
      font: {
        fontBuffers: [fontBytes],
        defaultFontFamily: "Inter",
        sansSerifFamily: "Inter",
      },
    });
    rendered = renderer.render();
    const png = rendered.asPng();
    if (!(png instanceof Uint8Array) || png.length < 1024 ||
        png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
      throw new Error("Resvg did not produce a valid PNG image");
    }
    if (rendered.width !== TELEGRAM_IMAGE_WIDTH || rendered.height < 1240 || rendered.height > 1270) {
      throw new Error("Telegram report image has unexpected dimensions: " + rendered.width + "x" + rendered.height);
    }

    // Guard against the exact regression that stripped headings, legends and axes:
    // the upper title/legend band must contain a meaningful number of rendered
    // near-white glyph pixels before the PNG is accepted for delivery.
    const pixels = rendered.pixels;
    let brightHeaderPixels = 0;
    const left = Math.floor(rendered.width * 0.08);
    const right = Math.floor(rendered.width * 0.92);
    const top = Math.floor(rendered.height * 0.035);
    const bottom = Math.floor(rendered.height * 0.245);
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * rendered.width + x) * 4;
        if (pixels[offset + 3] > 180 &&
            pixels[offset] > 190 &&
            pixels[offset + 1] > 190 &&
            pixels[offset + 2] > 190) {
          brightHeaderPixels += 1;
        }
      }
    }
    if (brightHeaderPixels < 450) {
      throw new Error("Telegram PNG text layer is missing; refusing to send a chart without headings/legend");
    }
    return new Uint8Array(png);
  } finally {
    rendered?.free();
    renderer?.free();
  }
}
