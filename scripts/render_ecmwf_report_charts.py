"""Four ECMWF comparison PNGs: temperature and wind candles, rain as a 3-hour line."""
from __future__ import annotations

import math
from datetime import datetime
from zoneinfo import ZoneInfo

import matplotlib
matplotlib.use("Agg")
import matplotlib.patheffects as patheffects
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Rectangle

ISTANBUL = ZoneInfo("Europe/Istanbul")
COLORS = ["#55D6D2", "#7EB8FF", "#FFC66D", "#C3A5FF"]
FIGURE_BG = "#0A1B29"
AXIS_BG = "#102A3A"
PANEL_BG = "#153448"
TEXT = "#FFFFFF"
MUTED = "#E7F2F6"
GRID = "#456579"
SPINE = "#416174"


def _stamp(value: str) -> datetime:
    text = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ISTANBUL)
    return parsed


def _label(run_id: str, newest: bool) -> str:
    stamp = _stamp(run_id)
    local = stamp.astimezone(ISTANBUL)
    text = f"{stamp:%H}Z | {local:%d.%m %H:%M} TSİ"
    return ("YENİ · " + text) if newest else text


def _points(run: dict) -> list[dict]:
    rows = []
    for point in run.get("forecast_6_hourly") or []:
        if not isinstance(point, dict) or not point.get("valid_time_utc"):
            continue
        rows.append(point)
    rows.sort(key=lambda item: item["valid_time_utc"])
    return rows


def _day(point: dict) -> str:
    raw = point.get("valid_time_istanbul") or point.get("valid_time_utc")
    return _stamp(raw).astimezone(ISTANBUL).strftime("%Y-%m-%d")


def _number(point: dict, key: str):
    value = point.get(key)
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def _style(axis):
    axis.set_facecolor(AXIS_BG)
    axis.set_axisbelow(True)
    axis.tick_params(colors=MUTED, labelcolor=MUTED, width=0.9, length=3)
    axis.xaxis.label.set_color(TEXT)
    axis.yaxis.label.set_color(TEXT)
    axis.title.set_color(TEXT)
    for spine in axis.spines.values():
        spine.set_color(SPINE)
        spine.set_linewidth(0.9)
    axis.grid(axis="y", color=GRID, alpha=0.42, linewidth=0.9)


def _cardinal(direction_deg: float) -> str:
    names = ("K", "KD", "D", "GD", "G", "GB", "B", "KB")
    return names[int((float(direction_deg) + 22.5) % 360.0 // 45)]


def _direction_marker(axis, x, y, direction_deg):
    radians = math.radians(float(direction_deg))
    length = 12.0
    downwind_x = -math.sin(radians) * length
    downwind_y = -math.cos(radians) * length
    for color, width, scale, order in (("#041018", 3.4, 16, 6), ("#FFFFFF", 1.7, 13, 7)):
        axis.annotate(
            "",
            xy=(x, y),
            xytext=(-downwind_x, -downwind_y),
            textcoords="offset points",
            arrowprops={
                "arrowstyle": "-|>",
                "color": color,
                "lw": width,
                "mutation_scale": scale,
                "shrinkA": 0,
                "shrinkB": 0,
            },
            zorder=order,
            annotation_clip=False,
        )
    label = axis.annotate(
        _cardinal(direction_deg),
        xy=(x, y),
        xytext=(0, 18),
        textcoords="offset points",
        ha="center",
        va="bottom",
        fontsize=9,
        fontweight="bold",
        color="#FFFFFF",
        zorder=8,
        annotation_clip=False,
    )
    label.set_path_effects([patheffects.withStroke(linewidth=2.6, foreground="#041018")])


def _daily_ohlc(points: list[dict], key: str, direction_key: str | None = None):
    buckets: dict[str, list[dict]] = {}
    for point in points:
        value = _number(point, key)
        if value is None:
            continue
        buckets.setdefault(_day(point), []).append(point)
    series = {}
    for day, rows in buckets.items():
        values = [_number(row, key) for row in rows]
        values = [value for value in values if value is not None]
        if not values:
            continue
        direction = None
        if direction_key:
            best = None
            for row in rows:
                speed = _number(row, key)
                bearing = _number(row, direction_key)
                if speed is None or bearing is None:
                    continue
                if best is None or speed > best[0]:
                    best = (speed, bearing)
            if best:
                direction = best[1]
        series[day] = (values[0], values[-1], max(values), min(values), direction)
    return series


def _draw_candles(axis, runs, key, ylabel, direction_key=None):
    maps = [_daily_ohlc(_points(run), key, direction_key) for run in runs]
    common = set(maps[0])
    for item in maps[1:]:
        common &= set(item)
    days = sorted(common)
    count = len(runs)
    group = min(0.20, 0.80 / max(count, 1))
    width = group * 0.72
    offsets = [(index - (count - 1) / 2) * group for index in range(count)]
    for series_index, values_by_day in enumerate(maps):
        color = COLORS[series_index % len(COLORS)]
        for index, day in enumerate(days):
            open_value, close_value, high_value, low_value, direction = values_by_day[day]
            x = index + offsets[series_index]
            axis.vlines(x, low_value, high_value, color=color, linewidth=1.6, zorder=2)
            body_bottom = min(open_value, close_value)
            body_height = max(abs(close_value - open_value), 0.12)
            axis.add_patch(Rectangle(
                (x - width / 2, body_bottom),
                width,
                body_height,
                facecolor=color,
                edgecolor=color,
                alpha=0.82,
                zorder=3,
            ))
            if direction is not None:
                _direction_marker(axis, x, high_value, direction)
    axis.set_xlim(-0.5, max(0.5, len(days) - 0.5))
    axis.set_xticks(list(range(len(days))))
    names = ("Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz")
    labels = []
    for day in days:
        date_value = datetime.strptime(day, "%Y-%m-%d")
        labels.append(f"{date_value:%d.%m}\n{names[date_value.weekday()]}")
    axis.set_xticklabels(labels, fontsize=11, color=TEXT)
    axis.set_ylabel(ylabel, fontsize=14, fontweight="bold", color=TEXT)
    if direction_key:
        low, high = axis.get_ylim()
        axis.set_ylim(0, max(high, 1) * 1.28)
    return days


def _draw_rain(axis, runs):
    maps = []
    for run in runs:
        points = {}
        for point in _points(run):
            amount = _number(point, "precipitation_6h_mm")
            if amount is None:
                amount = _number(point, "precipitation_interval_mm")
            if amount is None:
                continue
            points[point["valid_time_utc"]] = max(0.0, amount)
        maps.append(points)
    common = set(maps[0])
    for item in maps[1:]:
        common &= set(item)
    times = sorted(common)
    if len(times) < 2:
        axis.set_ylabel("mm / 3 saat", fontsize=14, fontweight="bold", color=TEXT)
        return
    xs = list(range(len(times)))
    for series_index, points in enumerate(maps):
        color = COLORS[series_index % len(COLORS)]
        ys = [points[key] for key in times]
        axis.plot(xs, ys, color=color, linewidth=2.2, marker="o", markersize=3.2)
    axis.set_ylim(bottom=0)
    axis.set_xlim(-0.5, len(times) - 0.5)
    import matplotlib.ticker as ticker
    axis.yaxis.set_major_locator(ticker.MultipleLocator(1))
    axis.xaxis.set_minor_locator(ticker.MultipleLocator(1))
    axis.grid(which="major", axis="y", color=GRID, alpha=0.5, linewidth=0.8)
    axis.grid(which="minor", axis="x", color=GRID, alpha=0.38, linewidth=0.6)
    axis.tick_params(axis="x", which="minor", length=0)
    step = 8 if len(times) > 24 else 4
    tick_index = list(range(0, len(times), step))
    if tick_index[-1] != len(times) - 1:
        tick_index.append(len(times) - 1)
    labels = []
    for index in tick_index:
        stamp = _stamp(times[index]).astimezone(ISTANBUL)
        labels.append(f"{stamp:%d.%m}\n{stamp:%H:%M}")
    axis.set_xticks(tick_index)
    axis.set_xticklabels(labels, fontsize=10, color=TEXT)
    axis.set_ylabel("mm / 3 saat", fontsize=14, fontweight="bold", color=TEXT)
    axis.set_xlabel("İstanbul yerel saati · 3 saat", fontsize=11, color=TEXT)


def render_ecmwf_report_charts(runs: list[dict], output_dir) -> list[dict]:
    """Write the four comparison PNGs and return their page metadata."""
    from pathlib import Path

    usable = [run for run in runs if _points(run)]
    usable.sort(key=lambda run: run.get("run_id_utc") or "")
    usable = usable[-4:]
    if len(usable) < 2:
        print("[ECMWF PNG] Karşılaştırma için en az iki çıktı yok; görsel yazılmadı.")
        return []
    newest = usable[-1].get("run_id_utc")
    for run in usable:
        run["label"] = _label(run.get("run_id_utc") or "", run.get("run_id_utc") == newest)
    media = Path(output_dir) / "media"
    media.mkdir(parents=True, exist_ok=True)
    specs = (
        ("temperature", "2 m sıcaklık", "Sıcaklık · 2 m", "Günlük mum: ilk–son, fitil min–maks", "°C", "temperature_2m_c", None),
        ("temperature-850", "850 hPa sıcaklık", "Sıcaklık · 850 hPa", "Günlük mum: ilk–son, fitil min–maks", "°C", "temperature_850hpa_c", None),
        ("precipitation", "yağış", "Yağış", "3 saatlik yağış · çizgi", "mm", None, None),
        ("wind", "rüzgar", "Rüzgâr · 10 m", "Günlük mum: hız, ok gittiği yön, harf geldiği yön", "km/sa", "wind_speed_10m_kmh", "wind_direction_10m_deg"),
    )
    images = []
    plt.rcParams.update({
        "text.color": TEXT,
        "axes.labelcolor": TEXT,
        "axes.titlecolor": TEXT,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "figure.facecolor": FIGURE_BG,
        "axes.facecolor": AXIS_BG,
        "savefig.facecolor": FIGURE_BG,
    })
    handles = [
        Line2D([0], [0], color=COLORS[index % len(COLORS)], linewidth=5, label=run["label"])
        for index, run in enumerate(usable)
    ]
    for slug, _kind, label, title, ylabel, key, direction_key in specs:
        fig, axis = plt.subplots(1, 1, figsize=(16, 7))
        try:
            fig.patch.set_facecolor(FIGURE_BG)
            fig.suptitle(
                f"İSTANBUL ECMWF | {label.upper()} · SON {len(usable)} DÖNGÜ",
                fontsize=20, fontweight="bold", y=0.97, color=TEXT,
            )
            if slug == "precipitation":
                _draw_rain(axis, usable)
            else:
                _draw_candles(axis, usable, key, ylabel, direction_key)
            _style(axis)
            axis.set_ylabel(ylabel, fontsize=14, fontweight="bold", color=TEXT)
            fig.text(0.085, 0.675, title, ha="left", va="bottom", fontsize=18, fontweight="bold", color=TEXT)
            fig.legend(
                handles=handles, loc="upper center", bbox_to_anchor=(0.5, 0.925),
                ncol=2, fontsize=12, frameon=True, facecolor=PANEL_BG,
                edgecolor=SPINE, framealpha=0.98, labelcolor=TEXT,
            )
            fig.text(
                0.01, 0.012,
                "Renkler her panelde aynı ECMWF döngüsünü gösterir | Kaynak: MeteoPT ECMWF",
                fontsize=10.5, color=MUTED,
            )
            fig.subplots_adjust(left=0.085, right=0.985, bottom=0.16, top=0.60)
            path = media / f"ecmwf-{slug}.png"
            fig.savefig(path, format="png", dpi=140, facecolor=FIGURE_BG)
            images.append({"label": label, "path": f"media/{path.name}"})
            print(f"[ECMWF PNG] {path.name}")
        finally:
            plt.close(fig)
    return images
