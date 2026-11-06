"""Send the canonical Istanbul GFS notification bundle to Telegram.

This script does not fetch weather data or rebuild charts. It reads only the
already-published bundle under gfs/notifications and sends the exact report
text plus one photo rendered from the same SVG figure displayed on Pages.
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

    token = os.getenv("TELEGRAM_TOKEN", "").strip()
    chat_id = os.getenv("CHAT_ID", "").strip()
    if not token or not chat_id:
        raise RuntimeError("TELEGRAM_TOKEN or CHAT_ID secret is missing.")

    # The canonical publisher stores a single PNG rendered from the exact
    # same figure as the SVG shown on Pages. This is sent as one Telegram photo.
    composite_relative = item.get("image_path")
    composite_path = None
    if isinstance(composite_relative, str) and composite_relative.lower().endswith(".png"):
        candidate = root / "gfs" / "notifications" / composite_relative
        if not candidate.is_file():
            raise RuntimeError(f"Canonical Telegram comparison photo is missing: {candidate}")
        composite_path = candidate

    # Backward-compatible fallback for notification entries created before
    # the single SVG/PNG composition was introduced.
    legacy_paths = []
    if composite_path is None:
        for image in images:
            relative = image.get("path") if isinstance(image, dict) else image
            if not isinstance(relative, str) or not relative.lower().endswith(".png"):
                continue
            path = root / "gfs" / "notifications" / relative
            if not path.is_file():
                raise RuntimeError(f"Canonical report image is missing: {path}")
            legacy_paths.append(path)
        if not legacy_paths:
            raise RuntimeError("Canonical GFS report has no Telegram-compatible PNG image.")

    async def send() -> None:
        async with Bot(token=token) as bot:
            await bot.send_message(
                chat_id=chat_id,
                text=report,
                disable_web_page_preview=True,
            )
            if composite_path is not None:
                with composite_path.open("rb") as photo:
                    await bot.send_photo(
                        chat_id=chat_id,
                        photo=photo,
                        caption="📊 İstanbul GFS · dört panelli valid-time karşılaştırması",
                    )
                return

            if len(legacy_paths) == 1:
                with legacy_paths[0].open("rb") as photo:
                    await bot.send_photo(
                        chat_id=chat_id,
                        photo=photo,
                        caption="📊 İstanbul GFS · 4'lü döngü karşılaştırması",
                    )
                return

            media = []
            handles = []
            try:
                for index, path in enumerate(legacy_paths):
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
    print(f"[TELEGRAM CANONICAL] run={run_id}; report=1; composite_photo={1 if composite_path is not None else len(legacy_paths)}; marker=written")


if __name__ == "__main__":
    main()
