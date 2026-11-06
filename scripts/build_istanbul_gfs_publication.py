"""Build the complete Istanbul GFS publication bundle from one canonical MeteoPT dataset.

The collector writes the four latest MeteoPT cycles to gfs/runs/*.json.
This script never downloads GFS data. It only transforms those saved cycle files
into the public forecast bundle, four Pages comparison PNGs, and the report
archive. One source -> one publication bundle.
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
    # Like the Köy renderer, publish what is available instead of blocking
    # the first F180 publication until four complete cycles have accumulated.
    run_files = sorted((GFS_DIR / "runs").glob("*.json"), reverse=True)[:4]
    if not run_files:
        raise RuntimeError("No canonical Istanbul GFS run is available.")

    docs = [json.loads(path.read_text(encoding="utf-8")) for path in run_files]
    docs.sort(key=lambda d: utc_dt(d["run_id_utc"]))
    current_doc = docs[-1]
    current_run = utc_dt(current_doc["run_id_utc"]).isoformat(timespec="seconds")

    payloads = [(d["run_id_utc"], to_main_payload(d)) for d in docs]
    current_payload = payloads[-1][1]
    previous_runs = [
        (run_id, json.dumps(payload, ensure_ascii=False))
        for run_id, payload in payloads[:-1]
    ]

    # Generate the exact same four Pages chart types used by the existing
    # report system, but from the canonical MeteoPT run files.
    charts = main.create_pages_comparison_charts(
        current_run, current_payload, previous_runs
    )
    if set(charts) != {"temperature", "temperature_850", "precipitation", "wind_10m"}:
        for buffer in charts.values():
            buffer.close()
        raise RuntimeError(f"Four comparison PNGs were not generated: {sorted(charts)}")

    full_report, speech_text = main.analyze_and_build_output(
        current_run, current_payload, previous_runs
    )

    try:
        images = main.save_public_notification_images(current_run, charts)
    finally:
        for buffer in charts.values():
            buffer.close()

    if len(images) != 4:
        raise RuntimeError(f"Expected four PNGs, saved {len(images)}.")

    report_entry = main.publish_public_notification(
        current_run,
        full_report,
        speech_text,
        image_path=None,
        audio_file=None,
        images=images,
    )

    # Canonical latest.json must be the newest document, not the oldest file
    # in the descending filename list used to select the four most recent runs.
    latest = dict(current_doc)
    latest["schema"] = "gfs-watch.forecast.v1"
    latest["forecast_source"] = "meteopt"
    latest["report"] = report_entry
    latest["comparison_runs"] = list(reversed(docs))
    (GFS_DIR / "latest.json").write_text(
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
        f"cycles={len(run_files)}; pages_png={len(images)}; "
        "report=1; source=MeteoPT"
    )


if __name__ == "__main__":
    main_publish()
