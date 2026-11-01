"""Source-level and contrast smoke tests for dark GFS report charts."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "main.py").read_text(encoding="utf-8")


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


def main() -> None:
    figure_bg = constant("GFS_REPORT_FIGURE_BG")
    axis_bg = constant("GFS_REPORT_AXIS_BG")
    panel_bg = constant("GFS_REPORT_PANEL_BG")
    text = constant("GFS_REPORT_TEXT")
    muted = constant("GFS_REPORT_MUTED")
    palette_match = re.search(r'colors\s*=\s*\[([^\]]+)\]', SOURCE)
    if not palette_match:
        raise AssertionError("Four distinct GFS cycle accent colors are missing.")
    palette = re.findall(r"#[0-9A-Fa-f]{6}", palette_match.group(1))

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
        "[GFS REPORT THEME] Dark figure/axis backgrounds, readable labels, "
        "four high-contrast cycle accents and Telegram/Pages parity passed."
    )


if __name__ == "__main__":
    main()
