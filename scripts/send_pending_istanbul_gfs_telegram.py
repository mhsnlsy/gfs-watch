"""Deliver all unsent Istanbul GFS reports from the canonical Pages manifest.

Telegram delivery is deliberately outside the GFS publication job. A Telegram
failure can therefore never block the Pages deployment. Each run is marked
only after both text and image are accepted by Telegram.
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from telegram import Bot


def main() -> None:
    root = Path.cwd()
    manifest_path = root / "gfs" / "notifications" / "latest.json"
    if not manifest_path.is_file():
        print("[GFS TELEGRAM] No notification manifest yet.")
        return

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    items = manifest.get("items") or []
    if not items:
        print("[GFS TELEGRAM] Manifest has no reports.")
        return

    token = os.getenv("TELEGRAM_TOKEN", "").strip()
    chat_id = os.getenv("CHAT_ID", "").strip()
    if not token or not chat_id:
        raise RuntimeError("TELEGRAM_TOKEN or CHAT_ID secret is missing.")

    marker_dir = root / "gfs" / "notifications" / "telegram-sent"
    marker_dir.mkdir(parents=True, exist_ok=True)

    pending = []
    for item in items:
        run_id = item.get("run_id_utc")
        report = (item.get("report_text") or "").strip()
        if not run_id or not report:
            continue
        marker = marker_dir / f"{run_id}.json"
        if marker.exists():
            continue

        image_relative = item.get("image_path")
        image = None
        if isinstance(image_relative, str) and image_relative.lower().endswith(".png"):
            candidate = root / "gfs" / "notifications" / image_relative
            if candidate.is_file():
                image = candidate

        if image is None:
            for entry in item.get("images") or []:
                relative = entry.get("path") if isinstance(entry, dict) else entry
                if isinstance(relative, str) and relative.lower().endswith(".png"):
                    candidate = root / "gfs" / "notifications" / relative
                    if candidate.is_file():
                        image = candidate
                        break

        if image is None:
            print(f"::warning::Telegram image missing for {run_id}; retrying later.")
            continue

        pending.append((run_id, report, image, marker))

    if not pending:
        print("[GFS TELEGRAM] No pending reports.")
        return

    async def deliver() -> None:
        async with Bot(token=token) as bot:
            for run_id, report, image, marker in pending:
                await bot.send_message(
                    chat_id=chat_id,
                    text=report,
                    disable_web_page_preview=True,
                )
                with image.open("rb") as photo:
                    await bot.send_photo(
                        chat_id=chat_id,
                        photo=photo,
                        caption="📊 İstanbul GFS · dört panelli valid-time karşılaştırması",
                    )
                marker.write_text(
                    json.dumps({
                        "run_id_utc": run_id,
                        "sent_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "status": "sent",
                    }, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                print(f"[GFS TELEGRAM] delivered {run_id}")

    asyncio.run(deliver())


if __name__ == "__main__":
    main()
