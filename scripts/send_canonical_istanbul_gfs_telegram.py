"""Send the canonical Istanbul GFS notification bundle to Telegram.

This script does not fetch weather data or rebuild charts. It reads only the
already-published bundle under gfs/notifications and sends the exact report
text plus the four PNGs generated from that same MeteoPT cycle.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from telegram import Bot


def main() -> None:
    root = Path.cwd()
    manifest_path = root / "gfs" / "notifications" / "latest.json"
    if not manifest_path.is_file():
        raise RuntimeError("Canonical GFS notification manifest is missing.")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    items = manifest.get("items") or []
    if not items:
        raise RuntimeError("Canonical GFS notification manifest has no report.")

    item = items[0]
    run_id = item.get("run_id_utc")
    report = (item.get("report_text") or "").strip()
    images = item.get("images") or []
    if not run_id or not report:
        raise RuntimeError("Canonical GFS report is incomplete.")
    if len(images) != 4:
        raise RuntimeError(f"Canonical GFS report must contain 4 PNGs; found {len(images)}.")

    token = os.getenv("TELEGRAM_TOKEN", "").strip()
    chat_id = os.getenv("CHAT_ID", "").strip()
    if not token or not chat_id:
        raise RuntimeError("TELEGRAM_TOKEN or CHAT_ID secret is missing.")

    paths = []
    for image in images:
        relative = image.get("path") if isinstance(image, dict) else image
        if not isinstance(relative, str) or not relative.lower().endswith(".png"):
            raise RuntimeError("Canonical report contains a non-PNG image path.")
        path = root / "gfs" / "notifications" / relative
        if not path.is_file():
            raise RuntimeError(f"Canonical report image is missing: {path}")
        paths.append(path)

    async def send() -> None:
        async with Bot(token=token) as bot:
            await bot.send_message(
                chat_id=chat_id,
                text=report,
                disable_web_page_preview=True,
            )
            for path in paths:
                with path.open("rb") as photo:
                    await bot.send_photo(chat_id=chat_id, photo=photo)

    asyncio.run(send())
    print(f"[TELEGRAM CANONICAL] run={run_id}; report=1; pngs={len(paths)}")


if __name__ == "__main__":
    main()
