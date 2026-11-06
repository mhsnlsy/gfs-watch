"""Fetch one ready Istanbul MeteoPT GFS cycle for the GitHub Actions publisher.

The workflow polls every 5 minutes. It probes all four cycle hours and
publishes the F72 milestone as soon as it is ready. It then publishes the
canonical report only after F180 is ready. No Cloudflare calls are made here.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

LAT = 41.014
LON = 28.950
API = "https://api.meteopt.com/gfs/json"
UTC = timezone.utc
ISTANBUL = timezone(timedelta(hours=3))
ROOT = Path.cwd()
GFS_DIR = ROOT / "gfs"


def run_datetime(value: object) -> datetime:
    raw = str(value or "").strip()
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) < 10:
        raise ValueError(f"Invalid MeteoPT run identifier: {raw!r}")
    return datetime.strptime(digits[:10], "%Y%m%d%H").replace(tzinfo=UTC)


def fetch_cycle(hour: int) -> tuple[dict, str]:
    params = {
        "lat": str(LAT),
        "lon": str(LON),
        "run": f"{hour:02d}",
        "lang": "en",
        "_cache_bust": str(int(datetime.now(UTC).timestamp())),
    }
    url = API + "?" + urlencode(params)
    request = Request(
        url,
        headers={
            "User-Agent": "Istanbul-GFS-GitHubActions/1.0",
            "Cache-Control": "no-cache",
        },
    )
    with urlopen(request, timeout=45) as response:
        if response.status != 200:
            raise RuntimeError(f"MeteoPT HTTP {response.status} for {hour:02d}Z")
        document = json.load(response)
    if not isinstance(document, dict):
        raise RuntimeError(f"MeteoPT returned an invalid document for {hour:02d}Z")
    return document, url


def number(values: list, index: int):
    try:
        value = float(values[index])
    except (IndexError, TypeError, ValueError):
        return None
    return value if value == value and abs(value) != float("inf") else None


def values_for(document: dict, name: str) -> list:
    series = ((document.get("data") or {}).get(name) or {}).get("values") or []
    return series if isinstance(series, list) else []


def normalize(document: dict, source_url: str, cycle: datetime, require_f180: bool = True) -> dict:
    raw_steps = ((document.get("steps") or {}).get("values") or [])
    steps = []
    for value in raw_steps:
        try:
            step = int(float(value))
        except (TypeError, ValueError):
            continue
        if step >= 0:
            steps.append(step)

    if require_f180 and 180 not in steps:
        raise RuntimeError("F180 gate failed during normalization")

    names = {
        "tmp2m": "temperature_2m_c",
        "tmp850mb": "temperature_850hpa_c",
        "wind10m": "wind_speed_10m_kmh",
        "winddir10m": "wind_direction_10m_deg",
        "wind850": "wind_speed_850hpa_kmh",
        "apcp": "precipitation_6h_mm",
    }
    series = {key: values_for(document, key) for key in names}
    points = []
    for index, lead in enumerate(steps):
        if lead <= 0:
            continue
        valid = cycle + timedelta(hours=lead)
        point = {
            "forecast_hour": lead,
            "valid_time_utc": valid.isoformat(timespec="minutes"),
            "valid_time_istanbul": valid.astimezone(ISTANBUL).isoformat(timespec="minutes"),
        }
        for source_key, output_key in names.items():
            point[output_key] = number(series[source_key], index)
        points.append(point)

    by_day: dict[str, list[dict]] = {}
    for point in points:
        by_day.setdefault(point["valid_time_istanbul"][:10], []).append(point)

    def valid_values(day_points: list[dict], key: str) -> list[float]:
        return [
            float(point[key])
            for point in day_points
            if point.get(key) is not None
        ]

    daily = []
    for day, day_points in sorted(by_day.items()):
        temps = valid_values(day_points, "temperature_2m_c")
        temps850 = valid_values(day_points, "temperature_850hpa_c")
        rain = valid_values(day_points, "precipitation_6h_mm")
        wind = valid_values(day_points, "wind_speed_10m_kmh")
        wind850 = valid_values(day_points, "wind_speed_850hpa_kmh")
        daily.append({
            "date_istanbul": day,
            "temperature_min_c": min(temps) if temps else None,
            "temperature_max_c": max(temps) if temps else None,
            "temperature_850hpa_min_c": min(temps850) if temps850 else None,
            "temperature_850hpa_max_c": max(temps850) if temps850 else None,
            "precipitation_total_mm": sum(max(0.0, x) for x in rain),
            "wind_speed_max_10m_kmh": max(wind) if wind else None,
            "wind_speed_max_850hpa_kmh": max(wind850) if wind850 else None,
        })

    first = points[0] if points else {}
    return {
        "schema": "gfs-watch.forecast.v1",
        "model": "ncep_gfs_global",
        "forecast_source": "meteopt",
        "run_id_utc": cycle.isoformat(timespec="seconds"),
        "published_at_utc": datetime.now(UTC).isoformat(timespec="seconds"),
        "location": {
            "name": "Istanbul",
            "latitude": LAT,
            "longitude": LON,
            "nearest_gfs_grid_latitude": 41.0,
            "nearest_gfs_grid_longitude": 29.0,
        },
        "sources": {
            "forecast": "MeteoPT GFS point forecast (Istanbul, TR)",
            "forecast_url": source_url,
        },
        "f72": {
            "available": 72 in steps,
            "forecast_hour": 72,
            "source": "MeteoPT",
        },
        "f180": {
            "available": 180 in steps,
            "forecast_hour": 180,
            "source": "MeteoPT",
        },
        "noaa_source_file": {
            "f72_available": 72 in steps,
            "f72_source_name": "MeteoPT" if 72 in steps else None,
            "f180_available": 180 in steps,
            "f180_source_name": "MeteoPT" if 180 in steps else None,
            "f180_source_url": API,
        },
        "current_conditions": {
            "temperature_2m_c": first.get("temperature_2m_c"),
            "precipitation_mm": first.get("precipitation_6h_mm"),
            "wind_speed_10m_kmh": first.get("wind_speed_10m_kmh"),
            "mean_sea_level_pressure_hpa": None,
        },
        "daily_summary": daily,
        "forecast_6_hourly": points,
        "forecast_horizon_hours": max(steps) if steps else 0,
        "forecast_valid_until_utc": points[-1]["valid_time_utc"] if points else None,
    }


def write_output(name: str, value: str) -> None:
    output = os.getenv("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def main() -> None:
    GFS_DIR.mkdir(parents=True, exist_ok=True)
    (GFS_DIR / "runs").mkdir(parents=True, exist_ok=True)
    (GFS_DIR / "notifications" / "telegram-sent").mkdir(parents=True, exist_ok=True)

    candidates = []
    for hour in (18, 12, 6, 0):
        try:
            document, url = fetch_cycle(hour)
            cycle = run_datetime(document.get("run"))
            if cycle.hour != hour:
                print(
                    f"[GFS] Requested {hour:02d}Z but MeteoPT returned "
                    f"{cycle.isoformat()}; ignoring mismatched cycle."
                )
                continue
            steps = []
            for value in ((document.get("steps") or {}).get("values") or []):
                try:
                    steps.append(int(float(value)))
                except (TypeError, ValueError):
                    pass
            has_f72 = 72 in steps
            has_f180 = 180 in steps
            print(
                f"[GFS] {cycle.isoformat()} · F72={str(has_f72).lower()} "
                f"· F180={str(has_f180).lower()} · horizon={max(steps) if steps else 0}h"
            )
            candidates.append((cycle, document, url, steps))
        except Exception as exc:
            print(f"[GFS] {hour:02d}Z check failed: {exc}")

    if not candidates:
        print("[GFS] No usable MeteoPT cycle returned.")
        write_output("publish", "false")
        write_output("f72_publish", "false")
        write_output("reason", "no_usable_cycle")
        return

    candidates.sort(key=lambda item: item[0], reverse=True)
    cycle, document, url, steps = candidates[0]
    run_id = cycle.isoformat(timespec="seconds")
    run_file = GFS_DIR / "runs" / f"{run_id}.json"
    f72_marker = GFS_DIR / "milestones" / "f72" / f"{run_id}.json"
    telegram_marker = GFS_DIR / "notifications" / "telegram-sent" / f"{run_id}.json"

    # Like the Köy workflow: F72 is an independently published milestone,
    # not a substitute for the full F180 report/Telegram release.
    f72_publish = 72 in steps and not f72_marker.exists()
    if f72_publish:
        normalized72 = normalize(document, url, cycle, require_f180=False)
        normalized72["forecast_6_hourly"] = [
            point for point in normalized72["forecast_6_hourly"]
            if point.get("forecast_hour", 0) <= 72
        ]
        normalized72["forecast_horizon_hours"] = 72
        normalized72["milestone"] = "F72"
        f72_marker.parent.mkdir(parents=True, exist_ok=True)
        f72_marker.write_text(
            json.dumps(normalized72, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"[GFS] New F72 milestone saved for {run_id}.")

    # F180 publication is deduplicated by the canonical sent marker, matching
    # the milestone-based Köy pipeline. The F72 marker never blocks F180.
    publish = 180 in steps and not telegram_marker.exists()
    if publish:
        normalized = normalize(document, url, cycle, require_f180=True)
        temporary = run_file.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(normalized, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary.replace(run_file)
        print(
            f"[GFS] Selected {run_id}; F180=true; "
            f"points={len(normalized['forecast_6_hourly'])}."
        )
    else:
        print(
            f"[GFS] No new F180 publication for {run_id}; "
            f"F72 milestone={'new' if f72_publish else 'already published/not ready'}."
        )

    write_output("publish", "true" if publish else "false")
    write_output("f72_publish", "true" if f72_publish else "false")
    write_output("reason", "new_f180_cycle" if publish else ("new_f72_milestone" if f72_publish else "no_new_milestone"))
    write_output("run_id", run_id)


if __name__ == "__main__":
    main()
