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
from datetime import datetime, timezone

from telegram import Bot
from telegram import InputMediaPhoto


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

    marker_dir = root / "gfs" / "notifications" / "telegram-sent"
    marker_path = marker_dir / f"{run_id}.json"
    if marker_path.is_file():
        print(f"[TELEGRAM CANONICAL] run={run_id} already sent; skipping duplicate.")
        return
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
            media = []
            handles = []
            try:
                for index, path in enumerate(paths):
                    handle = path.open("rb")
                    handles.append(handle)
                    media.append(
                        InputMediaPhoto(
                            media=handle,
                            caption=(
                                "📊 İstanbul GFS · 4'lü döngü karşılaştırması"
                                if index == 0 else None
                            ),
                        )
                    )
                await bot.send_media_group(chat_id=chat_id, media=media)
            finally:
                for handle in handles:
                    handle.close()

    asyncio.run(send())

    marker_dir.mkdir(parents=True, exist_ok=True)
    marker_path.write_text(
        json.dumps({
            "run_id_utc": run_id,
            "sent_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "status": "sent",
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"[TELEGRAM CANONICAL] run={run_id}; report=1; pngs={len(paths)}; marker=written")


if __name__ == "__main__":
    main()
