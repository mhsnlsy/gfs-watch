import { Resvg } from "@cf-wasm/resvg";

/** Convert the website SVG report into a raster PNG suitable for Telegram sendPhoto. */
export async function renderIstanbulPhotoPng(svg) {
  if (typeof svg !== "string" || !svg.includes("<svg")) {
    throw new Error("Cannot rasterize an invalid Istanbul GFS SVG report");
  }
  let renderer;
  let rendered;
  try {
    renderer = await Resvg.async(svg);
    rendered = renderer.render();
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
