"""Refresh the latest Pages report charts with the new 850 hPa wind field.

The historical notification text/audio is preserved. This job does not send
a Telegram message; it only rebuilds the current Pages forecast and its four
separate, slightly wider chart images for better mobile axis-label readability
from the corresponding NOAA GFS cycle.
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as archive


def main() -> None:
    latest_path = Path(archive.PUBLIC_DATA_DIR) / "latest.json"
    manifest_path = Path(archive.PUBLIC_DATA_DIR) / "notifications" / "latest.json"
    if not latest_path.is_file() or not manifest_path.is_file():
        raise RuntimeError("Latest forecast or notification manifest is missing.")

    latest = json.loads(latest_path.read_text(encoding="utf-8"))
    target_run_id = os.environ.get("TARGET_RUN_ID", "").strip() or latest.get("run_id_utc")
    if not target_run_id:
        raise RuntimeError("No latest GFS run ID is available.")
    target_run_id = archive._parse_utc_datetime(target_run_id).isoformat(timespec="seconds")
    published_run_id = archive._parse_utc_datetime(latest.get("run_id_utc")).isoformat(timespec="seconds")
    if published_run_id != target_run_id:
        raise RuntimeError(
            "Safety check: target must match public/latest.json. "
            f"Expected {published_run_id}, received {target_run_id}."
        )

    run_dt = archive._parse_utc_datetime(target_run_id)
    run_key = run_dt.strftime("%Y%m%dT%HZ")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    item = next(
        (entry for entry in manifest.get("items", []) if entry.get("run_id_utc") == target_run_id),
        None,
    )
    if item is None:
        raise RuntimeError(f"Notification entry for {target_run_id} was not found.")

    print(
        f"[PAGES BACKFILL] Rebuilding {run_key} from NOAA GFS to add 850 hPa wind."
    )
    payload = archive.fetch_full_weather_data(target_run_id)
    if not payload or "_pending_noaa_gfs" in payload:
        raise RuntimeError(
            "NOAA forecast could not be rebuilt: "
            f"{(payload or {}).get('_reason', 'no data returned')}"
        )

    payload["station_observation"] = latest.get("station_observation")
    noaa = latest.get("noaa_source_file", {})
    payload["model_metadata"] = {
        "noaa_f180_available": noaa.get("f180_available", True),
        "last_modified_time": noaa.get("f180_last_modified_utc"),
        "source_name": noaa.get("f180_source_name"),
        "source_url": noaa.get("f180_source_url"),
        "source_object_size_bytes": noaa.get("global_grib2_size_bytes"),
    }

    wind_850 = payload.get("daily", {}).get("wind_850_max", [])
    if not archive._has_complete_850_wind_daily_series(payload):
        raise RuntimeError(
            "Current NOAA run has an incomplete 850 hPa daily wind series; "
            "the Pages comparison will not publish a partial chart."
        )
    print(
        f"[PAGES BACKFILL] Current cycle has {len(wind_850)} complete daily "
        "850 hPa wind values."
    )

    archive.export_public_forecast_json(target_run_id, payload)
    previous_runs = asyncio.run(
        archive.load_previous_three_runs_for_comparison(target_run_id)
    )
    if len(previous_runs) != 3:
        raise RuntimeError(f"Expected three earlier GFS cycles, found {len(previous_runs)}.")

    charts = archive.create_pages_comparison_charts(target_run_id, payload, previous_runs)
    expected_metrics = {"temperature", "precipitation", "wind_10m", "wind_850"}
    if set(charts) != expected_metrics:
        for buffer in charts.values():
            buffer.close()
        raise RuntimeError(f"Expected four Pages images; generated {sorted(charts)}.")

    try:
        images = archive.save_public_notification_images(target_run_id, charts)
    finally:
        for buffer in charts.values():
            buffer.close()
    if len(images) != 4:
        raise RuntimeError(f"Expected four archived Pages images, saved {len(images)}.")

    item["images"] = images
    item["image_path"] = None
    manifest["updated_at_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    archive._write_json_atomically(str(manifest_path), manifest)

    print(
        "[PAGES BACKFILL COMPLETE] "
        f"run={target_run_id}; images={len(images)}; "
        f"850 hPa daily samples={len(wind_850)}; Telegram was not sent."
    )


if __name__ == "__main__":
    main()
