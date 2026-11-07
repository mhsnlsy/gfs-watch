"""Deliver unsent Istanbul GFS reports from the canonical publication manifest.

The --check mode uses only the Python standard library and exposes a pending
GitHub Actions output. The Telegram dependency is imported only when at least
one complete report actually needs delivery.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def set_output(name: str, value: str) -> None:
    target = os.getenv("GITHUB_OUTPUT")
    if target:
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def pending_reports(root: Path) -> list[tuple[str, str, Path, Path, dict]]:
    manifest_path = root / "gfs" / "notifications" / "latest.json"
    if not manifest_path.is_file():
        print("[GFS TELEGRAM] No notification manifest yet.")
        return []

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as exc:
        raise RuntimeError(f"Invalid GFS notification manifest: {exc}") from exc

    items = manifest.get("items") if isinstance(manifest, dict) else []
    if not isinstance(items, list) or not items:
        print("[GFS TELEGRAM] Manifest has no reports.")
        return []

    marker_dir = root / "gfs" / "notifications" / "telegram-sent"
    marker_dir.mkdir(parents=True, exist_ok=True)
    pending = []

    for item in items:
        if not isinstance(item, dict):
            continue
        run_id = item.get("run_id_utc")
        report = (item.get("report_text") or "").strip()
        if not run_id or not report:
            continue

        marker = marker_dir / f"{run_id}.json"
        marker_state = {}
        if marker.exists():
            try:
                loaded = json.loads(marker.read_text(encoding="utf-8"))
                marker_state = loaded if isinstance(loaded, dict) else {}
            except (OSError, ValueError, TypeError):
                marker_state = {}
            # Only an explicit partial delivery is resumable. Legacy markers
            # without a status are historical acknowledgements.
            if marker_state.get("status") != "partial":
                continue

        image = None
        image_relative = item.get("image_path")
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

        pending.append((str(run_id), report, image, marker, marker_state))

    return pending


def main() -> None:
    root = Path.cwd()
    check_only = "--check" in sys.argv[1:]
    pending = pending_reports(root)

    if check_only:
        set_output("pending", "true" if pending else "false")
        set_output("pending_count", str(len(pending)))
        print(f"[GFS TELEGRAM CHECK] pending_reports={len(pending)}")
        return

    if not pending:
        print("[GFS TELEGRAM] No pending reports.")
        return

    token = os.getenv("TELEGRAM_TOKEN", "").strip()
    chat_id = os.getenv("CHAT_ID", "").strip()
    if not token or not chat_id:
        raise RuntimeError("TELEGRAM_TOKEN or CHAT_ID secret is missing.")

    async def deliver() -> None:
        from telegram import Bot

        async with Bot(token=token) as bot:
            for run_id, report, image, marker, state in pending:
                state.setdefault("run_id_utc", run_id)
                if not state.get("text_message_id"):
                    sent_text = await bot.send_message(
                        chat_id=chat_id,
                        text=report,
                        disable_web_page_preview=True,
                    )
                    state["text_message_id"] = sent_text.message_id
                    state["status"] = "partial"
                    state["updated_at_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                    temporary = marker.with_suffix(".json.tmp")
                    temporary.write_text(
                        json.dumps(state, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8",
                    )
                    temporary.replace(marker)

                if not state.get("photo_message_id"):
                    with image.open("rb") as photo:
                        sent_photo = await bot.send_photo(
                            chat_id=chat_id,
                            photo=photo,
                            caption="📊 İstanbul GFS · dört panelli valid-time karşılaştırması",
                        )
                    state["photo_message_id"] = sent_photo.message_id

                state["status"] = "sent"
                state["sent_at_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                temporary = marker.with_suffix(".json.tmp")
                temporary.write_text(
                    json.dumps(state, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                temporary.replace(marker)
                print(f"[GFS TELEGRAM] delivered {run_id}")

    asyncio.run(deliver())


if __name__ == "__main__":
    main()
