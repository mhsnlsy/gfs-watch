"""Deliver pending canonical Istanbul GFS notifications from a durable outbox.

The Pages publication is independent from Telegram delivery. Text and photo
acknowledgements are stored separately so transient photo errors do not resend
a report that Telegram has already accepted.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from telegram import Bot, InputMediaPhoto


def write_json_atomic(path: Path, document: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def run_key(run_id: str) -> str:
    parsed = datetime.fromisoformat(run_id.replace("Z", "+00:00"))
    return parsed.astimezone(timezone.utc).strftime("%Y%m%dT%HZ")


def marker_for(root: Path, run_id: str) -> Path:
    return root / "gfs" / "notifications" / "telegram-sent" / f"{run_id}.json"


def seed_outbox_from_pages_manifest(root: Path, outbox_dir: Path) -> None:
    """Migrate report entries created before the durable outbox existed."""
    manifest_path = root / "gfs" / "notifications" / "latest.json"
    if not manifest_path.is_file():
        return

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as exc:
        raise RuntimeError(f"Cannot read Pages notification manifest: {exc}") from exc

    for item in manifest.get("items") or []:
        run_id = item.get("run_id_utc")
        if not run_id:
            continue

        marker_path = marker_for(root, run_id)
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8")) if marker_path.is_file() else {}
        except (OSError, ValueError, TypeError):
            marker = {}
        if marker.get("status") == "sent":
            continue

        destination = outbox_dir / f"{run_key(run_id)}.json"
        if destination.is_file():
            continue

        queued = dict(item)
        media_dir = outbox_dir / "media"
        media_dir.mkdir(parents=True, exist_ok=True)

        relative = queued.get("image_path")
        if isinstance(relative, str) and relative.lower().endswith(".png"):
            source = root / "gfs" / "notifications" / relative
            if source.is_file():
                filename = f"gfs-{run_key(run_id)}-comparison.png"
                shutil.copy2(source, media_dir / filename)
                queued["image_path"] = f"media/{filename}"
                queued["image_path_scope"] = "outbox"

        if not queued.get("image_path_scope"):
            migrated_images = []
            for image in queued.get("images") or []:
                if not isinstance(image, dict):
                    continue
                path_value = image.get("path")
                if not isinstance(path_value, str) or not path_value.lower().endswith(".png"):
                    continue
                source = root / "gfs" / "notifications" / path_value
                if not source.is_file():
                    continue
                filename = Path(path_value).name
                shutil.copy2(source, media_dir / filename)
                migrated_images.append({**image, "path": f"media/{filename}"})
            if migrated_images:
                queued["images"] = migrated_images
                queued["image_path_scope"] = "outbox"

        write_json_atomic(destination, queued)
        print(f"[TELEGRAM OUTBOX] migrated undelivered report {run_id}")


def resolve_photos(root: Path, outbox_dir: Path, item: dict) -> list[Path]:
    base = outbox_dir if item.get("image_path_scope") == "outbox" else root / "gfs" / "notifications"
    relative = item.get("image_path")

    if isinstance(relative, str) and relative.lower().endswith(".png"):
        candidate = base / relative
        if candidate.is_file():
            return [candidate]

    photos = []
    for image in item.get("images") or []:
        relative = image.get("path") if isinstance(image, dict) else image
        if not isinstance(relative, str) or not relative.lower().endswith(".png"):
            continue
        candidate = base / relative
        if not candidate.is_file():
            raise RuntimeError(f"Telegram image is missing: {candidate}")
        photos.append(candidate)
    return photos


async def send_pending(root: Path, outbox_dir: Path, token: str, chat_id: str) -> int:
    marker_dir = root / "gfs" / "notifications" / "telegram-sent"
    marker_dir.mkdir(parents=True, exist_ok=True)
    queue = sorted(outbox_dir.glob("*.json"), key=lambda path: path.name)
    failures = []
    processed = 0

    async with Bot(token=token) as bot:
        for queued_file in queue:
            run_id = None
            marker_path = None
            marker = {}
            message_sent = False
            photo_sent = False
            try:
                item = json.loads(queued_file.read_text(encoding="utf-8"))
                run_id = item.get("run_id_utc")
                report = (item.get("report_text") or "").strip()
                if not run_id or not report:
                    raise RuntimeError(f"Incomplete Telegram outbox item: {queued_file.name}")

                marker_path = marker_for(root, run_id)
                if marker_path.is_file():
                    try:
                        marker = json.loads(marker_path.read_text(encoding="utf-8"))
                    except (OSError, ValueError, TypeError):
                        marker = {}

                if marker.get("status") == "sent":
                    queued_file.unlink(missing_ok=True)
                    processed += 1
                    continue

                message_sent = bool(marker.get("message_sent"))
                photo_sent = bool(marker.get("photo_sent"))
                photos = resolve_photos(root, outbox_dir, item)
                if not photos:
                    raise RuntimeError(f"No Telegram-compatible PNG found for {run_id}")

                if not message_sent:
                    await bot.send_message(
                        chat_id=chat_id,
                        text=report,
                        disable_web_page_preview=True,
                    )
                    message_sent = True
                    marker = {
                        "run_id_utc": run_id,
                        "updated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "status": "partial",
                        "message_sent": True,
                        "photo_sent": False,
                    }
                    write_json_atomic(marker_path, marker)

                if not photo_sent:
                    if len(photos) == 1:
                        with photos[0].open("rb") as photo:
                            await bot.send_photo(
                                chat_id=chat_id,
                                photo=photo,
                                caption="📊 İstanbul GFS · dört panelli valid-time karşılaştırması",
                            )
                    else:
                        media = []
                        handles = []
                        try:
                            for index, photo_path in enumerate(photos):
                                handle = photo_path.open("rb")
                                handles.append(handle)
                                media.append(InputMediaPhoto(
                                    media=handle,
                                    caption=(
                                        "📊 İstanbul GFS · 4'lü döngü karşılaştırması"
                                        if index == 0 else None
                                    ),
                                ))
                            await bot.send_media_group(chat_id=chat_id, media=media)
                        finally:
                            for handle in handles:
                                handle.close()
                    photo_sent = True

                write_json_atomic(marker_path, {
                    "run_id_utc": run_id,
                    "sent_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "status": "sent",
                    "message_sent": message_sent,
                    "photo_sent": photo_sent,
                })

                for photo_path in photos:
                    try:
                        photo_path.relative_to(outbox_dir)
                        photo_path.unlink(missing_ok=True)
                    except ValueError:
                        pass
                queued_file.unlink(missing_ok=True)
                processed += 1
                print(f"[TELEGRAM SENT] run={run_id}; report=1; photos={len(photos)}; marker=sent")

            except Exception as exc:
                failures.append(f"{queued_file.name}: {exc}")
                print(f"[TELEGRAM RETRY QUEUED] {queued_file.name}: {exc}")
                if run_id:
                    marker.update({
                        "run_id_utc": run_id,
                        "updated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "status": "pending",
                        "message_sent": message_sent,
                        "photo_sent": photo_sent,
                        "last_error": str(exc)[:500],
                    })
                    write_json_atomic(marker_path or marker_for(root, run_id), marker)

    if failures:
        raise RuntimeError("Telegram outbox has pending failures: " + " | ".join(failures))
    return processed


def main() -> None:
    root = Path.cwd()
    outbox_dir = root / "gfs" / "telegram-outbox"
    outbox_dir.mkdir(parents=True, exist_ok=True)
    seed_outbox_from_pages_manifest(root, outbox_dir)

    pending = list(outbox_dir.glob("*.json"))
    if not pending:
        print("[TELEGRAM OUTBOX] no pending reports.")
        return

    token = os.getenv("TELEGRAM_TOKEN", "").strip()
    chat_id = os.getenv("CHAT_ID", "").strip()
    if not token or not chat_id:
        raise RuntimeError("TELEGRAM_TOKEN or CHAT_ID secret is missing.")

    count = asyncio.run(send_pending(root, outbox_dir, token, chat_id))
    print(f"[TELEGRAM OUTBOX COMPLETE] processed={count}")


if __name__ == "__main__":
    main()
