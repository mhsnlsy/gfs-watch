"""Smoke test for the shared SVG report / Telegram comparison artwork."""
from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone

import main


def make_payload(run_index: int) -> dict:
    local_start = datetime(2026, 11, 6, 12, 0)
    timeline = {}
    for index in range(25):
        local = local_start + timedelta(hours=3 * index)
        valid_utc = (local - timedelta(hours=3)).replace(tzinfo=timezone.utc)
        local_key = local.strftime("%Y-%m-%dT%H:%M")
        timeline[local_key] = {
            "step_hour": 3 + (3 - run_index) * 6 + index * 3,
            "valid_time_utc": valid_utc.isoformat(timespec="minutes"),
            "temp": 11.0 + run_index * 0.2 + 1.5 * math.sin(index / 4),
            "temp_850": -1.0 + run_index * 0.3 + index * 0.08,
            "precip": 0.2 if index in (5 + run_index, 14) else 0.0,
            "wind": 12.0 + run_index + 2.0 * math.sin(index / 3),
            "wind_direction_deg": 45.0 + 20.0 * run_index,
            "wind_850": 18.0 + index * 0.25,
        }
    return {"timeline_180h": timeline, "daily": {}}


def main_test() -> None:
    run_ids = [
        "2026-11-06T00:00:00+00:00",
        "2026-11-06T06:00:00+00:00",
        "2026-11-06T12:00:00+00:00",
        "2026-11-06T18:00:00+00:00",
    ]
    payloads = [make_payload(index) for index in range(4)]
    previous = [
        (run_ids[index], json.dumps(payloads[index], ensure_ascii=False))
        for index in range(3)
    ]
    aligned = main._prepare_comparison_chart_data(
        run_ids[-1], payloads[-1], previous
    )
    assert aligned["valid_time_count"] == 25

    assets = main.create_valid_time_comparison_assets(
        run_ids[-1], payloads[-1], previous
    )
    if not assets:
        raise AssertionError("The common four-panel SVG / PNG figure was not created.")
    try:
        svg = assets["svg"].getvalue()
        png = assets["png"].getvalue()
        assert b"<svg" in svg[:4096]
        assert b"viewBox" in svg[:4096]
        assert png.startswith(b"\x89PNG\r\n\x1a\n")
        assert assets["series_count"] == 4
        assert assets["valid_time_count"] == 25
    finally:
        assets["svg"].close()
        assets["png"].close()

    print("[GFS SVG COMPARISON] 2x2 SVG + matching single Telegram PNG passed.")


if __name__ == "__main__":
    main_test()
