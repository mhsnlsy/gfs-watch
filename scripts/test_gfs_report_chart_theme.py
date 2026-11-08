"""Source-level and contrast smoke tests for dark GFS report charts."""
from __future__ import annotations

import ast
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "main.py").read_text(encoding="utf-8")
BUILDER_SOURCE = (ROOT / "scripts/build_istanbul_gfs_publication.py").read_text(encoding="utf-8")


def parse_color(value: str) -> tuple[float, float, float]:
    value = value.lstrip("#")
    return tuple(int(value[index:index + 2], 16) / 255 for index in (0, 2, 4))


def luminance(value: str) -> float:
    channels = []
    for channel in parse_color(value):
        channels.append(
            channel / 12.92
            if channel <= 0.04045
            else ((channel + 0.055) / 1.055) ** 2.4
        )
    red, green, blue = channels
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast(first: str, second: str) -> float:
    high, low = sorted((luminance(first), luminance(second)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def constant(name: str) -> str:
    match = re.search(rf'^{name}\s*=\s*"(#[0-9A-Fa-f]{{6}})"\s*$', SOURCE, re.M)
    if not match:
        raise AssertionError(f"Missing report theme color: {name}")
    return match.group(1)



def test_valid_time_alignment() -> None:
    """Exercise the chart data preparer without importing main.py's API dependencies."""
    tree = ast.parse(SOURCE)
    selected = [
        node for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name in {"_comparison_valid_time_key", "_prepare_comparison_chart_data"}
    ]
    assert {node.name for node in selected} == {
        "_comparison_valid_time_key", "_prepare_comparison_chart_data"
    }

    def parse_utc(value: str):
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    namespace = {
        "datetime": datetime,
        "timezone": timezone,
        "TR_TZ": ZoneInfo("Europe/Istanbul"),
        "math": math,
        "json": json,
        "_parse_utc_datetime": parse_utc,
    }
    module = ast.Module(body=selected, type_ignores=[])
    exec(compile(module, "main.py", "exec"), namespace)

    run_ids = [
        "2026-11-05T12:00:00+00:00",
        "2026-11-05T18:00:00+00:00",
        "2026-11-06T00:00:00+00:00",
        "2026-11-06T06:00:00+00:00",
    ]
    # 8 November 15:00 TSİ is the same valid time in all four cycles,
    # although its lead hour is different in each cycle.
    leads = [72, 66, 60, 54]
    timeline_keys = [
        ("2026-11-08T15:00", "2026-11-08T12:00+00:00"),
        ("2026-11-08T18:00", "2026-11-08T15:00+00:00"),
    ]

    def payload(run_index: int) -> dict:
        timeline = {}
        for point_index, (local_key, valid_utc) in enumerate(timeline_keys):
            timeline[local_key] = {
                "step_hour": leads[run_index] + point_index * 3,
                "valid_time_utc": valid_utc,
                "temp": 10.0 + run_index + point_index,
                "temp_850": 1.0 + run_index + point_index,
                "wind": 8.0 + run_index + point_index,
                "wind_direction_deg": 45.0 + run_index,
                "wind_850": 12.0 + run_index + point_index,
                "precip": 0.1 * run_index,
            }
        # The latest-only point must not contaminate any cycle's daily extrema.
        if run_index == 3:
            timeline["2026-11-08T21:00"] = {
                "step_hour": 60,
                "valid_time_utc": "2026-11-08T18:00+00:00",
                "temp": 99.0,
                "temp_850": 99.0,
                "wind": 99.0,
                "wind_direction_deg": 99.0,
                "wind_850": 99.0,
                "precip": 99.0,
            }
        return {"timeline_180h": timeline, "daily": {}}

    previous = [
        (run_ids[index], json.dumps(payload(index)))
        for index in range(3)
    ]
    prepared = namespace["_prepare_comparison_chart_data"](
        run_ids[3], payload(3), previous
    )

    assert prepared["valid_time_count"] == 2
    assert prepared["dates"] == ["2026-11-08"]
    assert all(
        list(item["timeline"]) == [
            "2026-11-08T15:00", "2026-11-08T18:00"
        ]
        for item in prepared["series"]
    )
    leads_at_1500 = {
        item["run_id"]: item["timeline"]["2026-11-08T15:00"]["step_hour"]
        for item in prepared["series"]
    }
    assert leads_at_1500 == dict(zip(run_ids, leads))
    latest_daily = prepared["series"][-1]["daily"]["2026-11-08"]
    assert latest_daily["temp_max"] == 14.0
    assert latest_daily["temp_850_max"] == 5.0
    assert latest_daily["wind"] == 12.0
    assert abs(latest_daily["precip"] - 0.6) < 1e-9

    assert '"valid_time_utc": point.get("valid_time_utc")' in BUILDER_SOURCE
    assert 'Aynı geçerlilik saatleri (TSİ)' in SOURCE

def main() -> None:
    test_valid_time_alignment()
    figure_bg = constant("GFS_REPORT_FIGURE_BG")
    axis_bg = constant("GFS_REPORT_AXIS_BG")
    panel_bg = constant("GFS_REPORT_PANEL_BG")
    text = constant("GFS_REPORT_TEXT")
    muted = constant("GFS_REPORT_MUTED")
    # The renderer derives colors by cycle age: newest → oldest.
    # Keep the test aligned with the production palette rather than requiring
    # an obsolete `colors = [...]` literal assignment.
    palette_match = re.search(
        r'age_palette\\s*=\\s*\\[([^\\]]+)\\]', SOURCE
    )
    if not palette_match:
        raise AssertionError("Four distinct GFS cycle accent colors are missing.")
    palette = re.findall(r"#[0-9A-Fa-f]{6}", palette_match.group(1))
    assert palette == ["#B38BE8", "#F1C98B", "#7DD3D7", "#8ABCE8"]

    assert figure_bg.lower() not in ("#ffffff", "#fffafa", "#fbfdff")
    assert axis_bg.lower() not in ("#ffffff", "#fffafa", "#fbfdff")
    assert panel_bg.lower() not in ("#ffffff", "#fffafa", "#fbfdff")
    assert len(set(color.lower() for color in palette)) == 4
    assert all(contrast(color, axis_bg) >= 3.0 for color in palette), [
        (color, contrast(color, axis_bg)) for color in palette
    ]
    assert contrast(text, axis_bg) >= 7.0
    assert contrast(muted, axis_bg) >= 4.5

    assert "def _style_dark_comparison_axis(axis):" in SOURCE
    assert "fig.patch.set_facecolor(GFS_REPORT_FIGURE_BG)" in SOURCE
    assert "axis.set_facecolor(GFS_REPORT_AXIS_BG)" in SOURCE
    assert "facecolor=GFS_REPORT_PANEL_BG" in SOURCE
    assert "labelcolor=GFS_REPORT_TEXT" in SOURCE
    assert 'facecolor": "#3A3023"' in SOURCE
    assert 'fig.patch.set_facecolor("#ffffff")' not in SOURCE
    assert 'axis.set_facecolor("#fbfdff")' not in SOURCE

    telegram_start = SOURCE.index("def create_comparison_chart(")
    telegram_end = SOURCE.index("def create_pages_comparison_charts(", telegram_start)
    telegram = SOURCE[telegram_start:telegram_end]
    assert "color=GFS_REPORT_TEXT" in telegram
    assert "labelcolor=GFS_REPORT_TEXT" in telegram

    pages_start = telegram_end
    pages_end = SOURCE.index("def _has_complete_850_wind_daily_series", pages_start)
    pages = SOURCE[pages_start:pages_end]
    assert "_style_dark_comparison_axis(axis)" in pages
    assert "fig.patch.set_facecolor(GFS_REPORT_FIGURE_BG)" in pages
    assert "color=GFS_REPORT_MUTED" in pages

    print(
        "[GFS REPORT THEME] Dark chart contrast, four-cycle palette and shared valid-time alignment passed."
    )


if __name__ == "__main__":
    main()
