"""Smoke test for the shared SVG report / Telegram comparison artwork."""
from __future__ import annotations

import json
import math
import sys
from io import BytesIO

from PIL import Image
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main


def make_payload(run_index: int) -> dict:
    local_start = datetime(2026, 11, 7, 0, 0)
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
        assert b'gfs-interactive-data' in svg
        assert b'gfs-interaction-layer' in svg
        assert svg.count(b'class="gfs-hit-area"') == 4
        assert png.startswith(b"\x89PNG\r\n\x1a\n")
        png_size = Image.open(BytesIO(png)).size
        assert png_size[0] == 1792 and 1300 <= png_size[1] <= 1304, f"Unexpected 2x2 Telegram PNG dimensions: {png_size}"
        html = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
        assert ".gfs-interactive-chart{position:relative;width:80%;max-width:80%" in html
        assert "margin-inline:auto" in html
        assert assets["series_count"] == 4
        assert assets["valid_time_count"] == 25

        import re
        match = re.search(
            rb'<metadata id="gfs-interactive-data"><!\[CDATA\[(.*?)\]\]></metadata>',
            svg,
            re.DOTALL,
        )
        assert match, "SVG interaction metadata block is missing."
        metadata = json.loads(match.group(1).decode("utf-8"))
        assert len(metadata["panels"]) == 4
        assert {panel["id"] for panel in metadata["panels"]} == {
            "temperature", "temperature_850", "precipitation", "wind_10m"
        }
        for panel in metadata["panels"]:
            assert len(panel["valid_times"]) == 25
            assert len(panel["series"]) == 4
            assert all(len(series["lead_hours"]) == 25 for series in panel["series"])
            assert all(len(series["values"]) == 25 for series in panel["series"])
            assert all(len(series["y_positions"]) == 25 for series in panel["series"])
            assert all(time["label"].endswith(" TSİ") for time in panel["valid_times"])

            plot = panel["plot"]
            assert plot["width"] > 0 and plot["height"] > 0
            assert len(panel["x_positions"]) == 25
            assert all(plot["x"] <= x <= plot["x"] + plot["width"] for x in panel["x_positions"])
            for series in panel["series"]:
                for y in series["y_positions"]:
                    assert y is None or plot["y"] <= y <= plot["y"] + plot["height"]

        # Same valid instant, different lead hours: four cycle values must be
        # available from every panel for the first valid-time position.
        expected_leads = [21, 15, 9, 3]
        for panel in metadata["panels"]:
            assert [series["lead_hours"][0] for series in panel["series"]] == expected_leads
    finally:
        assets["svg"].close()
        assets["png"].close()

    print("[GFS SVG COMPARISON] 2x2 SVG + matching single Telegram PNG passed.")


if __name__ == "__main__":
    main_test()
