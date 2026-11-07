"""Build the complete Istanbul GFS publication bundle from one canonical MeteoPT dataset.

The collector writes the four latest MeteoPT cycles to gfs/runs/*.json.
This script never downloads GFS data. It only transforms those saved cycle files
into the public forecast bundle, one vector SVG comparison report, one
matching Telegram photo, and the report archive. One source -> one publication bundle.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# main.py uses PUBLIC_DATA_DIR at import time. Point it at the isolated GFS
# publication tree before importing it.
ROOT = Path.cwd()
SOURCE_ROOT = Path(os.environ.get("GFS_SOURCE_ROOT", ROOT)).resolve()
GFS_DIR = ROOT / "gfs"
os.environ["PUBLIC_DATA_DIR"] = str(GFS_DIR)
sys.path.insert(0, str(SOURCE_ROOT))

import main  # noqa: E402


TR_TZ = timezone(timedelta(hours=3))


def utc_dt(value: str) -> datetime:
    return main._parse_utc_datetime(value)


def to_main_payload(doc: dict) -> dict:
    points = doc.get("forecast_6_hourly") or []
    timeline = {}
    for point in points:
        local = point.get("valid_time_istanbul")
        if not local:
            local = utc_dt(point["valid_time_utc"]).astimezone(TR_TZ).isoformat(timespec="minutes")
        local_key = local[:16]
        timeline[local_key] = {
            "step_hour": point.get("forecast_hour"),
            "valid_time_utc": point.get("valid_time_utc"),
            "temp": point.get("temperature_2m_c"),
            "temp_850": point.get("temperature_850hpa_c"),
            "wind": point.get("wind_speed_10m_kmh"),
            "wind_direction_deg": point.get("wind_direction_10m_deg"),
            "wind_850": point.get("wind_speed_850hpa_kmh"),
            "precip": point.get("precipitation_6h_mm"),
        }

    by_day: dict[str, list[dict]] = {}
    for point in points:
        local = point.get("valid_time_istanbul")
        if not local:
            local = utc_dt(point["valid_time_utc"]).astimezone(TR_TZ).isoformat(timespec="minutes")
        by_day.setdefault(local[:10], []).append(point)

    dates = sorted(by_day)
    def vals(day: str, key: str):
        out = []
        for p in by_day[day]:
            value = p.get(key)
            if value is not None:
                try:
                    out.append(float(value))
                except (TypeError, ValueError):
                    pass
        return out

    daily = {
        "time": dates,
        "temp_min": [min(vals(d, "temperature_2m_c")) if vals(d, "temperature_2m_c") else None for d in dates],
        "temp_max": [max(vals(d, "temperature_2m_c")) if vals(d, "temperature_2m_c") else None for d in dates],
        "temp_850_min": [min(vals(d, "temperature_850hpa_c")) if vals(d, "temperature_850hpa_c") else None for d in dates],
        "temp_850_max": [max(vals(d, "temperature_850hpa_c")) if vals(d, "temperature_850hpa_c") else None for d in dates],
        "precip_sum": [sum(max(0.0, x) for x in vals(d, "precipitation_6h_mm")) for d in dates],
        "wind_max": [max(vals(d, "wind_speed_10m_kmh")) if vals(d, "wind_speed_10m_kmh") else None for d in dates],
        "wind_850_max": [max(vals(d, "wind_speed_850hpa_kmh")) if vals(d, "wind_speed_850hpa_kmh") else None for d in dates],
    }

    first = points[0] if points else {}
    current = {
        "temp": first.get("temperature_2m_c"),
        "wind": first.get("wind_speed_10m_kmh"),
        "precip": first.get("precipitation_6h_mm"),
    }
    return {
        "current": current,
        "daily": daily,
        "timeline_180h": timeline,
        "forecast_horizon_hours": doc.get("forecast_horizon_hours", 0),
        "data_source": "MeteoPT GFS",
        "synoptic_alerts": [],
        "station_observation": None,
    }


def main_publish() -> None:
    # The poller chooses exactly one F180 cycle per 10-minute run. Honor that
    # target so a delayed cycle cannot accidentally rebuild a newer report.
    target_run = os.getenv("GFS_TARGET_RUN_ID", "").strip()
    if target_run:
        target_dt = utc_dt(target_run)
        target_files = [
            path for path in (GFS_DIR / "runs").glob("*.json")
            if utc_dt(json.loads(path.read_text(encoding="utf-8"))["run_id_utc"]) == target_dt
        ]
        if not target_files:
            raise RuntimeError(f"Requested GFS target run is not archived: {target_run}")
        target_path = target_files[0]
        run_files = sorted((GFS_DIR / "runs").glob("*.json"), reverse=True)[:4]
        if target_path not in run_files:
            run_files = [target_path] + [path for path in run_files if path != target_path][:3]
    else:
        run_files = sorted((GFS_DIR / "runs").glob("*.json"), reverse=True)[:4]
    if not run_files:
        raise RuntimeError("No canonical Istanbul GFS run is available.")

    docs = [json.loads(path.read_text(encoding="utf-8")) for path in run_files]
    docs.sort(key=lambda d: utc_dt(d["run_id_utc"]))
    if target_run:
        target_dt = utc_dt(target_run)
        docs = [doc for doc in docs if utc_dt(doc["run_id_utc"]) <= target_dt][-4:]
        current_doc = docs[-1]
    else:
        current_doc = docs[-1]
    current_run = utc_dt(current_doc["run_id_utc"]).isoformat(timespec="seconds")

    payloads = [(d["run_id_utc"], to_main_payload(d)) for d in docs]
    current_payload = payloads[-1][1]
    previous_runs = [
        (run_id, json.dumps(payload, ensure_ascii=False))
        for run_id, payload in payloads[:-1]
    ]

    # Render one shared 2x2 SVG composition. The PNG is exported from the
    # same Matplotlib figure solely for Telegram's single-photo endpoint.
    assets = main.create_valid_time_comparison_assets(
        current_run, current_payload, previous_runs
    )
    if not assets.get("svg") or not assets.get("png"):
        for buffer in assets.values():
            if hasattr(buffer, "close"):
                buffer.close()
        raise RuntimeError("The shared SVG comparison and Telegram PNG were not generated.")

    full_report, speech_text = main.analyze_and_build_output(
        current_run, current_payload, previous_runs
    )

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
        "label": "4 GFS döngüsü · 180 saat · aynı geçerlilik saatleri (TSİ)",
        "path": svg_image_path,
    }]
    report_entry = main.publish_public_notification(
        current_run,
        full_report,
        speech_text,
        image_path=telegram_image_path,
        audio_file=None,
        images=images,
    )

    # Delayed F180 cycles are archived and announced, but must never roll the
    # live homepage backward over a chronologically newer canonical run.
    latest_path = GFS_DIR / "latest.json"
    existing_latest = None
    if latest_path.is_file():
        try:
            existing_latest = json.loads(latest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            existing_latest = None

    existing_run = None
    if isinstance(existing_latest, dict) and existing_latest.get("run_id_utc"):
        try:
            existing_run = utc_dt(existing_latest["run_id_utc"])
        except (TypeError, ValueError):
            existing_run = None

    if existing_run is not None and existing_run > utc_dt(current_run):
        print(
            f"[ISTANBUL GFS BUNDLE] Older delayed cycle {current_run} "
            f"archived to notifications; homepage remains on {existing_latest['run_id_utc']}."
        )
    else:
        latest = dict(current_doc)
        latest["schema"] = "gfs-watch.forecast.v1"
        latest["forecast_source"] = "meteopt"
        latest["report"] = report_entry
        latest["comparison_runs"] = list(reversed(docs))
        latest_path.write_text(
            json.dumps(latest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        comparison = {
            "schema": "istanbul-gfs.comparison.v1",
            "location": {"name": "Istanbul", "latitude": 41.014, "longitude": 28.950},
            "updated_at_utc": latest.get("published_at_utc"),
            "runs": list(reversed(docs)),
        }
        (GFS_DIR / "comparison.json").write_text(
            json.dumps(comparison, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    print(
        f"[ISTANBUL GFS BUNDLE] run={current_run}; "
        f"cycles={len(run_files)}; pages_svg={len(images)}; telegram_photo=1; "
        f"valid_times={assets.get('valid_time_count')}; report=1; source=MeteoPT"
    )


if __name__ == "__main__":
    main_publish()
