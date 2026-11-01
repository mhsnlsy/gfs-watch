"""Re-render the latest Pages comparison charts from the saved SQLite forecasts only.

This is a presentation-only operation: it never contacts NOAA, changes forecast JSON,
or touches Telegram text/audio. It updates only the four chart PNGs and their manifest.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as archive


def main() -> None:
    public_dir = Path(archive.PUBLIC_DATA_DIR)
    manifest_path = public_dir / "notifications" / "latest.json"
    if not manifest_path.is_file():
        raise RuntimeError("Latest notification manifest is missing.")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    latest = next((item for item in manifest.get("items", []) if item.get("run_id_utc")), None)
    if latest is None:
        raise RuntimeError("No latest report entry was found.")

    current_run_id = archive._parse_utc_datetime(latest["run_id_utc"]).isoformat(timespec="seconds")
    current_record = archive.get_run_payload(current_run_id)
    if not current_record:
        raise RuntimeError(f"Saved SQLite forecast missing for current run {current_run_id}.")
    _, current_payload = current_record

    previous_runs = []
    for hours_back in (6, 12, 18):
        previous_id = (
            archive._parse_utc_datetime(current_run_id)
            - archive.timedelta(hours=hours_back)
        ).isoformat(timespec="seconds")
        record = archive.get_run_payload(previous_id)
        if not record:
            raise RuntimeError(
                f"Saved SQLite forecast missing for {previous_id}; refusing to fetch NOAA."
            )
        stored_id, payload = record
        if not archive._has_complete_850_wind_daily_series(payload):
            raise RuntimeError(
                f"Saved forecast {stored_id} lacks a complete 850 hPa series; "
                "refusing to fetch NOAA or publish incomplete comparisons."
            )
        previous_runs.append((stored_id, json.dumps(payload, ensure_ascii=False)))

    if not archive._has_complete_850_wind_daily_series(current_payload):
        raise RuntimeError(
            "Current saved forecast lacks a complete 850 hPa series; refusing to fetch NOAA."
        )

    print(
        f"[STYLE-ONLY RENDER] Using saved SQLite data for {current_run_id}; "
        "NOAA network access is not used."
    )
    charts = archive.create_pages_comparison_charts(
        current_run_id, current_payload, previous_runs
    )
    expected = {"temperature", "precipitation", "wind_10m", "wind_850"}
    if set(charts) != expected:
        for buffer in charts.values():
            buffer.close()
        raise RuntimeError(f"Expected four charts; got {sorted(charts)}.")

    try:
        images = archive.save_public_notification_images(current_run_id, charts)
    finally:
        for buffer in charts.values():
            buffer.close()
    if len(images) != 4:
        raise RuntimeError(f"Expected four images to be saved; got {len(images)}.")

    latest["images"] = images
    latest["image_path"] = None
    manifest["updated_at_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    archive._write_json_atomically(str(manifest_path), manifest)
    print(
        "[STYLE-ONLY RENDER COMPLETE] Four Pages PNGs regenerated from saved forecasts. "
        "Forecast data, latest.json, Telegram text/audio, and NOAA cache untouched."
    )


if __name__ == "__main__":
    main()
