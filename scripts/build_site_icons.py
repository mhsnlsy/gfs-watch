#!/usr/bin/env python3
"""Build browser, Apple and PWA icons from the single approved brand image."""
from __future__ import annotations

import argparse
import base64
from io import BytesIO
from pathlib import Path

from PIL import Image

VERSION = "20261108-city-icon-3"
SIZES = (16, 32, 48, 64, 96, 128, 144, 152, 167, 180, 192, 256, 384, 512)
DARK = (7, 21, 33, 255)
MASKABLE_BG = (0, 137, 222, 255)
PART_GLOB = "istanbul-havasi-icon-*.b64"


def load_source(source: Path) -> Image.Image:
    if source.is_dir():
        parts = sorted(source.glob(PART_GLOB))
        if len(parts) != 4:
            raise SystemExit(f"Expected 4 base64 source parts in {source}, found {len(parts)}")
        encoded = "".join(part.read_text(encoding="ascii").strip() for part in parts)
        raw = base64.b64decode(encoded, validate=True)
    else:
        raw = source.read_bytes()

    with Image.open(BytesIO(raw)) as opened:
        opened.load()
        logo = opened.convert("RGBA")

    if logo.width != logo.height:
        raise SystemExit(f"Brand icon must be square, got {logo.size}")
    if logo.width < 256:
        raise SystemExit(f"Brand source is too small for PWA output: {logo.size}")
    return logo


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="source WebP/PNG file or folder of 4 base64 parts")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    if not args.source.exists():
        raise SystemExit(f"Brand source not found: {args.source}")
    args.output.mkdir(parents=True, exist_ok=True)
    logo = load_source(args.source)
    resampling = Image.Resampling.LANCZOS

    for size in SIZES:
        logo.resize((size, size), resampling).save(
            args.output / f"favicon-{size}x{size}.png", format="PNG", optimize=True
        )

    logo.save(
        args.output / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    # Apple touch icons are opaque: composite transparent rounded corners on navy.
    apple = Image.new("RGBA", (180, 180), DARK)
    apple.alpha_composite(logo.resize((180, 180), resampling))
    apple.convert("RGB").save(
        args.output / "apple-touch-icon.png", format="PNG", optimize=True
    )

    # Place the artwork inside Android's maskable safe zone.
    maskable = Image.new("RGBA", (512, 512), MASKABLE_BG)
    safe_size = 368
    safe_logo = logo.resize((safe_size, safe_size), resampling)
    maskable.alpha_composite(safe_logo, ((512 - safe_size) // 2, (512 - safe_size) // 2))
    maskable.save(args.output / "icon-maskable-512.png", format="PNG", optimize=True)

    tile = Image.new("RGBA", (150, 150), DARK)
    tile.alpha_composite(logo.resize((150, 150), resampling))
    tile.convert("RGB").save(
        args.output / "mstile-150x150.png", format="PNG", optimize=True
    )

    # Embed the PNG inside the SVG so browser favicon loading has no external dependency.
    png512 = (args.output / "favicon-512x512.png").read_bytes()
    embedded_png = base64.b64encode(png512).decode("ascii")
    svg = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">'
        f'<image href="data:image/png;base64,{embedded_png}" width="512" height="512"/>'
        '</svg>\n'
    )
    (args.output / "favicon.svg").write_text(svg, encoding="utf-8")

    browserconfig = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<browserconfig><msapplication><tile>'
        f'<square150x150logo src="/mstile-150x150.png?v={VERSION}"/>'
        '<TileColor>#071521</TileColor>'
        '</tile></msapplication></browserconfig>\n'
    )
    (args.output / "browserconfig.xml").write_text(browserconfig, encoding="utf-8")
    print(
        f"Built {len(SIZES)} PNG sizes, multi-resolution ICO, self-contained SVG, "
        f"Apple Touch, maskable PWA and Windows tile from {logo.size}"
    )


if __name__ == "__main__":
    main()
