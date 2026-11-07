"""Offline smoke tests for the MeteoPT ECMWF publication contract."""
from __future__ import annotations

import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from fetch_ecmwf_eps import (  # noqa: E402
    SCHEMA,
    _validate_meteopt_document,
    forecast_steps,
    load_comparison_runs,
    same_published_cycle,
)


def synthetic_document(run_dt: datetime) -> dict:
    steps = list(range(3, 181, 3))
    forecasts = []
    for hour in steps:
        valid = run_dt + timedelta(hours=hour)
        forecasts.append({
            "forecast_hour": hour,
            "valid_time_utc": valid.isoformat(timespec="seconds"),
            "valid_time_istanbul": valid.astimezone(
                timezone(timedelta(hours=3))
            ).isoformat(timespec="seconds"),
            "temperature_2m_c": 7.0 + hour / 100,
            "temperature_2m_stddev_c": None,
            "wind_speed_10m_kmh": 18.0,
            "wind_direction_10m_deg": 180.0,
            "wind_speed_10m_stddev_kmh": None,
            "precipitation_interval_mm": 0.1,
            "precipitation_interval_stddev_mm": None,
            "precipitation_accumulated_mm": None,
            "temperature_850hpa": {"mean_c": 1.0, "stddev_c": None},
            "wind_850hpa": {"mean_kmh": 36.0, "stddev_kmh": None},
            "mslp": {"mean_hpa": 1013.2, "stddev_hpa": None},
        })
    timeline = [{
        "forecast_hour": item["forecast_hour"],
        "valid_time_utc": item["valid_time_utc"],
        "valid_time_istanbul": item["valid_time_istanbul"],
        "temperature_2m_c": item["temperature_2m_c"],
        "temperature_850hpa_c": item["temperature_850hpa"]["mean_c"],
        "wind_speed_10m_kmh": item["wind_speed_10m_kmh"],
        "wind_direction_10m_deg": item["wind_direction_10m_deg"],
        "wind_speed_850hpa_kmh": item["wind_850hpa"]["mean_kmh"],
        "precipitation_6h_mm": item["precipitation_interval_mm"],
        "precipitation_interval_hours": 3,
    } for item in forecasts]
    return {
        "schema": SCHEMA,
        "status": "ready",
        "forecast_source": "meteopt",
        "model": "ECMWF via MeteoPT",
        "product": "MeteoPT ECMWF 3-hour point",
        "surface_forecast_source": "MeteoPT ECMWF point",
        "ensemble_forecast_source": "MeteoPT ECMWF point",
        "surface_ensemble_spread_available": False,
        "resolution": "MeteoPT nokta",
        "forecast_horizon_hours": 180,
        "run_id_utc": run_dt.isoformat(timespec="seconds"),
        "updated_at_utc": run_dt.isoformat(timespec="seconds"),
        "forecast_valid_until_utc": (run_dt + timedelta(hours=180)).isoformat(timespec="seconds"),
        "location": {
            "name": "İstanbul",
            "latitude": 41.0901,
            "longitude": 28.9436,
            "nearest_grid_latitude": 41.0901,
            "nearest_grid_longitude": 28.9436,
        },
        "units": {
            "temperature_850hpa": "°C",
            "wind_850hpa": "km/sa",
            "mslp": "hPa",
            "spread": "MeteoPT noktasında ensemble sapması yok",
        },
        "attribution": "ECMWF nokta serisi MeteoPT üzerinden alınır.",
        "license": "MeteoPT",
        "license_url": "https://www.meteopt.com/modelos/ecmwf",
        "source_url": "https://www.meteopt.com/modelos/ecmwf?lat=41.0901&lon=28.9436",
        "notes": [
            "Sıcaklık, rüzgâr, yağış, 850 hPa ve basınç aynı MeteoPT ECMWF noktasından gelir.",
            "Seri 3 saatte bir. Ensemble sapması ve bölgesel basınç merkezi bu kaynakta yok.",
        ],
        "forecasts": forecasts,
        "daily_summary": [{
            "date_istanbul": "2026-11-01",
            "temperature_min_c": 7.0,
            "temperature_max_c": 8.8,
            "precipitation_total_mm": 6.0,
            "wind_speed_max_10m_kmh": 18.0,
            "wind_speed_max_850hpa_kmh": 36.0,
        }],
        "forecast_6_hourly": timeline,
        "current_conditions": {
            "temperature_2m_c": 7.0,
            "wind_speed_10m_kmh": 18.0,
            "precipitation_mm": 0.1,
            "mean_sea_level_pressure_hpa": 1013.2,
        },
        "regional_pressure_analysis": {
            "valid_time_utc": run_dt.isoformat(timespec="seconds"),
            "diameter_km": None,
            "findings": ["İstanbul deniz seviyesi basıncı 1013.2 hPa. MeteoPT ECMWF noktası; bölgesel basınç merkezi bu kaynakta yok."],
        },
    }


def run_offline_tests() -> None:
    steps = forecast_steps()
    assert steps == list(range(0, 145, 3)) + [150, 156, 162, 168, 174, 180]
    assert same_published_cycle("2026-11-01T00:00:00Z", "2026-11-01T00:00:00+00:00")
    assert not same_published_cycle("2026-10-31T12:00:00+00:00", "2026-11-01T00:00:00+00:00")
    assert not same_published_cycle(None, "2026-11-01T00:00:00+00:00")

    document = synthetic_document(datetime(2026, 11, 1, 0, tzinfo=timezone.utc))
    _validate_meteopt_document(document)
    assert document["schema"] == SCHEMA
    assert document["forecast_source"] == "meteopt"
    assert document["location"]["latitude"] == 41.0901
    assert document["location"]["longitude"] == 28.9436
    assert len(document["forecasts"]) == 60
    assert document["forecasts"][-1]["forecast_hour"] == 180
    assert len(document["forecast_6_hourly"]) == len(document["forecasts"])
    assert document["surface_ensemble_spread_available"] is False

    broken = json.loads(json.dumps(document))
    broken["forecasts"] = broken["forecasts"][:7]
    try:
        _validate_meteopt_document(broken)
    except ValueError:
        pass
    else:
        raise AssertionError("A too-short MeteoPT forecast series was accepted.")

    broken = json.loads(json.dumps(document))
    broken["forecasts"][0]["wind_speed_10m_kmh"] = -1
    try:
        _validate_meteopt_document(broken)
    except ValueError:
        pass
    else:
        raise AssertionError("A negative MeteoPT wind value was accepted.")

    with tempfile.TemporaryDirectory() as temp_dir:
        archive_dir = Path(temp_dir)
        base = datetime(2026, 10, 30, tzinfo=timezone.utc)
        for offset in (0, 12, 24, 36, 48):
            archived = synthetic_document(base + timedelta(hours=offset))
            (archive_dir / ((base + timedelta(hours=offset)).strftime("%Y%m%dT%HZ") + ".json")).write_text(
                json.dumps(archived), encoding="utf-8"
            )
        history = load_comparison_runs(archive_dir, limit=4)
        assert len(history) == 4
        assert [item["run_id_utc"] for item in history] == [
            "2026-10-31T00:00:00+00:00",
            "2026-10-31T12:00:00+00:00",
            "2026-11-01T00:00:00+00:00",
            "2026-11-01T12:00:00+00:00",
        ]

    print("[ECMWF METEOPT OFFLINE SMOKE] MeteoPT schema, 180h timeline, validation and 4-cycle comparison checks passed.")


def main() -> None:
    run_offline_tests()
    if len(sys.argv) > 1:
        path = Path(sys.argv[1])
        document = json.loads(path.read_text(encoding="utf-8"))
        _validate_meteopt_document(document)
        print(f"[ECMWF METEOPT LIVE SMOKE] {path}: {len(document['forecasts'])} valid steps.")


if __name__ == "__main__":
    main()
