"""Build an Istanbul ECMWF IFS ENS (EPS) view from official ECMWF Open Data.

Only the compact forecast values at the nearest 0.25-degree Istanbul grid point
are published. Raw global GRIB2 files are temporary and are deleted afterwards.
The product is the ensemble mean (em) plus ensemble standard deviation (es),
not a single deterministic member.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ISTANBUL_TZ = ZoneInfo("Europe/Istanbul")
LATITUDE = 41.014
LONGITUDE = 28.950
MAX_FORECAST_HOUR = 180
SCHEMA = "gfs-watch.ecmwf-eps.v1"
ATTRIBUTION = "Contains modified Copernicus Climate Change Service information and ECMWF Open Data. © ECMWF. Licensed under CC BY 4.0."
SOURCE_URL = "https://data.ecmwf.int/forecasts/"
LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/"


def forecast_steps(max_hour: int = MAX_FORECAST_HOUR) -> list[int]:
    """IFS ENS 00/12Z steps: 3-hourly through 144h, then 6-hourly."""
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


def _nearest_istanbul_value(gid) -> tuple[float, float, float]:
    import numpy as np
    from eccodes import codes_get_array, codes_get_values

    values = np.asarray(codes_get_values(gid), dtype=float)
    lats = np.asarray(codes_get_array(gid, "latitudes"), dtype=float)
    lons = np.asarray(codes_get_array(gid, "longitudes"), dtype=float)
    if not (len(values) == len(lats) == len(lons)) or not len(values):
        raise ValueError("ECMWF GRIB grid arrays are empty or inconsistent.")
    lon_delta = ((lons - LONGITUDE + 180.0) % 360.0) - 180.0
    distances = (lats - LATITUDE) ** 2 + lon_delta ** 2
    index = int(distances.argmin())
    value = float(values[index])
    if not math.isfinite(value):
        raise ValueError("ECMWF nearest-grid value is not finite.")
    return value, float(lats[index]), float(lons[index])


def read_grib_point(path: Path, expected_kind: str) -> dict[int, tuple[float, float, float]]:
    """Read a compact {forecast_hour: (value, lat, lon)} series from a GRIB file."""
    from eccodes import (
        codes_get,
        codes_grib_new_from_file,
        codes_release,
    )

    if expected_kind not in {"t850", "ws850", "msl"}:
        raise ValueError(f"Unsupported GRIB kind: {expected_kind}")

    output: dict[int, tuple[float, float, float]] = {}
    with path.open("rb") as source:
        while True:
            gid = codes_grib_new_from_file(source)
            if gid is None:
                break
            try:
                short_name = str(codes_get(gid, "shortName")).lower()
                step = int(codes_get(gid, "endStep"))
                level_type = str(codes_get(gid, "typeOfLevel"))
                level = int(codes_get(gid, "level"))
                if expected_kind == "t850":
                    matches = short_name == "t" and level_type == "isobaricInhPa" and level == 850
                elif expected_kind == "ws850":
                    matches = short_name in {"ws", "si"} and level_type == "isobaricInhPa" and level == 850
                else:
                    matches = short_name == "msl" and level_type in {"meanSea", "surface"}
                if not matches:
                    continue
                if step in output:
                    raise ValueError(f"Duplicate {expected_kind} field at step {step}.")
                output[step] = _nearest_istanbul_value(gid)
            finally:
                codes_release(gid)

    if not output:
        raise RuntimeError(f"No {expected_kind} fields found in {path.name}.")
    return output


def _retrieve(client, *, run_dt: datetime, product_type: str, step_values: list[int],
              params: list[str], levelist: int | None, target: Path) -> None:
    request = {
        "date": run_dt.strftime("%Y%m%d"),
        "time": run_dt.hour,
        "stream": "enfo",
        "type": product_type,
        "step": step_values,
        "param": params,
        "target": str(target),
    }
    if levelist is not None:
        request["levelist"] = levelist
        request["levtype"] = "pl"
    else:
        request["levtype"] = "sfc"
    client.retrieve(**request)
    if not target.is_file() or target.stat().st_size < 100:
        raise RuntimeError(f"ECMWF returned an empty {product_type} file for {params}.")


def _latest_available_run(client) -> datetime:
    # Check the far end of the requested horizon, not just f000. This avoids
    # selecting a cycle whose later EPS files are still being disseminated.
    result = client.latest(
        stream="enfo", type="em", step=MAX_FORECAST_HOUR,
        param="ws", levelist=850,
    )
    if result is None:
        raise RuntimeError("ECMWF Open Data did not report a completed EPS 180-hour cycle.")
    return _normalise_datetime(result)


def _value_at(series, step: int, label: str) -> tuple[float, float, float]:
    if step not in series:
        raise RuntimeError(f"ECMWF {label} missing forecast step +{step}h.")
    return series[step]


def build_document(run_dt: datetime, mean: dict, spread: dict) -> dict:
    steps = forecast_steps()
    required = {
        "mean_t850": "t850", "spread_t850": "t850",
        "mean_ws850": "ws850", "spread_ws850": "ws850",
        "mean_msl": "msl", "spread_msl": "msl",
    }
    for key, label in required.items():
        if not isinstance((mean if key.startswith("mean_") else spread).get(key), dict):
            raise RuntimeError(f"Internal ECMWF field collection missing: {key} ({label}).")

    forecasts = []
    grid_lat = grid_lon = None
    for step in steps:
        t_mean, lat, lon = _value_at(mean["mean_t850"], step, "850 hPa temperature mean")
        t_sd, _, _ = _value_at(spread["spread_t850"], step, "850 hPa temperature spread")
        w_mean, _, _ = _value_at(mean["mean_ws850"], step, "850 hPa wind mean")
        w_sd, _, _ = _value_at(spread["spread_ws850"], step, "850 hPa wind spread")
        p_mean, _, _ = _value_at(mean["mean_msl"], step, "MSLP mean")
        p_sd, _, _ = _value_at(spread["spread_msl"], step, "MSLP spread")
        if grid_lat is None:
            grid_lat, grid_lon = lat, lon
        valid_utc = run_dt + timedelta(hours=step)
        forecasts.append({
            "forecast_hour": step,
            "valid_time_utc": valid_utc.isoformat(timespec="minutes"),
            "valid_time_istanbul": valid_utc.astimezone(ISTANBUL_TZ).isoformat(timespec="minutes"),
            "temperature_850hpa": {
                "mean_c": round(t_mean - 273.15, 2),
                "stddev_c": round(max(0.0, t_sd), 2),
            },
            "wind_850hpa": {
                "mean_kmh": round(w_mean * 3.6, 2),
                "stddev_kmh": round(max(0.0, w_sd) * 3.6, 2),
            },
            "mslp": {
                "mean_hpa": round(p_mean / 100.0, 2),
                "stddev_hpa": round(max(0.0, p_sd) / 100.0, 2),
            },
        })

    if len(forecasts) != len(steps) or forecasts[-1]["forecast_hour"] != MAX_FORECAST_HOUR:
        raise RuntimeError("ECMWF EPS forecast timeline is incomplete.")
    return {
        "schema": SCHEMA,
        "status": "ready",
        "model": "ECMWF IFS ENS (EPS)",
        "product": "enfo / ensemble mean (em) and standard deviation (es)",
        "resolution": "0.25° × 0.25°",
        "forecast_horizon_hours": MAX_FORECAST_HOUR,
        "run_id_utc": run_dt.isoformat(timespec="seconds"),
        "updated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "forecast_valid_until_utc": forecasts[-1]["valid_time_utc"],
        "location": {
            "name": "İstanbul",
            "latitude": LATITUDE,
            "longitude": LONGITUDE,
            "nearest_grid_latitude": round(float(grid_lat), 3),
            "nearest_grid_longitude": round(float(grid_lon), 3),
        },
        "units": {
            "temperature_850hpa": "°C",
            "wind_850hpa": "km/sa",
            "mslp": "hPa",
            "spread": "ensemble standard deviation (1σ)",
        },
        "attribution": ATTRIBUTION,
        "license": "CC BY 4.0",
        "license_url": LICENSE_URL,
        "source_url": SOURCE_URL,
        "notes": [
            "Gösterilen çizgi ensemble ortalamasıdır.",
            "Gölgelendirme ±1 standart sapma aralığıdır; mutlak minimum/maksimum değildir.",
            "ECMWF ENS açık verisi 00Z ve 12Z döngülerinde 0.25° çözünürlükte kullanılmıştır.",
        ],
        "forecasts": forecasts,
    }


def validate_document(document: dict) -> None:
    if document.get("schema") != SCHEMA or document.get("status") != "ready":
        raise ValueError("ECMWF EPS document schema/status is invalid.")
    forecasts = document.get("forecasts")
    steps = forecast_steps()
    if not isinstance(forecasts, list) or len(forecasts) != len(steps):
        raise ValueError(f"Expected {len(steps)} ECMWF forecast steps.")
    if [item.get("forecast_hour") for item in forecasts] != steps:
        raise ValueError("ECMWF forecast steps are missing, duplicated or out of order.")
    for item in forecasts:
        for group, fields in {
            "temperature_850hpa": ("mean_c", "stddev_c"),
            "wind_850hpa": ("mean_kmh", "stddev_kmh"),
            "mslp": ("mean_hpa", "stddev_hpa"),
        }.items():
            values = item.get(group)
            if not isinstance(values, dict):
                raise ValueError(f"ECMWF field group missing: {group}.")
            for key in fields:
                value = values.get(key)
                if not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise ValueError(f"ECMWF value is not finite: {group}.{key}.")
            if values[fields[1]] < 0:
                raise ValueError(f"ECMWF standard deviation cannot be negative: {group}.")
        if not (-100 <= item["temperature_850hpa"]["mean_c"] <= 60):
            raise ValueError("ECMWF 850 hPa temperature is outside physical sanity bounds.")
        if not (0 <= item["wind_850hpa"]["mean_kmh"] <= 250):
            raise ValueError("ECMWF 850 hPa wind speed is outside sanity bounds.")
        if not (800 <= item["mslp"]["mean_hpa"] <= 1100):
            raise ValueError("ECMWF MSLP is outside sanity bounds.")
        datetime.fromisoformat(item["valid_time_utc"].replace("Z", "+00:00"))
    if document.get("license") != "CC BY 4.0" or not document.get("attribution"):
        raise ValueError("ECMWF Open Data attribution/licence metadata is missing.")


def _fetch_cycle(client, run_dt: datetime) -> dict:
    steps = forecast_steps()
    with tempfile.TemporaryDirectory(prefix="ecmwf-eps-") as temp_dir:
        root = Path(temp_dir)
        paths = {
            "em_pl": root / "em-pl850.grib2",
            "es_pl": root / "es-pl850.grib2",
            "em_sfc": root / "em-sfc.grib2",
            "es_sfc": root / "es-sfc.grib2",
        }
        for product_type, key in (("em", "em_pl"), ("es", "es_pl")):
            _retrieve(
                client, run_dt=run_dt, product_type=product_type,
                step_values=steps, params=["t", "ws"], levelist=850, target=paths[key],
            )
        for product_type, key in (("em", "em_sfc"), ("es", "es_sfc")):
            _retrieve(
                client, run_dt=run_dt, product_type=product_type,
                step_values=steps, params=["msl"], levelist=None, target=paths[key],
            )

        mean = {
            "mean_t850": read_grib_point(paths["em_pl"], "t850"),
            "mean_ws850": read_grib_point(paths["em_pl"], "ws850"),
            "mean_msl": read_grib_point(paths["em_sfc"], "msl"),
        }
        spread = {
            "spread_t850": read_grib_point(paths["es_pl"], "t850"),
            "spread_ws850": read_grib_point(paths["es_pl"], "ws850"),
            "spread_msl": read_grib_point(paths["es_sfc"], "msl"),
        }
        document = build_document(run_dt, mean, spread)
        validate_document(document)
        return document


def fetch_latest_document(skip_if_run_id: str | None = None) -> dict | None:
    from ecmwf.opendata import Client

    source_errors = []
    for source in ("aws", "ecmwf"):
        try:
            client = Client(source=source, model="ifs", resol="0p25")
            run_dt = _latest_available_run(client)
            run_id = run_dt.isoformat(timespec="seconds")
            print(f"[ECMWF] Latest complete EPS 180h cycle: {run_id} source={source}")
            # Querying cycle metadata is cheap. Do not download the same 55-step
            # ensemble GRIB package again when the already-published run is current.
            if same_published_cycle(skip_if_run_id, run_id):
                print(f"[ECMWF CACHE HIT] {run_id} already published; skipping GRIB retrieval.")
                return None
            document = _fetch_cycle(client, run_dt)
            document["retrieval_source"] = source
            print(
                f"[ECMWF OK] {len(document['forecasts'])} points · "
                f"T850 {document['forecasts'][0]['temperature_850hpa']['mean_c']:.1f} °C · "
                f"850 hPa wind {document['forecasts'][0]['wind_850hpa']['mean_kmh']:.1f} km/h"
            )
            return document
        except Exception as exc:
            message = f"{source}: {type(exc).__name__}: {exc}"
            source_errors.append(message)
            print(f"[ECMWF SOURCE ERROR] {message}")
    raise RuntimeError("No ECMWF Open Data source succeeded: " + " | ".join(source_errors))


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
        return

    run_key = datetime.fromisoformat(document["run_id_utc"]).strftime("%Y%m%dT%HZ")
    archive_dir = output_dir / "runs"
    archive_dir.mkdir(parents=True, exist_ok=True)
    archive_path = archive_dir / f"{run_key}.json"
    archive_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    latest_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # Keep only the latest eight forecast cycles in the public archive.
    archives = sorted(archive_dir.glob("*.json"))
    for old in archives[:-8]:
        old.unlink(missing_ok=True)
    print(f"[ECMWF PUBLISHED LOCALLY] {latest_path} · {len(document['forecasts'])} forecast steps")


if __name__ == "__main__":
    main()
