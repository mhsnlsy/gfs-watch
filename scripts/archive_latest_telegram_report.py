"""Recreate the most recent Telegram GFS media and publish it to Pages.

This is a one-off archival operation. It reads the saved SQLite run history,
does not send anything to Telegram, and only writes public/notifications/.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as archive  # noqa: E402


def load_legacy_module():
    legacy_path = os.environ.get("LEGACY_MAIN_PATH")
    if not legacy_path:
        raise RuntimeError("LEGACY_MAIN_PATH is required")
    spec = importlib.util.spec_from_file_location("legacy_gfs_main", legacy_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load historical GFS source")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    target_run_id = os.environ.get("TARGET_RUN_ID", "2026-10-31T12:00:00+00:00")
    latest_path = Path(archive.PUBLIC_DATA_DIR) / "latest.json"
    if not latest_path.is_file():
        raise RuntimeError(f"Missing published forecast: {latest_path}")

    latest = json.loads(latest_path.read_text(encoding="utf-8"))
    published_run_id = latest.get("run_id_utc")
    if published_run_id != target_run_id:
        raise RuntimeError(
            "Safety check: requested Telegram report does not match latest.json. "
            f"Expected {target_run_id}, found {published_run_id}."
        )

    legacy = load_legacy_module()
    record = legacy.get_run_payload(target_run_id)
    if not record:
        raise RuntimeError(f"Saved SQLite forecast not found for {target_run_id}")
    stored_run_id, payload = record

    previous_runs = asyncio.run(
        legacy.load_previous_three_runs_for_comparison(stored_run_id)
    )
    if len(previous_runs) != 3:
        raise RuntimeError(
            f"Expected three earlier GFS cycles, found {len(previous_runs)}"
        )

    print(
        "[ARCHIVE] Rebuilding the Telegram report from saved run "
        f"{stored_run_id} and the three preceding cycles."
    )
    full_text_report, speech_text = legacy.analyze_and_build_output(
        stored_run_id, payload, previous_runs
    )

    chart = legacy.create_comparison_chart(
        stored_run_id, payload, previous_runs
    )
    if chart is None:
        raise RuntimeError("Historical four-cycle comparison image could not be rebuilt")

    audio_file = None
    try:
        image_path = archive.save_public_notification_image(stored_run_id, chart)
        if not image_path:
            raise RuntimeError("Comparison image could not be saved")

        # Use the exact historical TTS implementation that sent this report
        # to Telegram (Turkish WaveNet C, 1.2x).
        audio_file = asyncio.run(
            legacy.generate_speech_with_retry(speech_text)
        )
        if not audio_file or not Path(audio_file).is_file():
            raise RuntimeError("Historical Telegram voice report could not be regenerated")

        archive.publish_public_notification(
            stored_run_id,
            full_text_report,
            speech_text,
            image_path,
            audio_file,
        )

        manifest_path = Path(archive.PUBLIC_DATA_DIR) / "notifications" / "latest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        item = next(
            entry for entry in manifest.get("items", [])
            if entry.get("id") == Path(image_path).stem.replace(
                "gfs-", ""
            ).replace("-comparison", "")
        )
        print(
            "[ARCHIVE COMPLETE] "
            f"image={item.get('image_path')} "
            f"audio={item.get('audio_path')} "
            f"items={len(manifest.get('items', []))}"
        )
    finally:
        chart.close()
        if audio_file and Path(audio_file).is_file():
            Path(audio_file).unlink()


if __name__ == "__main__":
    main()
