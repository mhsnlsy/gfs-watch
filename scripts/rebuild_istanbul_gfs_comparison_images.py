"""Rebuild Istanbul's shared four-panel SVG / Telegram image from saved runs.

No forecast data is downloaded or refreshed. The script only re-renders the
single vector comparison report and its matching Telegram PNG, then updates
the existing public notification manifests.
"""
from __future__ import annotations

import json
import os
from datetime import timedelta
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
GFS_DIR = Path(os.environ.get("ISTANBUL_GFS_DIR", ROOT / "gfs-state" / "gfs")).resolve()
os.environ["PUBLIC_DATA_DIR"] = str(GFS_DIR)
sys.path.insert(0, str(ROOT))

import main  # noqa: E402


def to_chart_payload(document: dict) -> dict:
    timeline = {}
    for point in document.get("forecast_6_hourly") or []:
        valid_utc = point.get("valid_time_utc")
        if not valid_utc:
            continue
        local = point.get("valid_time_istanbul")
        if not local:
            local = main._parse_utc_datetime(valid_utc).astimezone(main.TR_TZ).isoformat(timespec="minutes")
        local_key = local[:16]
        timeline[local_key] = {
            "step_hour": point.get("forecast_hour"),
            "valid_time_utc": valid_utc,
            "temp": point.get("temperature_2m_c"),
            "temp_850": point.get("temperature_850hpa_c"),
            "wind": point.get("wind_speed_10m_kmh"),
            "wind_direction_deg": point.get("wind_direction_10m_deg"),
            "wind_850": point.get("wind_speed_850hpa_kmh"),
            "precip": point.get("precipitation_6h_mm"),
        }
    return {"timeline_180h": timeline}


def main_rebuild() -> None:
    run_files = sorted((GFS_DIR / "runs").glob("*.json"), reverse=True)[:4]
    if len(run_files) < 2:
        raise RuntimeError(f"At least two saved Istanbul GFS runs are required; found {len(run_files)}.")

    documents = [json.loads(path.read_text(encoding="utf-8")) for path in run_files]
    documents.sort(key=lambda doc: main._parse_utc_datetime(doc["run_id_utc"]))
    current_document = documents[-1]
    current_run = main._parse_utc_datetime(current_document["run_id_utc"]).isoformat(timespec="seconds")
    payloads = [(doc["run_id_utc"], to_chart_payload(doc)) for doc in documents]
    current_payload = payloads[-1][1]
    previous_runs = [
        (run_id, json.dumps(payload, ensure_ascii=False))
        for run_id, payload in payloads[:-1]
    ]

    assets = main.create_valid_time_comparison_assets(
        current_run, current_payload, previous_runs
    )
    if not assets.get("svg") or not assets.get("png"):
        for buffer in assets.values():
            if hasattr(buffer, "close"):
                buffer.close()
        raise RuntimeError("The shared SVG comparison and Telegram PNG were not generated.")

    try:
        telegram_image_path = main.save_public_notification_image(
            current_run, assets["png"]
        )
        svg_image_path = main.save_public_notification_svg_image(
            current_run, assets["svg"]
        )
    finally:
        assets["svg"].close()
        assets["png"].close()
    if not telegram_image_path or not svg_image_path:
        raise RuntimeError("The SVG report or its matching Telegram image could not be archived.")
    images = [{
        "label": "4 GFS döngüsü · 72 saat · aynı geçerlilik saatleri (TSİ)",
        "path": svg_image_path,
    }]

    run_key = main._parse_utc_datetime(current_run).strftime("%Y%m%dT%HZ")
    manifest_path = GFS_DIR / "notifications" / "latest.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"Public notification manifest missing: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    items = manifest.get("items")
    if not isinstance(items, list):
        raise RuntimeError("Public notification manifest has no items list.")
    matched = [
        item for item in items
        if item.get("id") == run_key or item.get("run_id_utc") == current_run
    ]
    if len(matched) != 1:
        raise RuntimeError(f"Expected one manifest entry for {run_key}; found {len(matched)}.")
    matched[0]["images"] = images
    matched[0]["image_path"] = telegram_image_path
    manifest["updated_at_utc"] = main.datetime.now(main.timezone.utc).isoformat(timespec="seconds")
    main._write_json_atomically(str(manifest_path), manifest)

    latest_path = GFS_DIR / "latest.json"
    latest = json.loads(latest_path.read_text(encoding="utf-8"))
    if latest.get("run_id_utc") != current_run:
        raise RuntimeError("Canonical latest.json does not match the newest saved run.")
    report = latest.get("report")
    if not isinstance(report, dict):
        raise RuntimeError("Canonical latest.json has no report record.")
    report["images"] = images
    report["image_path"] = telegram_image_path
    main._write_json_atomically(str(latest_path), latest)

    print(
        f"[ISTANBUL VALID-TIME SVG REBUILD] run={current_run}; "
        f"common_valid_times={assets['valid_time_count']}; "
        f"cycles={len(documents)}; svg=1; telegram_photo=1; download=none"
    )


if __name__ == "__main__":
    main_rebuild()
