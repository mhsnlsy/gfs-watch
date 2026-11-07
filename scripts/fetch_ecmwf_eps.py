"""Build the Istanbul ECMWF forecast exclusively from the MeteoPT point API.

MeteoPT is the single ECMWF source for this application. The point series
provides 2 m temperature, 10 m wind, precipitation, 850 hPa fields and MSLP;
no ECMWF Open Data GRIB2 download or secondary ECMWF source is used.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ISTANBUL_TZ = ZoneInfo("Europe/Istanbul")
LATITUDE = 41.0901
LONGITUDE = 28.9436
MAX_FORECAST_HOUR = 180
SCHEMA = "gfs-watch.ecmwf-eps.v1"
SOURCE_URL = "https://www.meteopt.com/modelos/ecmwf?lat=41.0901&lon=28.9436"
LICENSE_URL = "https://www.meteopt.com/modelos/ecmwf"


def forecast_steps(max_hour: int = MAX_FORECAST_HOUR) -> list[int]:
    """MeteoPT ECMWF 00/12Z steps: 3-hourly through 144h, then 6-hourly."""
    return list(range(0, min(max_hour, 144) + 1, 3)) + (
        list(range(150, max_hour + 1, 6)) if max_hour >= 150 else []
    )


def same_published_cycle(existing_run_id: str | None, candidate_run_id: str) -> bool:
    """Compare ECMWF cycle identifiers independently of timezone spelling."""
    if not existing_run_id:
        return False
    try:
        return _normalise_datetime(existing_run_id) == _normalise_datetime(candidate_run_id)
    except (TypeError, ValueError, OverflowError):
        return False


def _normalise_datetime(value) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value).strip().replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def _validate_meteopt_document(document: dict) -> None:
    """Validate the canonical MeteoPT ECMWF point-series contract."""
    if document.get("schema") != SCHEMA or document.get("status") != "ready":
        raise ValueError("ECMWF IFS document schema/status is invalid.")
    forecasts = document.get("forecasts")
    if not isinstance(forecasts, list) or len(forecasts) < 8:
        raise ValueError("MeteoPT ECMWF series is too short.")
    hours = [item.get("forecast_hour") for item in forecasts]
    if hours != sorted(hours) or len(set(hours)) != len(hours):
        raise ValueError("MeteoPT ECMWF steps are duplicated or out of order.")
    if any(not isinstance(hour, int) or hour <= 0 or hour % 3 != 0 for hour in hours):
        raise ValueError("MeteoPT ECMWF steps must be positive 3-hour marks.")
    for item in forecasts:
        for key in ("temperature_2m_c", "wind_speed_10m_kmh", "precipitation_interval_mm"):
            value = item.get(key)
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"MeteoPT ECMWF field is invalid: {key}.")
        if not (-80 <= item["temperature_2m_c"] <= 60):
            raise ValueError("MeteoPT ECMWF 2 m temperature is outside sanity bounds.")
        if item["wind_speed_10m_kmh"] < 0 or item["precipitation_interval_mm"] < 0:
            raise ValueError("MeteoPT ECMWF wind or precipitation cannot be negative.")
        temperature = (item.get("temperature_850hpa") or {}).get("mean_c")
        wind = (item.get("wind_850hpa") or {}).get("mean_kmh")
        pressure = (item.get("mslp") or {}).get("mean_hpa")
        if not isinstance(temperature, (int, float)) or not (-80 <= temperature <= 40):
            raise ValueError("MeteoPT ECMWF 850 hPa temperature is invalid.")
        if not isinstance(wind, (int, float)) or not (0 <= wind <= 250):
            raise ValueError("MeteoPT ECMWF 850 hPa wind is invalid.")
        if not isinstance(pressure, (int, float)) or not (900 <= pressure <= 1080):
            raise ValueError("MeteoPT ECMWF pressure is invalid.")
    timeline = document.get("forecast_6_hourly")
    if not isinstance(timeline, list) or len(timeline) != len(forecasts):
        raise ValueError("MeteoPT ECMWF timeline does not match the forecast series.")
    if not isinstance(document.get("daily_summary"), list) or not document["daily_summary"]:
        raise ValueError("MeteoPT ECMWF daily summary is missing.")
    if "meteopt.com" not in str(document.get("source_url") or ""):
        raise ValueError("MeteoPT ECMWF source URL is missing.")


def _meteopt_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _meteopt_ecmwf_candidates(limit: int = 6) -> list[datetime]:
    """Recent ECMWF 00Z and 12Z cycles, newest first."""
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    hour = 12 if now.hour >= 12 else 0
    cursor = now.replace(hour=hour)
    return [cursor - timedelta(hours=12 * offset) for offset in range(limit)]


def fetch_meteopt_ecmwf_document(run_dt: datetime) -> dict:
    """Read one ECMWF cycle from the same MeteoPT point the GFS page uses."""
    import urllib.parse
    import urllib.request

    run_dt = run_dt.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    query = urllib.parse.urlencode({
        "lat": f"{LATITUDE:.4f}",
        "lon": f"{LONGITUDE:.4f}",
        "date": run_dt.strftime("%Y%m%d"),
        "run": run_dt.strftime("%H"),
        "lang": "en",
    })
    request = urllib.request.Request(
        "https://api.meteopt.com/ecmwf/json?" + query,
        headers={"User-Agent": "GFS-Watch/1.0"},
    )
    with urllib.request.urlopen(request, timeout=40) as response:
        payload = json.loads(response.read().decode("utf-8"))
    expected = run_dt.strftime("%Y%m%d%H")
    if str(payload.get("run") or "") != expected:
        raise ValueError(f"MeteoPT ECMWF {payload.get('run') or 'boş'} döndü, istenen {expected}")
    data = payload.get("data") or {}
    steps = []
    for raw in (payload.get("steps") or {}).get("values") or []:
        try:
            hour = int(raw)
        except (TypeError, ValueError):
            continue
        if hour > 0 and hour % 3 == 0:
            steps.append(hour)
    if len(steps) < 8:
        raise ValueError(f"MeteoPT ECMWF {expected} henüz kısa: {len(steps)} satır")

    def series(name: str) -> list:
        values = (data.get(name) or {}).get("values") or []
        return values if isinstance(values, list) else []

    temperature = series("tmp2m")
    temperature_850 = series("tmp850mb")
    wind = series("wind10m")
    wind_direction = series("wind10mdir")
    wind_850 = series("wind850")
    rain = series("apcp")
    pressure = series("prmsl")
    forecasts = []
    previous = 0
    for index, hour in enumerate(steps):
        values = {
            "temp": _meteopt_number(temperature[index]) if index < len(temperature) else None,
            "temp850": _meteopt_number(temperature_850[index]) if index < len(temperature_850) else None,
            "wind": _meteopt_number(wind[index]) if index < len(wind) else None,
            "wind_dir": _meteopt_number(wind_direction[index]) if index < len(wind_direction) else None,
            "wind850": _meteopt_number(wind_850[index]) if index < len(wind_850) else None,
            "rain": _meteopt_number(rain[index]) if index < len(rain) else None,
            "pressure": _meteopt_number(pressure[index]) if index < len(pressure) else None,
        }
        if any(values[key] is None for key in ("temp", "temp850", "wind", "wind850", "rain", "pressure")):
            continue
        valid = run_dt + timedelta(hours=hour)
        local = valid.astimezone(ISTANBUL_TZ)
        forecasts.append({
            "forecast_hour": hour,
            "valid_time_utc": valid.isoformat(timespec="seconds"),
            "valid_time_istanbul": local.isoformat(timespec="seconds"),
            "temperature_2m_c": round(values["temp"], 2),
            "temperature_2m_stddev_c": None,
            "wind_speed_10m_kmh": round(max(0.0, values["wind"]), 2),
            "wind_direction_10m_deg": None if values["wind_dir"] is None else round(values["wind_dir"] % 360.0, 0),
            "wind_speed_10m_stddev_kmh": None,
            "precipitation_interval_mm": round(max(0.0, values["rain"]), 3),
            "precipitation_interval_stddev_mm": None,
            "precipitation_accumulated_mm": None,
            "temperature_850hpa": {"mean_c": round(values["temp850"], 2), "stddev_c": None},
            "wind_850hpa": {"mean_kmh": round(max(0.0, values["wind850"]), 2), "stddev_kmh": None},
            "mslp": {"mean_hpa": round(values["pressure"], 1), "stddev_hpa": None},
            "_interval_hours": hour - previous,
        })
        previous = hour
    if len(forecasts) < 8:
        raise ValueError(f"MeteoPT ECMWF {expected} kullanılabilir satır az: {len(forecasts)}")
    daily_by_date: dict[str, dict] = {}
    for item in forecasts:
        day = daily_by_date.setdefault(item["valid_time_istanbul"][:10], {"temperatures": [], "precipitation": [], "winds": [], "wind850": []})
        day["temperatures"].append(item["temperature_2m_c"])
        day["precipitation"].append(item["precipitation_interval_mm"])
        day["winds"].append(item["wind_speed_10m_kmh"])
        day["wind850"].append(item["wind_850hpa"]["mean_kmh"])
    daily_summary = [{
        "date_istanbul": date,
        "temperature_min_c": round(min(day["temperatures"]), 1),
        "temperature_max_c": round(max(day["temperatures"]), 1),
        "precipitation_total_mm": round(sum(day["precipitation"]), 1),
        "wind_speed_max_10m_kmh": round(max(day["winds"]), 1),
        "wind_speed_max_850hpa_kmh": round(max(day["wind850"]), 1),
    } for date, day in daily_by_date.items()]
    timeline = []
    for item in forecasts:
        timeline.append({
            "forecast_hour": item["forecast_hour"],
            "valid_time_utc": item["valid_time_utc"],
            "valid_time_istanbul": item["valid_time_istanbul"],
            "temperature_2m_c": item["temperature_2m_c"],
            "temperature_850hpa_c": item["temperature_850hpa"]["mean_c"],
            "wind_speed_10m_kmh": item["wind_speed_10m_kmh"],
            "wind_direction_10m_deg": item.get("wind_direction_10m_deg"),
            "wind_speed_850hpa_kmh": item["wind_850hpa"]["mean_kmh"],
            "precipitation_6h_mm": item["precipitation_interval_mm"],
            "precipitation_interval_hours": item.pop("_interval_hours"),
        })
    place = ((payload.get("geodata") or {}).get("place")) or "İstanbul"
    local_pressure = forecasts[0]["mslp"]["mean_hpa"]
    document = {
        "schema": SCHEMA,
        "status": "ready",
        "forecast_source": "meteopt",
        "model": "ECMWF via MeteoPT",
        "product": "MeteoPT ECMWF 3-hour point",
        "surface_forecast_source": "MeteoPT ECMWF point",
        "ensemble_forecast_source": "MeteoPT ECMWF point",
        "surface_ensemble_spread_available": False,
        "resolution": "MeteoPT nokta",
        "forecast_horizon_hours": forecasts[-1]["forecast_hour"],
        "run_id_utc": run_dt.isoformat(timespec="seconds"),
        "updated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "forecast_valid_until_utc": forecasts[-1]["valid_time_utc"],
        "location": {
            "name": place,
            "latitude": LATITUDE,
            "longitude": LONGITUDE,
            "nearest_grid_latitude": LATITUDE,
            "nearest_grid_longitude": LONGITUDE,
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
        "source_url": SOURCE_URL,
        "notes": [
            "Sıcaklık, rüzgâr, yağış, 850 hPa ve basınç aynı MeteoPT ECMWF noktasından gelir.",
            "Seri 3 saatte bir. Ensemble sapması ve bölgesel basınç merkezi bu kaynakta yok.",
        ],
        "forecasts": forecasts,
        "daily_summary": daily_summary,
        "forecast_6_hourly": timeline,
        "current_conditions": {
            "temperature_2m_c": forecasts[0]["temperature_2m_c"],
            "wind_speed_10m_kmh": forecasts[0]["wind_speed_10m_kmh"],
            "precipitation_mm": forecasts[0]["precipitation_interval_mm"],
            "mean_sea_level_pressure_hpa": local_pressure,
        },
        "regional_pressure_analysis": {
            "valid_time_utc": forecasts[0]["valid_time_utc"],
            "diameter_km": None,
            "findings": [
                f"İstanbul deniz seviyesi basıncı {local_pressure:.1f} hPa. MeteoPT ECMWF noktası; bölgesel basınç merkezi bu kaynakta yok.",
            ],
        },
    }
    _validate_meteopt_document(document)
    print(
        f"[ECMWF METEOPT] {expected}: {len(forecasts)} satır, "
        f"son +{forecasts[-1]['forecast_hour']} saat, {place}"
    )
    return document


def fetch_latest_document(skip_if_run_id: str | None = None) -> dict | None:
    """Newest MeteoPT ECMWF cycle. Open Data GRIB is not used."""
    errors = []
    for run_dt in _meteopt_ecmwf_candidates():
        run_id = run_dt.isoformat(timespec="seconds")
        try:
            document = fetch_meteopt_ecmwf_document(run_dt)
        except Exception as exc:
            message = f"{run_id}: {type(exc).__name__}: {exc}"
            errors.append(message)
            print(f"[ECMWF METEOPT MISS] {message}")
            continue
        if same_published_cycle(skip_if_run_id, document["run_id_utc"]):
            print(f"[ECMWF CACHE HIT] {document['run_id_utc']} zaten yayımlı.")
            return None
        return document
    raise RuntimeError("MeteoPT ECMWF döngüsü alınamadı: " + " | ".join(errors))

def _timeline_with_850_temperature(item: dict) -> list[dict]:
    """Keep 850 hPa temperature on every comparison point.

    Older archives stored it only under forecasts[].temperature_850hpa.
    The comparison chart reads forecast_6_hourly, so copy it across.
    """
    timeline = item.get("forecast_6_hourly")
    if not isinstance(timeline, list):
        return []
    by_hour = {}
    for forecast in item.get("forecasts") or []:
        if not isinstance(forecast, dict):
            continue
        temperature = forecast.get("temperature_850hpa")
        hour = forecast.get("forecast_hour")
        if (
            isinstance(hour, int)
            and isinstance(temperature, dict)
            and isinstance(temperature.get("mean_c"), (int, float))
        ):
            by_hour[hour] = temperature["mean_c"]
    points = []
    for point in timeline:
        if not isinstance(point, dict):
            continue
        copied = dict(point)
        hour = copied.get("forecast_hour")
        if not isinstance(copied.get("temperature_850hpa_c"), (int, float)) and hour in by_hour:
            copied["temperature_850hpa_c"] = by_hour[hour]
        points.append(copied)
    return points


def load_comparison_runs(archive_dir: Path, limit: int = 4) -> list[dict]:
    """Return the newest complete ECMWF cycles with common comparison fields."""
    candidates = []
    for path in sorted(Path(archive_dir).glob("*.json")):
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
            validate_document(item)
            run_id = _normalise_datetime(item["run_id_utc"]).isoformat(timespec="seconds")
            timeline = _timeline_with_850_temperature(item)
            if not timeline or any(
                not isinstance(point.get("temperature_850hpa_c"), (int, float)) for point in timeline
            ):
                print(f"[ECMWF HISTORY] Skipping {path.name}: 850 hPa temperature is incomplete.")
                continue
            candidates.append({"run_id_utc": run_id, "forecast_6_hourly": timeline})
        except (OSError, ValueError, TypeError, KeyError) as exc:
            print(f"[ECMWF HISTORY] Skipping invalid archive {path.name}: {exc}")
    unique = {item["run_id_utc"]: item for item in candidates}
    return sorted(unique.values(), key=lambda item: item["run_id_utc"])[-limit:]


def backfill_recent_cycles(latest_document: dict, archive_dir: Path, target_count: int = 4) -> None:
    """Store the previous MeteoPT ECMWF 00Z and 12Z cycles next to the latest one."""
    archive_dir = Path(archive_dir)
    archive_dir.mkdir(parents=True, exist_ok=True)
    existing = load_comparison_runs(archive_dir, limit=target_count)
    known = {item["run_id_utc"] for item in existing}
    for run_dt in _meteopt_ecmwf_candidates(limit=8):
        if len(known) >= target_count:
            break
        candidate_id = run_dt.isoformat(timespec="seconds")
        if candidate_id in known:
            continue
        try:
            historical = fetch_meteopt_ecmwf_document(run_dt)
        except Exception as exc:
            print(f"[ECMWF METEOPT GEÇMİŞ] {candidate_id} yok: {type(exc).__name__}: {exc}")
            continue
        historical_id = historical["run_id_utc"]
        if historical_id in known:
            continue
        run_key = datetime.fromisoformat(historical_id).strftime("%Y%m%dT%HZ")
        archive_path = archive_dir / f"{run_key}.json"
        archive_path.write_text(json.dumps(historical, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        known.add(historical_id)
        print(f"[ECMWF METEOPT GEÇMİŞ] {historical_id} arşive yazıldı.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", default=os.getenv("ECMWF_PUBLIC_DIR", "public/ecmwf"))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    latest_path = output_dir / "latest.json"
    previous = {}
    if latest_path.is_file() and not args.force:
        try:
            previous = json.loads(latest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            previous = {}
    skip_if_run_id = None if args.force else previous.get("run_id_utc")

    document = fetch_latest_document(skip_if_run_id=skip_if_run_id)
    if document is None:
        if latest_path.is_file():
            cached = json.loads(latest_path.read_text(encoding="utf-8"))
            archive_dir = output_dir / "runs"
            runs = load_comparison_runs(archive_dir, limit=4) if archive_dir.is_dir() else []
            if runs and cached.get("comparison_runs") != runs:
                cached["comparison_runs"] = runs
                latest_path.write_text(json.dumps(cached, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                print(f"[ECMWF COMPARISON REFRESH] {len(runs)} archived cycles attached without a new download.")
            else:
                print("[ECMWF CACHE HIT] Published cycle is current.")
        return

    run_key = datetime.fromisoformat(document["run_id_utc"]).strftime("%Y%m%dT%HZ")
    archive_dir = output_dir / "runs"
    archive_dir.mkdir(parents=True, exist_ok=True)
    archive_path = archive_dir / f"{run_key}.json"
    archive_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    backfill_recent_cycles(document, archive_dir, target_count=4)
    # Keep immutable runs and publish the newest four as comparison history.
    archives = sorted(archive_dir.glob("*.json"))
    for old in archives[:-8]:
        old.unlink(missing_ok=True)
    document["comparison_runs"] = load_comparison_runs(archive_dir, limit=4)
    from render_ecmwf_report_charts import render_ecmwf_report_charts
    document["report_images"] = render_ecmwf_report_charts(document["comparison_runs"], output_dir)
    latest_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"[ECMWF PUBLISHED LOCALLY] {latest_path} · {len(document['forecasts'])} forecast steps · "
        f"{len(document['comparison_runs'])} comparison cycles"
    )


if __name__ == "__main__":
    main()
