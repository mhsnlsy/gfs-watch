#!/usr/bin/env python3
"""Build the Köy GFS four-cycle interactive SVG from its own canonical archive.

Input:  koy-gfs-data/gfs/comparison.json
Output: koy-gfs-data/gfs/media/koy-gfs-<run>-comparison.svg

The newest Köy GFS run defines a 180-hour valid-time window. Every older cycle
is sampled only at the exact same UTC valid instants, even when its F-hour
lead differs. The SVG carries the same browser interaction metadata as the
Istanbul report, so the shared tooltip script can render it without changing
the Köy forecast data source.
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import FancyBboxPatch


TZ = ZoneInfo("Europe/Istanbul")
BG = "#0A1B29"
AX = "#102A3A"
PANEL = "#153448"
TEXT = "#FFFFFF"
MUTED = "#E7F2F6"
GRID = "#456579"
SPINE = "#416174"
LEGEND_EDGE = "#36586C"
# Stored oldest -> newest, matching the four-cycle archive order.
COLORS = ["#7DD3D7", "#8ABCE8", "#F1C98B", "#B38BE8"]
PANEL_SPECS = (
    ("temperature", "temperature_2m_c", "Sıcaklık", "°C"),
    ("temperature_850", "temperature_850hpa_c", "850 hPa sıcaklık", "°C"),
    ("precipitation", "precipitation_6h_mm", "Yağış", "mm / 6 saat"),
    ("wind_10m", "wind_speed_10m_kmh", "10 m rüzgâr hızı", "km/sa"),
)
RENDERER_VERSION = "koy-gfs-valid-time-svg-tooltip-v1"


def parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def valid_key(value: str) -> str:
    return parse_utc(value).isoformat(timespec="minutes")


def run_stamp(value: str) -> str:
    return parse_utc(value).strftime("%Y%m%dT%HZ")


def number(value):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def prepare_series(documents: list[dict]) -> tuple[list[dict], list[str]]:
    """Create the exact four-cycle UTC valid-time intersection."""
    series = []
    for document in documents:
        points_by_valid = {}
        for point in document.get("forecast_6_hourly") or []:
            raw_valid = point.get("valid_time_utc")
            if not raw_valid:
                continue
            try:
                key = valid_key(raw_valid)
            except (TypeError, ValueError):
                continue
            points_by_valid[key] = point
        if not points_by_valid:
            raise RuntimeError(
                f"{document.get('run_id_utc')} has no valid forecast timestamps."
            )

        run_time = parse_utc(document["run_id_utc"])
        local_run = run_time.astimezone(TZ)
        label = f"{run_time:%H}Z | {run_time:%d.%m %H:%M}"
        if document["run_id_utc"] == documents[-1]["run_id_utc"]:
            label = "YENİ · " + label
        series.append({
            "document": document,
            "label": label,
            "points": points_by_valid,
        })

    common = set(series[-1]["points"])
    for item in series[:-1]:
        common.intersection_update(item["points"])
    ordered = sorted(common)
    if len(ordered) < 2:
        raise RuntimeError("Four Köy GFS runs have fewer than two common valid times.")

    # The newest run defines a 180-hour span. Older cycles are not clipped by
    # their own lead-hour numbers; they are read by exact UTC valid timestamp.
    start = parse_utc(ordered[0])
    end = start + timedelta(hours=180)
    selected = [
        key for key in ordered
        if start <= parse_utc(key) <= end
    ]
    if len(selected) < 2:
        raise RuntimeError("The common Köy GFS timeline has fewer than two points in 180h.")

    return series, selected


def value_for(item: dict, key: str, field: str):
    point = item["points"].get(key) or {}
    return number(point.get(field))


def label_time(key: str) -> str:
    # MeteoPT reference clock: display raw GFS UTC valid time without +3 conversion.
    return parse_utc(key).strftime("%d")


def render_svg(series: list[dict], valid_keys: list[str], comparison: dict) -> bytes:
    latest = series[-1]
    first_valid = parse_utc(valid_keys[0])
    x_values = [
        (parse_utc(key) - first_valid).total_seconds() / 3600.0
        for key in valid_keys
    ]
    tick_indices = [
        index for index, hour in enumerate(x_values)
        if index == 0 or abs(hour % 12.0) < 0.01
    ]
    if tick_indices[-1] != len(x_values) - 1:
        tick_indices.append(len(x_values) - 1)
    tick_labels = [label_time(valid_keys[index]) for index in tick_indices]

    location = comparison.get("location") or {}
    location_name = str(location.get("name") or "Giresun / Çanakçı").replace(" / ", " ")
    heading = "GFS · " + location_name.upper()
    source_name = str((series[-1]["document"].get("source") or "MeteoPT GFS")).strip()
    footer_source = f"Kaynak: Köy GFS · {source_name} · {location.get('name') or 'Giresun / Çanakçı'} nokta tahmini"
    stable_date = str(
        comparison.get("updated_at_utc")
        or series[-1]["document"].get("published_at_utc")
        or series[-1]["document"]["run_id_utc"]
    )

    fig = None
    try:
        # Keep SVG element IDs stable across the five-minute publisher checks.
        with plt.rc_context({"svg.hashsalt": "koy-gfs-interactive-report"}):
            fig, axes = plt.subplots(2, 2, figsize=(16, 11.6333333333))
            fig.patch.set_facecolor(BG)
            fig.text(
                0.055, 0.965, heading,
                fontsize=12, fontweight="bold", color="#7DD3D7",
                ha="left", va="top",
            )
            fig.text(
                0.055, 0.925, "Son GFS raporu · 4'lü döngü karşılaştırması",
                fontsize=22, fontweight="bold", color=TEXT,
                ha="left", va="top",
            )
            fig.text(
                0.055, 0.885,
                "Dört Köy GFS çıktısı aynı geçerlilik saatlerinde (TSİ) üst üste karşılaştırılır.",
                fontsize=12.5, color=MUTED, ha="left", va="top",
            )
            fig.text(
                0.945, 0.958, f"{len(series)} GFS döngüsü karşılaştırılıyor",
                fontsize=10.5, color="#B8D7DF", ha="right", va="top",
                bbox={
                    "boxstyle": "round,pad=0.65",
                    "facecolor": BG,
                    "edgecolor": SPINE,
                    "linewidth": 1.0,
                },
            )

            legend_handles = []
            for index in reversed(range(len(series))):
                legend_handles.append(Line2D(
                    [], [],
                    color=COLORS[index],
                    linewidth=3.2 if index == len(series) - 1 else 1.8,
                    linestyle="-" if index == len(series) - 1 else (0, (4, 3)),
                    label=series[index]["label"],
                ))
            fig.legend(
                handles=legend_handles,
                loc="upper center",
                bbox_to_anchor=(0.5, 0.835),
                ncol=2,
                fontsize=10.5,
                frameon=True,
                facecolor=PANEL,
                edgecolor=LEGEND_EDGE,
                framealpha=0.98,
                labelcolor=TEXT,
                borderpad=0.75,
                handlelength=2.4,
                columnspacing=2.8,
                labelspacing=0.75,
                handletextpad=0.8,
            )
            fig.subplots_adjust(
                left=0.045, right=0.955, bottom=0.085, top=0.707,
                wspace=0.18, hspace=0.36,
            )

            panel_metadata = []
            for panel_index, (axis, spec) in enumerate(zip(axes.flat, PANEL_SPECS)):
                panel_id, field, title, unit = spec
                axis.set_facecolor(AX)
                axis.set_zorder(1)
                axis.set_title(
                    title, loc="left", fontsize=17,
                    fontweight="bold", color=TEXT, pad=15,
                )
                axis.set_ylabel(
                    unit, fontsize=11.5, fontweight="bold",
                    color=TEXT, labelpad=8,
                )
                axis.grid(
                    axis="y", color=GRID,
                    linestyle=(0, (2, 4)), alpha=0.55, linewidth=0.8,
                )
                axis.set_axisbelow(True)
                axis.tick_params(
                    axis="both", which="major", colors=MUTED,
                    labelcolor=MUTED, labelsize=10.5,
                    width=0.8, length=3, pad=6,
                )
                for spine in axis.spines.values():
                    spine.set_color(SPINE)
                    spine.set_linewidth(0.9)

                all_values = []
                for index, item in enumerate(series):
                    values = [value_for(item, key, field) for key in valid_keys]
                    y_values = [math.nan if value is None else value for value in values]
                    all_values.extend(value for value in values if value is not None)
                    is_latest = index == len(series) - 1
                    axis.plot(
                        x_values,
                        y_values,
                        color=COLORS[index],
                        linewidth=3.2 if is_latest else 1.8,
                        linestyle="-" if is_latest else (0, (4, 3)),
                        marker="o" if is_latest else None,
                        markersize=3.0 if is_latest else 0,
                        markeredgewidth=0,
                        solid_capstyle="round",
                        solid_joinstyle="round",
                        zorder=5 if is_latest else 3,
                    )

                if not all_values:
                    axis.text(
                        0.5, 0.5, "Bu değişken için veri yok",
                        transform=axis.transAxes, ha="center", va="center",
                        fontsize=11, color=MUTED,
                    )
                elif field in ("temperature_2m_c", "temperature_850hpa_c"):
                    low, high = min(all_values), max(all_values)
                    span = high - low
                    if span < 4:
                        center = (low + high) / 2
                        low, high = center - 2, center + 2
                    else:
                        margin = max(0.5, span * 0.08)
                        low, high = low - margin, high + margin
                    axis.set_ylim(low, high)
                else:
                    high = max(all_values)
                    axis.set_ylim(0, max(1.0, high * 1.18))

                axis.set_xlim(
                    min(x_values) - 1.0,
                    max(x_values) + max(1.0, (max(x_values) - min(x_values)) * 0.015),
                )
                axis.set_xticks([x_values[index] for index in tick_indices])
                axis.set_xticklabels(
                    tick_labels, fontsize=10, color=MUTED,
                    fontweight="semibold",
                )
                axis.margins(x=0.01)

                # Exact SVG coordinates support the shared browser tooltip.
                axis_meta = axis.get_window_extent()
                scale = 72.0 / fig.dpi
                canvas_height_px = fig.get_figheight() * fig.dpi

                def to_svg_point(display_x, display_y):
                    return (
                        round(display_x * scale, 3),
                        round((canvas_height_px - display_y) * scale, 3),
                    )

                plot_x = round(axis_meta.x0 * scale, 3)
                plot_y = round((canvas_height_px - axis_meta.y1) * scale, 3)
                plot_width = round(axis_meta.width * scale, 3)
                plot_height = round(axis_meta.height * scale, 3)
                x_positions = []
                for x_value in x_values:
                    display_x, display_y = axis.transData.transform(
                        (x_value, axis.get_ylim()[0])
                    )
                    svg_x, _ = to_svg_point(display_x, display_y)
                    x_positions.append(svg_x)

                panel_series = []
                for index, item in enumerate(series):
                    values = []
                    y_positions = []
                    leads = []
                    directions = []
                    for point_index, key in enumerate(valid_keys):
                        point = item["points"].get(key) or {}
                        value = value_for(item, key, field)
                        values.append(value)
                        lead = point.get("forecast_hour")
                        try:
                            lead = int(lead) if lead is not None else None
                        except (TypeError, ValueError):
                            lead = None
                        leads.append(lead)
                        raw_direction = point.get("wind_direction_10m_deg")
                        direction = number(raw_direction) if field == "wind_speed_10m_kmh" else None
                        directions.append(direction)
                        if value is None:
                            y_positions.append(None)
                        else:
                            display_x, display_y = axis.transData.transform(
                                (x_values[point_index], value)
                            )
                            _, svg_y = to_svg_point(display_x, display_y)
                            y_positions.append(svg_y)
                    panel_series.append({
                        "label": item["label"],
                        "color": COLORS[index],
                        "lead_hours": leads,
                        "values": values,
                        "y_positions": y_positions,
                        "directions_deg": directions,
                    })

                valid_time_records = []
                for key in valid_keys:
                    valid_time_records.append({
                        "local_key": parse_utc(key).strftime("%Y-%m-%dT%H:%M"),
                        "label": parse_utc(key).strftime("%d.%m.%Y %H:%M") + " TSİ",
                        "utc_label": parse_utc(key).strftime("%Y-%m-%d %H:%M UTC"),
                    })

                panel_metadata.append({
                    "id": panel_id,
                    "title": title,
                    "unit": unit,
                    "plot": {
                        "x": plot_x, "y": plot_y,
                        "width": plot_width, "height": plot_height,
                    },
                    "x_positions": x_positions,
                    "valid_times": valid_time_records,
                    "series": panel_series,
                })

            # Same rounded panel borders as the Istanbul SVG report.
            for axis in axes.flat:
                position = axis.get_position()
                card = FancyBboxPatch(
                    (position.x0 - 0.018, position.y0 - 0.035),
                    position.width + 0.036,
                    position.height + 0.075,
                    boxstyle="round,pad=0.004,rounding_size=0.014",
                    transform=fig.transFigure,
                    facecolor=AX,
                    edgecolor=SPINE,
                    linewidth=1.0,
                    zorder=0,
                )
                fig.add_artist(card)
                axis.set_facecolor("none")
                axis.set_zorder(1)

            fig.text(
                0.055, 0.025,
                f"Aynı geçerlilik saatleri (TSİ) · {len(valid_keys)} ortak nokta",
                fontsize=9.5, color=MUTED, ha="left",
            )
            fig.text(
                0.945, 0.025, footer_source,
                fontsize=9.5, color=MUTED, ha="right",
            )

            fig.canvas.draw()
            metadata = {"version": 1, "panels": panel_metadata}
            metadata_json = json.dumps(
                metadata, ensure_ascii=False, separators=(",", ":")
            ).replace("]]>", "]]\\u003e")
            interaction_parts = [
                '<metadata id="gfs-interactive-data"><![CDATA[' + metadata_json + ']]></metadata>',
                '<g id="gfs-interaction-layer">',
            ]
            for panel in panel_metadata:
                plot = panel["plot"]
                x_start = panel["x_positions"][0]
                x_end = panel["x_positions"][-1]
                interaction_parts.append(
                    '<g class="gfs-panel-interaction" data-panel-id="' + panel["id"] + '">'
                    '<rect class="gfs-hit-area" data-panel-id="' + panel["id"] + '" '
                    'x="' + str(plot["x"]) + '" y="' + str(plot["y"]) + '" '
                    'width="' + str(plot["width"]) + '" height="' + str(plot["height"]) + '" '
                    'fill="transparent" pointer-events="all" tabindex="0" role="group" '
                    'aria-label="' + panel["title"] + ' grafiği; ok tuşlarıyla geçerlilik saatleri arasında gezinin"/>'
                    '<line class="gfs-tooltip-crosshair" x1="' + str(x_start) + '" '
                    'x2="' + str(x_start) + '" y1="' + str(plot["y"]) + '" '
                    'y2="' + str(plot["y"] + plot["height"]) + '" '
                    'stroke="#EAF5F8" stroke-width="1.1" stroke-dasharray="4 4" '
                    'opacity=".78" visibility="hidden" pointer-events="none"/>'
                    '<g class="gfs-tooltip-markers" pointer-events="none"></g>'
                    '</g>'
                )
            interaction_parts.append("</g>")

            svg_buffer = __import__("io").BytesIO()
            title = f"Köy GFS · {location_name} · Dört döngü valid-time karşılaştırması"
            fig.savefig(
                svg_buffer,
                format="svg",
                bbox_inches=None,
                transparent=True,
                facecolor="none",
                edgecolor="none",
                metadata={
                    "Title": title,
                    "Description": "Dört Köy GFS çıktısı aynı UTC geçerlilik saatlerinde hizalanmıştır.",
                    "Date": parse_utc(stable_date),
                },
            )
            svg_text = svg_buffer.getvalue().decode("utf-8")
            if "</svg>" not in svg_text:
                raise RuntimeError("Matplotlib SVG output has no closing element.")
            svg_text = svg_text.replace(
                "</svg>", "".join(interaction_parts) + "</svg>", 1
            )
            return svg_text.encode("utf-8")
    finally:
        if fig is not None:
            plt.close(fig)


def write_atomic(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name("." + path.name + ".tmp")
    temporary.write_bytes(content)
    os.replace(temporary, path)


def main() -> None:
    root = Path(os.environ.get("KOY_GFS_DIR", "gfs")).resolve()
    comparison_path = root / "comparison.json"
    if not comparison_path.is_file():
        raise SystemExit(f"Köy GFS comparison missing: {comparison_path}")
    comparison = json.loads(comparison_path.read_text(encoding="utf-8"))
    if comparison.get("schema") != "koy-gfs.comparison.v1":
        raise SystemExit("Unexpected Köy GFS comparison schema.")

    documents = [
        item for item in comparison.get("runs", [])
        if item.get("forecast_source") == "meteopt"
        and isinstance(item.get("forecast_6_hourly"), list)
    ]
    documents.sort(key=lambda item: parse_utc(item["run_id_utc"]))
    documents = documents[-4:]
    if len(documents) < 4:
        print(
            f"[KOY GFS SVG] Four complete Köy GFS cycles are not available yet "
            f"({len(documents)}/4); retaining the previous report."
        )
        return

    series, valid_keys = prepare_series(documents)
    svg_bytes = render_svg(series, valid_keys, comparison)
    latest_document = documents[-1]
    stamp = run_stamp(latest_document["run_id_utc"])
    media = root / "media"
    media.mkdir(parents=True, exist_ok=True)
    output = media / f"koy-gfs-{stamp}-comparison.svg"
    version_file = media / ".koy-svg-renderer-version"

    changed = False
    if not output.is_file() or output.read_bytes() != svg_bytes:
        write_atomic(output, svg_bytes)
        changed = True
    if not version_file.is_file() or version_file.read_text(encoding="utf-8").strip() != RENDERER_VERSION:
        write_atomic(version_file, (RENDERER_VERSION + "\n").encode("utf-8"))
        changed = True

    print(
        f"[KOY GFS INTERACTIVE SVG] run={latest_document['run_id_utc']}; "
        f"cycles={len(series)}; common_valid_times={len(valid_keys)}; "
        f"source=Köy GFS / {latest_document.get('source', 'MeteoPT GFS')}; "
        f"svg={output.as_posix()}; changed={int(changed)}"
    )


if __name__ == "__main__":
    main()
