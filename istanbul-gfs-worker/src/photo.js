import { Resvg } from "@cf-wasm/resvg";

const TELEGRAM_IMAGE_WIDTH = 2048;
const TELEGRAM_IMAGE_HEIGHT = 1490;
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
        // Cache miss or temporary R2 failure: fetch the font once and refill cache.
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

/**
 * Rasterize the exact same 1152x838 SVG used by the homepage:
 * same viewBox, title band, two-column/two-row chart grid, axes, legends and footer.
 * Only the raster output resolution and font source differ.
 */
export async function renderIstanbulPhotoPng(svg, fontBytes) {
  if (typeof svg !== "string" || !svg.includes("<svg")) {
    throw new Error("Cannot rasterize an invalid Istanbul GFS SVG report");
  }
  if (!isTrueTypeFont(fontBytes)) {
    throw new Error("A valid embedded font is required for Telegram report rendering");
  }

  const opening = svg.match(/<svg\b[^>]*>/i);
  if (!opening || !/viewBox="0 0 1152 838"/i.test(opening[0])) {
    throw new Error("Telegram report must use the homepage four-panel SVG viewBox (0 0 1152 838)");
  }
  for (const required of [
    "Son GFS raporu",
    "Sıcaklık",
    "850 hPa sıcaklık",
    "Yağış",
    "10 m rüzgâr hızı",
    "MeteoPT GFS",
  ]) {
    if (!svg.includes(required)) {
      throw new Error("Telegram report SVG is missing homepage content: " + required);
    }
  }

  // Keep the SVG's entire original composition. Explicitly load Inter because
  // Cloudflare Workers do not provide the same system fonts as a desktop browser.
  const photoSvg = svg.replace(/font-family="[^"]*"/gi, 'font-family="Inter, sans-serif"');

  let renderer;
  let rendered;
  try {
    renderer = await Resvg.async(photoSvg, {
      fitTo: { mode: "width", value: TELEGRAM_IMAGE_WIDTH },
      background: "#0a1b29",
      textRendering: 1,
      languages: ["tr", "en"],
      font: {
        fontBuffers: [fontBytes],
        defaultFontFamily: "Inter",
        sansSerifFamily: "Inter",
        loadSystemFonts: false,
      },
    });
    rendered = renderer.render();

    if (rendered.width !== TELEGRAM_IMAGE_WIDTH || rendered.height !== TELEGRAM_IMAGE_HEIGHT) {
      throw new Error("Telegram image dimensions differ from the homepage 2x2 layout: " +
        rendered.width + "x" + rendered.height);
    }

    const pixels = rendered.pixels;
    let brightHeaderPixels = 0;
    const left = Math.floor(rendered.width * 0.08);
    const right = Math.floor(rendered.width * 0.94);
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
      throw new Error("Telegram PNG is missing rendered header/legend text; refusing chart-only delivery");
    }

    const png = rendered.asPng();
    if (!(png instanceof Uint8Array) || png.length < 1024 ||
        png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
      throw new Error("Resvg did not produce a valid PNG image");
    }
    return new Uint8Array(png);
  } finally {
    rendered?.free();
    renderer?.free();
  }
}
