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
import tempfile
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


def _matches_grib_field(expected_kind: str, short_name: str, param_id: int,
                        level_type: str, level: int) -> bool:
    """Match ECMWF fields across ecCodes level encodings used by Open Data.

    ECMWF's Open Data catalogue labels 2t/10u/10v as single-surface (sfc)
    parameters. Depending on the GRIB edition/table, ecCodes can expose these
    either as typeOfLevel=surface (level 0) or heightAboveGround (2/10).
    """
    aliases = {
        "t850": {"t"}, "ws850": {"ws", "si"}, "msl": {"msl"},
        "t2m": {"2t", "t2m"}, "u10": {"10u"}, "v10": {"10v"}, "tp": {"tp"},
    }
    parameter_ids = {
        "t850": {130}, "ws850": {10, 207}, "msl": {151},
        "t2m": {167}, "u10": {165}, "v10": {166}, "tp": {228},
    }
    if expected_kind not in aliases:
        return False
    if short_name not in aliases[expected_kind] and param_id not in parameter_ids[expected_kind]:
        return False

    if expected_kind in {"t850", "ws850"}:
        return level_type == "isobaricInhPa" and level == 850
    if expected_kind == "msl":
        return level_type in {"meanSea", "surface"}
    if expected_kind == "t2m":
        return level_type == "surface" or (level_type == "heightAboveGround" and level == 2)
    if expected_kind in {"u10", "v10"}:
        return level_type == "surface" or (level_type == "heightAboveGround" and level == 10)
    if expected_kind == "tp":
        return level_type in {"surface", "meanSea"}
    return False


def read_grib_point(path: Path, expected_kind: str) -> dict[int, tuple[float, float, float]]:
    """Read a compact {forecast_hour: (value, lat, lon)} series from a GRIB file."""
    from eccodes import (
        codes_get,
        codes_grib_new_from_file,
        codes_release,
    )

    if expected_kind not in {"t850", "ws850", "msl", "t2m", "u10", "v10", "tp"}:
        raise ValueError(f"Unsupported GRIB kind: {expected_kind}")

    output: dict[int, tuple[float, float, float]] = {}
    available_fields: set[tuple[int, str, str, int]] = set()
    with path.open("rb") as source:
        while True:
            gid = codes_grib_new_from_file(source)
            if gid is None:
                break
            try:
                short_name = str(codes_get(gid, "shortName")).lower()
                param_id = int(codes_get(gid, "paramId"))
                step = int(codes_get(gid, "endStep"))
                level_type = str(codes_get(gid, "typeOfLevel"))
                level = int(codes_get(gid, "level"))
                available_fields.add((param_id, short_name, level_type, level))
                if not _matches_grib_field(expected_kind, short_name, param_id, level_type, level):
                    continue
                if step in output:
                    raise ValueError(f"Duplicate {expected_kind} field at step {step}.")
                output[step] = _nearest_istanbul_value(gid)
            finally:
                codes_release(gid)

    if not output:
        preview = ", ".join(
            f"{param}/{name}/{level_type}/{level}"
            for param, name, level_type, level in sorted(available_fields)[:18]
        ) or "no readable GRIB fields"
        raise RuntimeError(
            f"No {expected_kind} fields found in {path.name}. "
            f"Available GRIB fields (paramId/shortName/typeOfLevel/level): {preview}"
        )
    return output


def _retrieve(client, *, run_dt: datetime, stream: str, product_type: str,
              step_values: list[int], params: list[str], levelist: int | None,
              target: Path) -> None:
    request = {
        "date": run_dt.strftime("%Y%m%d"),
        "time": run_dt.hour,
        "stream": stream,
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



def _pressure_region_name(latitude: float, longitude: float) -> str:
    """Name a synoptic pressure centre in plain Turkish regional geography."""
    lat = float(latitude)
    lon = ((float(longitude) + 180.0) % 360.0) - 180.0
    if 50 <= lat <= 53 and 22 <= lon <= 29:
        return "Kuzeybatı Ukrayna (Volın bölgesi)"
    if 44 <= lat <= 46.5 and 32.2 <= lon <= 37:
        return "Kırım Yarımadası, Ukrayna"
    if 43.6 <= lat <= 48.3 and 20.2 <= lon <= 29.7:
        return "Romanya"
    if 41.2 <= lat <= 44.2 and 22.3 <= lon <= 28.2:
        return "Bulgaristan, Balkanlar"
    if 43 <= lat <= 49.2 and 37 <= lon <= 48.5:
        return "Güney Rusya (Rostov ve Krasnodar çevresi)"
    if 39 <= lat <= 41.8 and 20 <= lon <= 26.6:
        return "Kuzeydoğu Yunanistan ve Trakya"
    if 35 <= lat <= 41 and 19 <= lon < 23:
        return "Batı Yunanistan ve İyon Denizi açıkları"
    if 39 <= lat <= 46 and 13 <= lon <= 20:
        return "Adriyatik Denizi ve Batı Balkan kıyıları"
    if 40.5 <= lat <= 47.5 and 27 <= lon <= 42.5:
        return "Karadeniz havzası"
    if 40 <= lat <= 42.3 and 26 <= lon <= 30.5:
        return "Marmara ve Trakya, Türkiye"
    if 36.5 <= lat <= 40 and 26 <= lon <= 30:
        return "Ege Bölgesi, Türkiye"
    if 37 <= lat <= 40.8 and 30 <= lon <= 36.5:
        return "İç Anadolu, Türkiye"
    if 30 <= lat < 36.5 and 27 <= lon <= 37.5:
        return "Doğu Akdeniz"
    return "Doğu Avrupa ve Karadeniz çevresi"


def _distance_direction_from_istanbul(latitude: float, longitude: float) -> str:
    import math

    lat1, lon1 = math.radians(LATITUDE), math.radians(LONGITUDE)
    lat2 = math.radians(float(latitude))
    lon2 = math.radians(float(longitude))
    delta_lon = (lon2 - lon1 + math.pi) % (2 * math.pi) - math.pi
    delta_lat = lat2 - lat1
    a = (math.sin(delta_lat / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2)
    distance = 6371.0 * 2 * math.asin(math.sqrt(max(0.0, min(1.0, a))))
    bearing = (math.degrees(math.atan2(
        math.sin(delta_lon) * math.cos(lat2),
        math.cos(lat1) * math.sin(lat2)
        - math.sin(lat1) * math.cos(lat2) * math.cos(delta_lon),
    )) + 360.0) % 360.0
    directions = ("kuzey", "kuzeydoğu", "doğu", "güneydoğu",
                  "güney", "güneybatı", "batı", "kuzeybatı")
    direction = directions[int((bearing + 22.5) // 45) % 8]
    return f"İstanbul'un yaklaşık {round(distance)} km {direction} yönünde"


def read_regional_pressure_extremes(path: Path, radius_km: float = 1250.0) -> dict:
    """Find MSLP extrema in a 2,500 km diameter around Istanbul from the em GRIB."""
    import numpy as np
    from eccodes import (
        codes_get, codes_get_array, codes_get_values,
        codes_grib_new_from_file, codes_release,
    )

    with path.open("rb") as source:
        while True:
            gid = codes_grib_new_from_file(source)
            if gid is None:
                break
            try:
                if str(codes_get(gid, "shortName")).lower() != "msl":
                    continue
                if int(codes_get(gid, "endStep")) != 0:
                    continue
                values = np.asarray(codes_get_values(gid), dtype=float)
                lats = np.asarray(codes_get_array(gid, "latitudes"), dtype=float)
                lons = np.asarray(codes_get_array(gid, "longitudes"), dtype=float)
                if not (len(values) == len(lats) == len(lons)) or not len(values):
                    raise ValueError("ECMWF regional MSLP grid arrays are inconsistent.")
                lat1 = math.radians(LATITUDE)
                lat2 = np.radians(lats)
                delta_lat = lat2 - lat1
                delta_lon_deg = ((lons - LONGITUDE + 180.0) % 360.0) - 180.0
                delta_lon = np.radians(delta_lon_deg)
                a = (np.sin(delta_lat / 2.0) ** 2
                     + math.cos(lat1) * np.cos(lat2) * np.sin(delta_lon / 2.0) ** 2)
                distances = 6371.0 * 2.0 * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))
                valid = np.isfinite(values) & (distances <= radius_km)
                indices = np.flatnonzero(valid)
                if len(indices) < 10:
                    raise RuntimeError("Too few valid ECMWF MSLP points inside the regional analysis area.")

                high_index = int(indices[np.argmax(values[indices])])
                low_index = int(indices[np.argmin(values[indices])])
                istanbul_index = int(np.argmin(distances))
                def point(index):
                    return {
                        "pressure_hpa": round(float(values[index]) / 100.0, 1),
                        "latitude": round(float(lats[index]), 2),
                        "longitude": round(float(((lons[index] + 180.0) % 360.0) - 180.0), 2),
                        "distance_km": round(float(distances[index])),
                    }
                return {
                    "diameter_km": round(radius_km * 2),
                    "high": point(high_index),
                    "low": point(low_index),
                    "local_pressure_hpa": round(float(values[istanbul_index]) / 100.0, 1),
                }
            finally:
                codes_release(gid)
    raise RuntimeError("ECMWF ensemble-mean MSLP field at forecast step 0 was not found.")


def format_regional_pressure_findings(regional: dict | None, local_pressure_hpa: float) -> list[str]:
    if not isinstance(regional, dict) or not isinstance(regional.get("high"), dict) or not isinstance(regional.get("low"), dict):
        return [
            "ECMWF ensemble ortalaması için bölgesel MSLP grid'i bu döngüde alınamadı; basınç merkezi konumu üretilmedi."
        ]
    high, low = regional["high"], regional["low"]
    high_name = _pressure_region_name(high["latitude"], high["longitude"])
    low_name = _pressure_region_name(low["latitude"], low["longitude"])
    high_distance = _distance_direction_from_istanbul(high["latitude"], high["longitude"])
    low_distance = _distance_direction_from_istanbul(low["latitude"], low["longitude"])
    local = float(regional.get("local_pressure_hpa", local_pressure_hpa))
    spread = float(high["pressure_hpa"]) - float(low["pressure_hpa"])
    return [
        f"Yüksek basınç merkezi: {high['pressure_hpa']:.1f} hPa — {high_name}. {high_distance}. Yüksek basınçta hava alçalıcıdır; genellikle daha kararlı koşulları destekler.",
        f"Alçak basınç merkezi: {low['pressure_hpa']:.1f} hPa — {low_name}. {low_distance}. Alçak basınçta hava yükselici hareket eğilimindedir; bulutlanma ve yağış ihtimalini artırabilir.",
        f"İstanbul'daki ECMWF ensemble başlangıç basıncı {local:.1f} hPa. İncelenen {regional.get('diameter_km', 2500):,} km alandaki en yüksek ve en düşük değer arasındaki fark {spread:.1f} hPa.",
        "Basınç merkezleri bölgesel eğilimi gösterir; İstanbul'da yağış veya açık hava garantisi değildir. Etki, rüzgâr yönü, basınç dağılımı ve cephelerin konumuyla belirlenir.",
    ]

def build_document(run_dt: datetime, mean: dict, spread: dict, regional_pressure: dict | None = None) -> dict:
    steps = forecast_steps()
    required = {
        "mean_t850": "t850", "spread_t850": "t850",
        "mean_ws850": "ws850", "spread_ws850": "ws850",
        "mean_msl": "msl", "spread_msl": "msl",
        "mean_t2m": "t2m", "mean_u10": "u10",
        "mean_v10": "v10", "mean_tp": "tp",
    }
    for key, label in required.items():
        if not isinstance((mean if key.startswith("mean_") else spread).get(key), dict):
            raise RuntimeError(f"Internal ECMWF field collection missing: {key} ({label}).")

    # HRES total precipitation is accumulated from the cycle start. f000 is
    # the zero baseline and is not guaranteed to be present in the GRIB file.
    mean_tp = dict(mean["mean_tp"])
    mean_tp.setdefault(0, (0.0, LATITUDE, LONGITUDE))

    forecasts = []
    grid_lat = grid_lon = None
    previous_tp_mean = 0.0
    for step in steps:
        t_mean, lat, lon = _value_at(mean["mean_t850"], step, "850 hPa temperature mean")
        t_sd, _, _ = _value_at(spread["spread_t850"], step, "850 hPa temperature spread")
        w_mean, _, _ = _value_at(mean["mean_ws850"], step, "850 hPa wind mean")
        w_sd, _, _ = _value_at(spread["spread_ws850"], step, "850 hPa wind spread")
        p_mean, _, _ = _value_at(mean["mean_msl"], step, "MSLP mean")
        p_sd, _, _ = _value_at(spread["spread_msl"], step, "MSLP spread")
        t2_mean, _, _ = _value_at(mean["mean_t2m"], step, "2m HRES temperature")
        u10_mean, _, _ = _value_at(mean["mean_u10"], step, "10m HRES u wind")
        v10_mean, _, _ = _value_at(mean["mean_v10"], step, "10m HRES v wind")
        tp_mean, _, _ = _value_at(mean_tp, step, "HRES total precipitation")
        wind10 = math.hypot(u10_mean, v10_mean) * 3.6
        precip_interval_mm = max(0.0, (tp_mean - previous_tp_mean) * 1000.0)
        previous_tp_mean = tp_mean
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
            "temperature_2m_c": round(t2_mean - 273.15, 2),
            "temperature_2m_stddev_c": None,
            "wind_speed_10m_kmh": round(wind10, 2),
            "wind_speed_10m_stddev_kmh": None,
            "precipitation_interval_mm": round(precip_interval_mm, 3),
            "precipitation_interval_stddev_mm": None,
            "precipitation_accumulated_mm": round(max(0.0, tp_mean) * 1000.0, 3),
        })

    if len(forecasts) != len(steps) or forecasts[-1]["forecast_hour"] != MAX_FORECAST_HOUR:
        raise RuntimeError("ECMWF IFS forecast timeline is incomplete.")
    daily_by_date: dict[str, dict] = {}
    for item in forecasts:
        local_date = item["valid_time_istanbul"][:10]
        day = daily_by_date.setdefault(local_date, {"temperatures": [], "precipitation": [], "winds": []})
        day["temperatures"].append(item["temperature_2m_c"])
        day["precipitation"].append(item["precipitation_interval_mm"])
        day["winds"].append(item["wind_speed_10m_kmh"])
    daily_summary = [{
        "date_istanbul": date,
        "temperature_min_c": round(min(day["temperatures"]), 1),
        "temperature_max_c": round(max(day["temperatures"]), 1),
        "precipitation_total_mm": round(sum(day["precipitation"]), 1),
        "wind_speed_max_10m_kmh": round(max(day["winds"]), 1),
        "wind_speed_max_850hpa_kmh": round(max(item["wind_850hpa"]["mean_kmh"] for item in forecasts if item["valid_time_istanbul"][:10] == date), 1),
    } for date, day in daily_by_date.items()]
    gfs_compatible_forecast = []
    previous_step = 0
    for item in forecasts:
        gfs_compatible_forecast.append({
            "forecast_hour": item["forecast_hour"],
            "valid_time_utc": item["valid_time_utc"],
            "valid_time_istanbul": item["valid_time_istanbul"],
            "temperature_2m_c": item["temperature_2m_c"],
            "temperature_850hpa_c": item["temperature_850hpa"]["mean_c"],
            "wind_speed_10m_kmh": item["wind_speed_10m_kmh"],
            "wind_speed_850hpa_kmh": item["wind_850hpa"]["mean_kmh"],
            "precipitation_6h_mm": item["precipitation_interval_mm"],
            "precipitation_interval_hours": item["forecast_hour"] - previous_step,
        })
        previous_step = item["forecast_hour"]
    return {
        "schema": SCHEMA,
        "status": "ready",
        "model": "ECMWF IFS HRES + ENS",
        "product": "HRES surface forecast (oper/fc) + ENS mean/spread (enfo em/es)",
        "surface_forecast_source": "IFS HRES deterministic (stream=oper, type=fc)",
        "ensemble_forecast_source": "IFS ENS mean and standard deviation (stream=enfo, type=em/es)",
        "surface_ensemble_spread_available": False,
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
            "spread": "ensemble standard deviation (1σ), only for ENS fields",
        },
        "attribution": ATTRIBUTION,
        "license": "CC BY 4.0",
        "license_url": LICENSE_URL,
        "source_url": SOURCE_URL,
        "notes": [
            "2 m sıcaklık, 10 m rüzgâr ve toplam yağış IFS HRES deterministic yüzey tahminidir (oper/fc).",
            "850 hPa sıcaklık/rüzgâr ve deniz seviyesi basıncı IFS ENS ensemble ortalaması (enfo/em) ürünüdür.",
            "±1 standart sapma yalnızca IFS ENS tarafından yayımlanan 850 hPa ve MSLP alanları için verilir.",
            "IFS Open Data em/es ürününde 2 m sıcaklık, 10 m rüzgâr bileşenleri ve toplam yağış standart sapması yayımlanmaz; bu alanlar sıfır gibi gösterilmez, null bırakılır.",
            "Yağış aralıkları HRES toplam birikimli yağış alanının ardışık adımları arasındaki farktan türetilmiştir.",
        ],
        "forecasts": forecasts,
        "daily_summary": daily_summary,
        "forecast_6_hourly": gfs_compatible_forecast,
        "current_conditions": {
            "temperature_2m_c": forecasts[0]["temperature_2m_c"],
            "wind_speed_10m_kmh": forecasts[0]["wind_speed_10m_kmh"],
            "precipitation_mm": forecasts[0]["precipitation_interval_mm"],
            "mean_sea_level_pressure_hpa": forecasts[0]["mslp"]["mean_hpa"],
        },
        "regional_pressure_analysis": {
            "valid_time_utc": run_dt.isoformat(timespec="seconds"),
            "diameter_km": (regional_pressure or {}).get("diameter_km", 2500),
            "findings": format_regional_pressure_findings(
                regional_pressure, forecasts[0]["mslp"]["mean_hpa"]
            ),
        },
    }

def validate_document(document: dict) -> None:
    if document.get("forecast_source") == "meteopt":
        _validate_meteopt_document(document)
        return
    if document.get("schema") != SCHEMA or document.get("status") != "ready":
        raise ValueError("ECMWF IFS document schema/status is invalid.")
    if document.get("surface_forecast_source") != "IFS HRES deterministic (stream=oper, type=fc)":
        raise ValueError("ECMWF HRES surface source metadata is missing.")
    if document.get("ensemble_forecast_source") != "IFS ENS mean and standard deviation (stream=enfo, type=em/es)":
        raise ValueError("ECMWF ENS source metadata is missing.")
    if document.get("surface_ensemble_spread_available") is not False:
        raise ValueError("Unavailable surface ensemble spread must be explicitly marked false.")
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
        for key in ("temperature_2m_c", "wind_speed_10m_kmh", "precipitation_interval_mm"):
            value = item.get(key)
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"ECMWF GFS-compatible field is invalid: {key}.")
        if not (-100 <= item["temperature_2m_c"] <= 60):
            raise ValueError("ECMWF 2m temperature is outside physical sanity bounds.")
        if not (0 <= item["wind_speed_10m_kmh"] <= 250):
            raise ValueError("ECMWF 10m wind is outside physical sanity bounds.")
        if item["precipitation_interval_mm"] < 0:
            raise ValueError("ECMWF precipitation interval cannot be negative.")
        datetime.fromisoformat(item["valid_time_utc"].replace("Z", "+00:00"))
    if not isinstance(document.get("daily_summary"), list) or not document["daily_summary"]:
        raise ValueError("ECMWF daily summary is missing.")
    if not isinstance(document.get("forecast_6_hourly"), list) or len(document["forecast_6_hourly"]) != len(steps):
        raise ValueError("ECMWF GFS-compatible forecast timeline is missing.")
    if document.get("license") != "CC BY 4.0" or not document.get("attribution"):
        raise ValueError("ECMWF Open Data attribution/licence metadata is missing.")


def _validate_meteopt_document(document: dict) -> None:
    """A MeteoPT point series. It has no ensemble spread and no regional grid."""
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


def _fetch_cycle(client, run_dt: datetime) -> dict:
    steps = forecast_steps()
    with tempfile.TemporaryDirectory(prefix="ecmwf-ifs-") as temp_dir:
        root = Path(temp_dir)
        paths = {
            "em_pl": root / "em-pl850.grib2",
            "es_pl": root / "es-pl850.grib2",
            "em_sfc": root / "em-sfc.grib2",
            "es_sfc": root / "es-sfc.grib2",
            "hres_sfc": root / "hres-sfc.grib2",
        }
        # IFS ENS em/es Open Data contains 850 hPa temperature/wind and MSLP,
        # but not the near-surface 2t/10u/10v/tp fields.
        for product_type, key in (("em", "em_pl"), ("es", "es_pl")):
            _retrieve(
                client, run_dt=run_dt, stream="enfo", product_type=product_type,
                step_values=steps, params=["t", "ws"], levelist=850, target=paths[key],
            )
        for product_type, key in (("em", "em_sfc"), ("es", "es_sfc")):
            _retrieve(
                client, run_dt=run_dt, stream="enfo", product_type=product_type,
                step_values=steps, params=["msl"], levelist=None, target=paths[key],
            )

        # Use the same IFS cycle's deterministic HRES surface forecast for
        # temperature, 10 m wind components and accumulated precipitation.
        _retrieve(
            client, run_dt=run_dt, stream="oper", product_type="fc",
            step_values=steps, params=["2t", "10u", "10v", "tp"],
            levelist=None, target=paths["hres_sfc"],
        )

        mean = {
            "mean_t850": read_grib_point(paths["em_pl"], "t850"),
            "mean_ws850": read_grib_point(paths["em_pl"], "ws850"),
            "mean_msl": read_grib_point(paths["em_sfc"], "msl"),
            "mean_t2m": read_grib_point(paths["hres_sfc"], "t2m"),
            "mean_u10": read_grib_point(paths["hres_sfc"], "u10"),
            "mean_v10": read_grib_point(paths["hres_sfc"], "v10"),
            "mean_tp": read_grib_point(paths["hres_sfc"], "tp"),
        }
        spread = {
            "spread_t850": read_grib_point(paths["es_pl"], "t850"),
            "spread_ws850": read_grib_point(paths["es_pl"], "ws850"),
            "spread_msl": read_grib_point(paths["es_sfc"], "msl"),
        }
        try:
            regional_pressure = read_regional_pressure_extremes(paths["em_sfc"])
        except Exception as exc:
            print(f"[ECMWF PRESSURE ANALYSIS WARNING] {type(exc).__name__}: {exc}")
            regional_pressure = None
        document = build_document(run_dt, mean, spread, regional_pressure)
        validate_document(document)
        return document


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
