"""Fetch and publish the live ENKA Balmumcu camera OCR observation."""

import json
import io
import math
import os
import re
import time
from datetime import datetime, timedelta, timezone
from html import unescape
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
import pytesseract
from PIL import Image, ImageEnhance, ImageFilter

TR_TZ = ZoneInfo("Europe/Istanbul")
CURRENT_URL = "https://w.enka.com/camhd/cam1/c.jpg"
HOME_URL = "https://w.enka.com/camhd/cam1/index.html"
HISTORY_URL = "https://w.enka.com/weather/downld02.txt"
POLL_STALE_MINUTES = 15

WIND_DIRECTIONS_TR = {
    "N": "Kuzey",
    "NNE": "Kuzey-kuzeydoğu",
    "NE": "Kuzeydoğu",
    "ENE": "Doğu-kuzeydoğu",
    "E": "Doğu",
    "ESE": "Doğu-güneydoğu",
    "SE": "Güneydoğu",
    "SSE": "Güney-güneydoğu",
    "S": "Güney",
    "SSW": "Güney-güneybatı",
    "SW": "Güneybatı",
    "WSW": "Batı-güneybatı",
    "W": "Batı",
    "WNW": "Batı-kuzeybatı",
    "NW": "Kuzeybatı",
    "NNW": "Kuzey-kuzeybatı",
}
WIND_PATTERN = r"NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW|N|NE|E|SE|S|SW|W|NW"


def _fetch_current_values_page():
    """Fetch ENKA WeatherLink's live Balmumcu values from currentvalues.html."""
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/4.1)",
        "Accept": "text/html,application/xhtml+xml",
        "Cache-Control": "no-cache, no-store, max-age=0",
        "Pragma": "no-cache",
    }
    response = requests.get(
        "https://w.enka.com/weather/currentvalues.html",
        params={"_gfs_watch": int(time.time() * 1000)},
        headers=headers,
        timeout=25,
    )
    response.raise_for_status()
    response.encoding = response.apparent_encoding or "utf-8"
    html = response.text
    # Keep the parser dependency-free. Strip tags/entities and normalize whitespace.
    text = unescape(re.sub(r"<[^>]+>", " ", html))
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _parse_current_values(text):
    """Parse the values table published by ENKA WeatherLink."""
    as_of = re.search(
        r"As of:\s*(\d{2}/\d{2}/\d{2})\s+(\d{1,2}:\d{2})\s*\(UTC\s+\d{1,2}:\d{2}\)",
        text,
        flags=re.I,
    )
    if not as_of:
        raise ValueError("ENKA currentvalues.html ölçüm zamanı okunamadı.")

    local_dt = datetime.strptime(
        f"{as_of.group(1)} {as_of.group(2)}", "%d/%m/%y %H:%M"
    ).replace(tzinfo=TR_TZ)

    def number_after(label, pattern):
        match = re.search(
            rf"{re.escape(label)}\\s+{pattern}",
            text,
            flags=re.I,
        )
        if not match:
            raise ValueError(f"ENKA currentvalues.html {label} değeri okunamadı.")
        return float(match.group(1).replace(",", "."))

    temperature = number_after("Day Temperature", r"([-+]?\d+(?:[.,]\d+)?)°C")
    pressure = number_after("Barometer \(hPa\)", r"(\d+(?:[.,]\d+)?)")
    humidity = number_after("Humidity", r"(\d+(?:[.,]\d+)?)%")
    daily_rain = number_after("Daily Rain", r"(\d+(?:[.,]\d+)?)\s*mm")

    wind_match = re.search(
        r"Wind\\s+([A-Z]{1,3})\\s+(\d+(?:[.,]\d+)?)\\s*kt",
        text,
        flags=re.I,
    )
    if not wind_match:
        raise ValueError("ENKA currentvalues.html rüzgâr değeri okunamadı.")
    wind_direction = wind_match.group(1).upper()
    wind_knots = float(wind_match.group(2).replace(",", "."))

    observed_utc = local_dt.astimezone(timezone.utc)
    age_minutes = max(
        0.0,
        (datetime.now(timezone.utc) - observed_utc).total_seconds() / 60,
    )

    if not 0 <= humidity <= 100:
        raise ValueError(f"ENKA nem değeri aralık dışında: {humidity}")
    if not 800 <= pressure <= 1100:
        raise ValueError(f"ENKA basınç değeri aralık dışında: {pressure}")
    if not 0 <= wind_knots <= 150 or not 0 <= daily_rain <= 500:
        raise ValueError("ENKA rüzgâr/yağış değeri aralık dışında.")

    return {
        "station_name": "ENKA Balmumcu",
        "station_id": "ENKA-BALMUMCU-WEATHERLINK",
        "source": "ENKA Balmumcu WeatherLink current values",
        "source_url": "https://w.enka.com/weather/currentvalues.html",
        "image_url": None,
        "latitude": 41.1,
        "longitude": 28.9,
        "elevation_m": 107,
        "observed_at_utc": observed_utc.isoformat(timespec="seconds"),
        "timestamp_date_inferred": False,
        "age_minutes": round(age_minutes, 1),
        "is_stale": age_minutes > POLL_STALE_MINUTES,
        "temperature_2m_c": temperature,
        "wind_speed_10m_kmh": round(wind_knots * 1.852, 1),
        "wind_speed_10m_knots": wind_knots,
        "wind_direction_cardinal": wind_direction,
        "wind_direction_tr": WIND_DIRECTIONS_TR.get(wind_direction),
        "precipitation_1h_mm": None,
        "precipitation_daily_mm": daily_rain,
        "humidity_percent": humidity,
        "station_pressure_hpa": pressure,
        "observation_method": "weatherlink-currentvalues-html",
    }


def fetch_enka_station_observation():
    text = _fetch_current_values_page()
    print("[ENKA CURRENT VALUES] WeatherLink:", repr(text[:1200]))
    observation = _parse_current_values(text)
    print(
        "[ENKA CURRENT VALUES] "
        f"{observation['temperature_2m_c']}°C | "
        f"{observation['humidity_percent']}% | "
        f"{observation['station_pressure_hpa']} hPa | "
        f"{observation['wind_speed_10m_knots']} kt {observation['wind_direction_cardinal']} | "
        f"{observation['precipitation_daily_mm']} mm"
    )
    return observation


def _reject_older_observation(observation):
    """Never replace the published observation with an older ENKA reading."""
    previous_path = os.getenv("STATION_PREVIOUS_OBSERVATION_PATH")
    if not previous_path:
        return
    path = Path(previous_path)
    if not path.is_file():
        return
    with path.open("r", encoding="utf-8") as source:
        previous_document = json.load(source)
    previous = previous_document.get("station_observation") or {}
    previous_time = previous.get("observed_at_utc")
    new_time = observation.get("observed_at_utc")
    if not previous_time or not new_time:
        return
    previous_dt = datetime.fromisoformat(previous_time.replace("Z", "+00:00"))
    new_dt = datetime.fromisoformat(new_time.replace("Z", "+00:00"))
    if new_dt < previous_dt:
        raise ValueError(
            "ENKA kaynağı önceki yayımlanmış ölçümden daha eski veri döndürdü; "
            "eski ölçüm Pages'e yazılmadı."
        )


def _fetch_enka_history_samples():
    """Fetch ENKA WeatherLink's exported 48-hour archive and return the latest 24 hours."""
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/4.1)",
        "Cache-Control": "no-cache, no-store, max-age=0",
        "Pragma": "no-cache",
        "Referer": "https://w.enka.com/weather/",
    }
    response = requests.get(
        HISTORY_URL,
        params={"_gfs_watch": int(time.time() * 1000)},
        headers=headers,
        timeout=25,
    )
    response.raise_for_status()
    now_local = datetime.now(TR_TZ)
    cutoff = now_local - timedelta(hours=24)
    samples = []
    pattern = re.compile(r"^\\s*(\\d{2}/\\d{2}/\\d{2})\\s+(\\d{1,2}:\\d{2})\\s+([-+]?\\d+(?:[.,]\\d+)?)\\s+")
    for line in response.text.splitlines():
        match = pattern.match(line)
        if not match:
            continue
        try:
            local_dt = datetime.strptime(
                f"{match.group(1)} {match.group(2)}", "%d/%m/%y %H:%M"
            ).replace(tzinfo=TR_TZ)
            temperature = float(match.group(3).replace(",", "."))
        except (ValueError, TypeError):
            continue
        if not math.isfinite(temperature) or not (cutoff <= local_dt <= now_local + timedelta(minutes=5)):
            continue
        observed_utc = local_dt.astimezone(timezone.utc).isoformat(timespec="seconds")
        samples.append({
            "logged_at_utc": observed_utc,
            "observed_at_utc": observed_utc,
            "temperature_2m_c": temperature,
            "station_pressure_hpa": None,
            "humidity_percent": None,
            "wind_speed_10m_kmh": None,
            "wind_direction_cardinal": None,
            "wind_direction_tr": None,
        })
    samples.sort(key=lambda sample: sample["observed_at_utc"])
    if not samples:
        raise ValueError("ENKA downld02.txt içinde son 24 saate ait sıcaklık kaydı bulunamadı.")
    print(f"[ENKA HISTORY] WeatherLink downld02: {len(samples)} sıcaklık kaydı / son 24 saat.")
    return samples


def update_temperature_history(observation):
    """Append distinct fresh ENKA measurements to a rolling 72-hour archive."""
    history_path = Path(
        os.getenv(
            "STATION_TEMPERATURE_HISTORY_PATH",
            "public/station-temperature-history.json",
        )
    )
    history_path.parent.mkdir(parents=True, exist_ok=True)

    if history_path.exists():
        with history_path.open("r", encoding="utf-8") as source:
            history = json.load(source)
        if history.get("schema") != "gfs-watch.station-temperature-history.v1":
            raise ValueError("İstasyon sıcaklık geçmişi şeması beklenenden farklı.")
        samples = history.get("samples")
        if not isinstance(samples, list):
            raise ValueError("İstasyon sıcaklık geçmişi samples alanı liste değil.")
    else:
        samples = []

    # ENKA's WeatherLink export is the authoritative source for the 24-hour
    # temperature curve. Keep OCR as a live fallback/current-point source.
    try:
        source_samples = _fetch_enka_history_samples()
        merged = {sample.get("observed_at_utc"): sample for sample in samples if sample.get("observed_at_utc")}
        for sample in source_samples:
            merged[sample["observed_at_utc"]] = sample
        samples = list(merged.values())
        print("[TEMPERATURE LOG] ENKA 24 saat geçmişi WeatherLink downld02.txt ile güncellendi.")
    except Exception as error:
        print(f"[ENKA HISTORY] WeatherLink geçmişi alınamadı; yerel OCR arşivi korunuyor: {error}")

    logged_at = datetime.now(timezone.utc)
    observed_at = observation["observed_at_utc"]
    already_logged = any(
        isinstance(sample, dict) and sample.get("observed_at_utc") == observed_at
        for sample in samples
    )

    if observation.get("is_stale") or observation.get("temperature_2m_c") is None:
        print(
            f"[TEMPERATURE LOG] Ölçüm {observation.get('age_minutes')} dk yaşında; "
            "yeni sıcaklık noktası eklenmedi."
        )
    elif already_logged:
        print(f"[TEMPERATURE LOG] {observed_at} ölçümü daha önce kaydedilmiş; tekrar eklenmedi.")
    else:
        samples.append({
            "logged_at_utc": logged_at.isoformat(timespec="seconds"),
            "observed_at_utc": observed_at,
            "temperature_2m_c": float(observation["temperature_2m_c"]),
            "station_pressure_hpa": float(observation["station_pressure_hpa"]) if observation.get("station_pressure_hpa") is not None else None,
            "humidity_percent": float(observation["humidity_percent"]) if observation.get("humidity_percent") is not None else None,
            "wind_speed_10m_kmh": float(observation["wind_speed_10m_kmh"]) if observation.get("wind_speed_10m_kmh") is not None else None,
            "wind_direction_cardinal": observation.get("wind_direction_cardinal"),
            "wind_direction_tr": observation.get("wind_direction_tr"),
            "precipitation_daily_mm": (
                float(observation["precipitation_daily_mm"])
                if observation.get("precipitation_daily_mm") is not None
                else None
            ),
        })

    retention_hours = 72
    cutoff = logged_at.timestamp() - retention_hours * 60 * 60
    retained = []
    for sample in samples:
        try:
            # Retention follows the actual camera measurement timestamp, not the
            # time this workflow happened to collect it.
            source_time = sample.get("observed_at_utc") or sample["logged_at_utc"]
            timestamp = datetime.fromisoformat(
                str(source_time).replace("Z", "+00:00")
            ).timestamp()
            temperature = float(sample["temperature_2m_c"])
            if math.isfinite(temperature) and cutoff <= timestamp <= logged_at.timestamp() + 5 * 60:
                for field in (
                    "station_pressure_hpa",
                    "humidity_percent",
                    "wind_speed_10m_kmh",
                ):
                    value = sample.get(field)
                    if value is not None and not math.isfinite(float(value)):
                        sample[field] = None
                rain = sample.get("precipitation_daily_mm")
                if rain is not None and not math.isfinite(float(rain)):
                    sample["precipitation_daily_mm"] = None
                retained.append(sample)
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    # Five-minute sampling yields at most 864 observations in 72 hours.
    retained = retained[-900:]

    document = {
        "schema": "gfs-watch.station-temperature-history.v1",
        "station_id": observation["station_id"],
        "station_name": observation["station_name"],
        "sampling_interval_minutes": 5,
        "aggregation_interval_minutes": 30,
        "retention_hours": retention_hours,
        "updated_at_utc": logged_at.isoformat(timespec="seconds"),
        "samples": retained,
    }
    temporary_path = history_path.with_suffix(history_path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(history_path)
    print(f"[TEMPERATURE LOG] {len(retained)} kayıt tutuluyor; 72 saatlik kayan arşiv.")
    return len(retained)


def main():
    observation = fetch_enka_station_observation()
    if observation.get("is_stale") or observation.get("temperature_2m_c") is None:
        raise ValueError(
            f"ENKA kamera OCR ölçümü güncel değil veya sıcaklık eksik "
            f"(yaş: {observation.get('age_minutes')} dk); eski veri yayımlanmadı."
        )
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    document = {
        "schema": "gfs-watch.station-observation.v1",
        "station_observation": observation,
        "updated_at_utc": now,
        "role": "primary",
        "source_priority": 1,
    }
    Path("public").mkdir(exist_ok=True)
    Path("public/station-observation.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    update_temperature_history(observation)
    print(
        f"[ENKA OCR PRIMARY] {observation['station_name']} | "
        f"{observation['temperature_2m_c']}°C | "
        f"{observation['wind_speed_10m_kmh']} km/sa | "
        f"ölçüm zamanı {observation['observed_at_utc']} | "
        f"ölçüm yaşı {observation['age_minutes']} dk"
    )


if __name__ == "__main__":
    main()
