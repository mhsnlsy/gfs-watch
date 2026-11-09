#!/usr/bin/env python3
"""Send the daily Istanbul tomorrow-weather summary to Telegram."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from telegram import Bot


async def main() -> None:
    token = os.getenv("TELEGRAM_TOKEN", "").strip()
    chat_id = os.getenv("CHAT_ID", "").strip()
    if not token or not chat_id:
        raise RuntimeError("TELEGRAM_TOKEN or CHAT_ID secret is missing.")

    feed_path = Path(os.getenv("TOMORROW_NOTIFICATION_FEED", "tmp/tomorrow-weather-notification.json"))
    if not feed_path.is_file():
        raise RuntimeError(f"Tomorrow weather feed missing: {feed_path}")

    feed = json.loads(feed_path.read_text(encoding="utf-8"))
    item = (feed.get("items") or [None])[0]
    if not isinstance(item, dict):
        raise RuntimeError("Tomorrow weather feed has no notification item.")

    title = str(item.get("title") or "İstanbul · Yarın hava nasıl?")
    summary = str(item.get("summary") or "").strip()
    if not summary:
        raise RuntimeError("Tomorrow weather notification is empty.")

    text = f"🌤️ {title}\n\n{summary}"

    async with Bot(token=token) as bot:
        message = await bot.send_message(
            chat_id=chat_id,
            text=text,
            disable_web_page_preview=True,
        )

    print(json.dumps({
        "ok": True,
        "telegram_message_id": message.message_id,
        "title": title,
        "summary": summary,
        "run_id_utc": feed.get("metadata", {}).get("run_id_utc"),
    }, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
