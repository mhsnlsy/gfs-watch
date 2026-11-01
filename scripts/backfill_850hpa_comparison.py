"""Targeted NOAA backfill for the four GFS cycles used by the Pages comparison.

Downloads the historical cycle inputs once, stores decoded Istanbul fields in
noaa_cache_v2, updates the existing SQLite records, and rebuilds only the
four public comparison charts. It does not run Telegram or the general watch.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as archive


def main() -> None:
    run_ids = [
        item.strip()
        for item in os.environ.get("GFS_WATCH_BACKFILL_RUN_IDS", "").split(",")
        if item.strip()
    ]
    if len(run_ids) != 4:
        raise RuntimeError(f"Exactly four target run IDs are required; got {len(run_ids)}.")

    public_dir = Path(archive.PUBLIC_DATA_DIR)
    for raw_run_id in run_ids:
        run_id = archive._parse_utc_datetime(raw_run_id).isoformat(timespec="seconds")
        print(f"[850 HPA BACKFILL] Starting targeted historical cycle {run_id}")
        payload = archive.fetch_full_weather_data(run_id)
        if not isinstance(payload, dict) or payload.get("_pending_noaa_gfs"):
            raise RuntimeError(
                f"NOAA cycle incomplete for {run_id}: "
                f"{payload.get('_reason') if isinstance(payload, dict) else 'fetch failed'}"
            )
        daily = payload.get("daily", {})
        values = daily.get("wind_850_max", [])
        dates = daily.get("time", [])
        if not archive._has_complete_850_wind_daily_series(payload):
            raise RuntimeError(f"850 hPa daily series is incomplete for {run_id}.")
        archive.save_run(run_id, payload)
        # Historical exports are immutable run snapshots; never let an old
        # backfill cycle roll the website's latest.json backwards in time.
        archive.export_public_forecast_json(run_id, payload, update_latest=False)
        print(
            f"[850 HPA BACKFILL OK] {run_id}: {len(values)} daily maxima saved; "
            f"range={min(values):.1f}-{max(values):.1f} km/h"
        )

    manifest_path = public_dir / "notifications" / "latest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    latest = next(
        (item for item in manifest.get("items", []) if item.get("run_id_utc")),
        None,
    )
    if latest is None:
        raise RuntimeError("Latest public notification entry is missing.")
    current_id = archive._parse_utc_datetime(latest["run_id_utc"]).isoformat(timespec="seconds")
    current_record = archive.get_run_payload(current_id)
    if not current_record:
        raise RuntimeError(f"Latest SQLite run missing: {current_id}")
    if not archive._has_complete_850_wind_daily_series(current_record[1]):
        raise RuntimeError(f"Latest SQLite run has incomplete 850 hPa data: {current_id}")

    # Restore latest.json to the actual current report after writing the
    # historical run snapshots above; the latest endpoint must never point
    # at the last (older) backfill target.
    archive.export_public_forecast_json(current_id, current_record[1], update_latest=True)

    previous_runs = []
    for hours_back in (6, 12, 18):
        previous_id = (
            archive._parse_utc_datetime(current_id) - archive.timedelta(hours=hours_back)
        ).isoformat(timespec="seconds")
        record = archive.get_run_payload(previous_id)
        if not record:
            raise RuntimeError(f"Comparison SQLite run missing: {previous_id}")
        if not archive._has_complete_850_wind_daily_series(record[1]):
            raise RuntimeError(f"Comparison run has incomplete 850 hPa data: {previous_id}")
        previous_runs.append((record[0], json.dumps(record[1], ensure_ascii=False)))

    charts = archive.create_pages_comparison_charts(
        current_id, current_record[1], previous_runs
    )
    expected = {"temperature", "precipitation", "wind_10m", "wind_850"}
    if set(charts) != expected:
        raise RuntimeError(f"Expected four comparison charts, got {sorted(charts)}")
    try:
        images = archive.save_public_notification_images(current_id, charts)
    finally:
        for chart in charts.values():
            chart.close()
    if len(images) != 4:
        raise RuntimeError(f"Expected four saved chart images, got {len(images)}")

    latest["images"] = images
    latest["image_path"] = None
    manifest["updated_at_utc"] = archive.datetime.now(archive.timezone.utc).isoformat(timespec="seconds")
    archive._write_json_atomically(str(manifest_path), manifest)

    # Keep compact decoded per-point JSON in Actions cache; raw GRIB files are
    # disposable once decoded and would make the cache unnecessarily large.
    cache_root = Path(archive.NOAA_CACHE_DIR)
    if cache_root.exists():
        for raw_file in cache_root.rglob("*.grib2"):
            raw_file.unlink(missing_ok=True)

    print("[850 HPA BACKFILL COMPLETE] Four historical/current cycles persisted; all four comparison PNGs rebuilt.")
    print("[LATEST PRESERVED] public/latest.json still points to the report cycle; older exports live under public/runs/.")
    print("[CACHE] Decoded Istanbul fields retained; raw GRIB downloads removed.")


if __name__ == "__main__":
    main()
