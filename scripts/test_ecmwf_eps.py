"""Offline smoke tests for the ECMWF EPS publication contract."""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from fetch_ecmwf_eps import (  # noqa: E402
    SCHEMA,
    build_document,
    forecast_steps,
    validate_document,
    same_published_cycle,
    _matches_grib_field,
    load_comparison_runs,
)


def synthetic_series(steps, value, latitude=41.0, longitude=29.0):
    return {step: (value, latitude, longitude) for step in steps}


def run_offline_tests() -> None:
    steps = forecast_steps()
    assert len(steps) == 55, len(steps)
    assert steps[:4] == [0, 3, 6, 9]
    assert steps[48:] == [144, 150, 156, 162, 168, 174, 180]
    assert same_published_cycle("2026-11-01T00:00:00Z", "2026-11-01T00:00:00+00:00")
    assert not same_published_cycle("2026-10-31T12:00:00+00:00", "2026-11-01T00:00:00+00:00")
    assert not same_published_cycle(None, "2026-11-01T00:00:00+00:00")

    # ECMWF Open Data encodes these single-level parameters as surface fields.
    # Keep compatibility with older/alternate heightAboveGround encodings too.
    assert _matches_grib_field("t2m", "2t", 167, "surface", 0)
    assert _matches_grib_field("t2m", "2t", 167, "heightAboveGround", 2)
    assert not _matches_grib_field("t2m", "2t", 167, "heightAboveGround", 10)
    assert _matches_grib_field("u10", "10u", 165, "surface", 0)
    assert _matches_grib_field("u10", "10u", 165, "heightAboveGround", 10)
    assert _matches_grib_field("v10", "10v", 166, "surface", 0)
    assert _matches_grib_field("v10", "10v", 166, "heightAboveGround", 10)
    assert _matches_grib_field("msl", "msl", 151, "meanSea", 0)

    mean = {
        "mean_t850": synthetic_series(steps, 274.15),
        "mean_ws850": synthetic_series(steps, 10.0),
        "mean_msl": synthetic_series(steps, 101325.0),
        "mean_t2m": synthetic_series(steps, 280.15),
        "mean_u10": synthetic_series(steps, 3.0),
        "mean_v10": synthetic_series(steps, 4.0),
        "mean_tp": synthetic_series(steps, 0.001),
    }
    spread = {
        "spread_t850": synthetic_series(steps, 1.0),
        "spread_ws850": synthetic_series(steps, 2.0),
        "spread_msl": synthetic_series(steps, 250.0),
    }
    regional_pressure = {
        "diameter_km": 2500,
        "high": {"pressure_hpa": 1030.0, "latitude": 50.5, "longitude": 25.5},
        "low": {"pressure_hpa": 1008.0, "latitude": 39.0, "longitude": 19.5},
        "local_pressure_hpa": 1013.3,
    }
    document = build_document(
        datetime(2026, 11, 1, 0, tzinfo=timezone.utc),
        mean, spread, regional_pressure,
    )
    validate_document(document)
    mean_without_tp_zero = {**mean, "mean_tp": dict(mean["mean_tp"])}
    del mean_without_tp_zero["mean_tp"][0]
    zero_baseline_document = build_document(
        datetime(2026, 11, 1, 0, tzinfo=timezone.utc),
        mean_without_tp_zero, spread, regional_pressure,
    )
    assert zero_baseline_document["forecasts"][0]["precipitation_interval_mm"] == 0.0
    assert document["schema"] == SCHEMA
    assert document["forecasts"][0]["temperature_850hpa"]["mean_c"] == 1.0
    assert document["forecasts"][0]["wind_850hpa"]["mean_kmh"] == 36.0
    assert document["forecasts"][0]["mslp"]["mean_hpa"] == 1013.25
    assert document["forecasts"][-1]["forecast_hour"] == 180
    assert document["forecasts"][0]["temperature_2m_c"] == 7.0
    assert document["forecasts"][0]["wind_speed_10m_kmh"] == 18.0
    assert document["forecasts"][0]["temperature_2m_stddev_c"] is None
    assert document["forecasts"][0]["wind_speed_10m_stddev_kmh"] is None
    assert document["forecasts"][0]["precipitation_interval_stddev_mm"] is None
    assert document["surface_ensemble_spread_available"] is False
    assert document["surface_forecast_source"] == "IFS HRES deterministic (stream=oper, type=fc)"
    assert "HRES" in document["model"]
    assert len(document["forecast_6_hourly"]) == 55
    assert document["daily_summary"]
    assert len(document["regional_pressure_analysis"]["findings"]) == 4
    assert "Kuzeybatı Ukrayna" in document["regional_pressure_analysis"]["findings"][0]
    assert "Batı Yunanistan" in document["regional_pressure_analysis"]["findings"][1]
    fallback_document = build_document(
        datetime(2026, 11, 1, 0, tzinfo=timezone.utc), mean, spread
    )
    assert fallback_document["regional_pressure_analysis"]["findings"]
    assert "konumu üretilmedi" in fallback_document["regional_pressure_analysis"]["findings"][0]

    # Negative tests: missing step and physically impossible wind must fail closed.
    broken = dict(document)
    broken["forecasts"] = document["forecasts"][:-1]
    try:
        validate_document(broken)
    except ValueError:
        pass
    else:
        raise AssertionError("A shortened forecast series was accepted.")

    broken = {
        **document,
        "forecasts": [dict(item) for item in document["forecasts"]],
    }
    broken["forecasts"][0] = {
        **broken["forecasts"][0],
        "wind_850hpa": {"mean_kmh": 999.0, "stddev_kmh": 1.0},
    }
    try:
        validate_document(broken)
    except ValueError:
        pass
    else:
        raise AssertionError("An impossible wind value was accepted.")

    # The public comparison feed must contain the latest four complete runs.
    import json
    import tempfile
    from datetime import timedelta
    with tempfile.TemporaryDirectory() as temp_dir:
        archive_dir = Path(temp_dir)
        base = datetime(2026, 10, 30, tzinfo=timezone.utc)
        for offset in (0, 12, 24, 36, 48):
            run_dt = base + timedelta(hours=offset)
            archived = dict(document)
            archived["run_id_utc"] = run_dt.isoformat(timespec="seconds")
            (archive_dir / (run_dt.strftime("%Y%m%dT%HZ") + ".json")).write_text(
                json.dumps(archived), encoding="utf-8"
            )
        (archive_dir / "20261031T18Z.json").write_text("{broken", encoding="utf-8")
        history = load_comparison_runs(archive_dir, limit=4)
        assert len(history) == 4, len(history)
        assert [item["run_id_utc"] for item in history] == [
            "2026-10-31T00:00:00+00:00",
            "2026-10-31T12:00:00+00:00",
            "2026-11-01T00:00:00+00:00",
            "2026-11-01T12:00:00+00:00",
        ]
        assert all(len(item["forecast_6_hourly"]) == 55 for item in history)

    print("[ECMWF OFFLINE SMOKE] 55 steps, HRES/ENS source split, surface spread null semantics, units and fail-closed checks passed.")


def main() -> None:
    run_offline_tests()
    if len(sys.argv) > 1:
        import json
        path = Path(sys.argv[1])
        document = json.loads(path.read_text(encoding="utf-8"))
        validate_document(document)
        print(f"[ECMWF LIVE SMOKE] {path}: {len(document['forecasts'])} valid steps.")


if __name__ == "__main__":
    main()
