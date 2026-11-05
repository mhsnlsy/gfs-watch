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


def _fetch_camera():
    """Fetch the latest ENKA camera frame without relying on browser cache."""
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/4.1)",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Cache-Control": "no-cache, no-store, max-age=0",
        "Pragma": "no-cache",
        "Referer": HOME_URL,
    }
    last_error = None
    for attempt in range(3):
        try:
            response = requests.get(
                CURRENT_URL,
                params={"_gfs_watch": int(time.time() * 1000)},
                headers=headers,
                timeout=25,
            )
            response.raise_for_status()
            if not response.headers.get("Content-Type", "").lower().startswith("image/"):
                raise ValueError("ENKA kamera adresi görsel yerine farklı içerik döndürdü.")
            image = Image.open(io.BytesIO(response.content)).convert("RGB")
            if image.width < 300 or image.height < 200:
                raise ValueError(f"ENKA kamera görseli beklenenden küçük: {image.size}")
            return image
        except Exception as error:
            last_error = error
            print(f"[ENKA CAMERA] Deneme {attempt + 1}/3 başarısız: {error}")
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"ENKA kamera karesi üç denemede alınamadı: {last_error}")


def _ocr_region(image, box, psm=6):
    crop = image.crop(box).resize(
        ((box[2] - box[0]) * 3, (box[3] - box[1]) * 3)
    ).convert("L")
    crop = ImageEnhance.Contrast(crop).enhance(2.2)
    crop = ImageEnhance.Sharpness(crop).enhance(2.0)
    crop = crop.filter(ImageFilter.MedianFilter(size=3))
    return pytesseract.image_to_string(
        crop,
        config=f"--oem 3 --psm {psm}",
        lang="eng",
    )


def _parse_decimal(pattern, text, field):
    match = re.search(pattern, text, flags=re.I)
    if not match:
        raise ValueError(f"OCR {field} alanını okuyamadı. Okunan metin: {text!r}")
    value = float(match.group(1).replace(",", "."))
    if not math.isfinite(value):
        raise ValueError(f"OCR {field} değeri geçersiz.")
    return value


def fetch_enka_station_observation():
    image = _fetch_camera()
    width, height = image.size

    # ENKA overlays the weather values at the lower-right and timestamp
    # at the bottom-centre. Read these areas separately to reduce OCR noise.
    right = _ocr_region(image, (int(width * 0.82), int(height * 0.78), width, height - 2), 6)
    bottom = _ocr_region(image, (int(width * 0.30), int(height * 0.91), int(width * 0.72), height), 7)
    print("[ENKA OCR] Weather overlay:", repr(right))
    print("[ENKA OCR] Timestamp overlay:", repr(bottom))

    temperature_match = re.search(r"([-+]?\d{1,2}[.,]\d)\s*°?\s*C", right, flags=re.I)
    if not temperature_match:
        # ENKA camera OCR can occasionally drop the decimal point and unit.
        # Accept a standalone 3- or 4-digit token only when it is followed by
        # the known humidity/pressure structure, then normalize it as 10.x–99.x.
        compact = re.search(r"(?m)^\s*(\d{2})(\d)\s*$", right)
        if compact:
            temperature = float(f"{compact.group(1)}.{compact.group(2)}")
        else:
            temperature = _parse_decimal(r"([-+]?\d{1,2}[.,]\d)\s*°?\s*C", right, "sıcaklık")
    else:
        temperature = float(temperature_match.group(1).replace(",", "."))
    humidity = _parse_decimal(r"(\d{1,3})\s*%", right, "nem")
    pressure = _parse_decimal(r"(\d{3,4}[.,]\d)\s*hPa", right, "basınç")
    wind_match = re.search(
        r"(\d{1,2}[.,]\d)\s*(?:kt|kts)\s*([NSEW]{1,3})\b",
        right,
        flags=re.I,
    )
    if not wind_match:
        raise ValueError(f"OCR rüzgâr hız/yön alanını okuyamadı: {right!r}")
    wind_knots = float(wind_match.group(1).replace(",", "."))
    wind_direction = wind_match.group(2).upper()
    daily_rain = _parse_decimal(r"(\d{1,3}[.,]\d)\s*mm", right, "yağış")

    # ENKA's camera overlay can be noisy: dots, spaces and dashes are
    # sometimes substituted for one another, and a leading digit can be lost.
    # Accept the common separator variants, then validate the resulting date
    # against the live camera clock before using it.
    timestamp_pattern = re.compile(
        r"(?<!\d)(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4})\D+"
        r"(\d{1,2}):(\d{2}):(\d{2})"
    )
    timestamp_text = bottom
    timestamp_match = timestamp_pattern.search(timestamp_text)
    if not timestamp_match:
        # Tesseract may place the date outside the narrow bottom-centre crop.
        timestamp_text = _ocr_region(image, (0, int(height * 0.91), width, height), 7)
        print("[ENKA OCR] Full-width timestamp overlay:", repr(timestamp_text))
        timestamp_match = timestamp_pattern.search(timestamp_text)
    if not timestamp_match:
        raise ValueError(
            "OCR kamera zaman damgasını okuyamadı. "
            f"Alt alan: {bottom!r}; geniş alan: {timestamp_text!r}"
        )

    day, month, year, hour, minute, second = map(int, timestamp_match.groups())
    now_local = datetime.now(TR_TZ)
    timestamp_date_inferred = False
    try:
        observed_local = datetime(year, month, day, hour, minute, second, tzinfo=TR_TZ)
    except ValueError:
        observed_local = None

    # If OCR mangled the date but retained a clock time matching the freshly
    # fetched camera frame, use the nearest Istanbul calendar date. Never do
    # this for a clock time that is not within five minutes of the live fetch.
    clock_seconds = hour * 3600 + minute * 60 + second
    now_seconds = now_local.hour * 3600 + now_local.minute * 60 + now_local.second
    clock_delta = abs(clock_seconds - now_seconds)
    clock_delta = min(clock_delta, 86400 - clock_delta)
    date_needs_recovery = (
        observed_local is None
        or abs((now_local - observed_local).total_seconds()) > POLL_STALE_MINUTES * 60
    )
    if date_needs_recovery and clock_delta <= 5 * 60:
        candidate_dates = [
            now_local.date() + timedelta(days=offset) for offset in (-1, 0, 1)
        ]
        candidates = [
            datetime(
                candidate_date.year, candidate_date.month, candidate_date.day,
                hour, minute, second, tzinfo=TR_TZ
            )
            for candidate_date in candidate_dates
        ]
        nearest = min(candidates, key=lambda value: abs((now_local - value).total_seconds()))
        if abs((now_local - nearest).total_seconds()) <= 5 * 60:
            observed_local = nearest
            timestamp_date_inferred = True

    if observed_local is None:
        raise ValueError(f"OCR kamera tarihi geçersiz: {timestamp_text!r}")
    if timestamp_date_inferred:
        print(
            "[ENKA OCR] Tarih kısmı OCR tarafından hatalı okundu; "
            "kamera saati canlı çekimle eşleştiği için İstanbul tarihi düzeltildi."
        )

    observed_utc = observed_local.astimezone(timezone.utc)

    if not 0 <= humidity <= 100:
        raise ValueError(f"OCR nem değeri aralık dışında: {humidity}")
    if not 800 <= pressure <= 1100:
        raise ValueError(f"OCR basınç değeri aralık dışında: {pressure}")
    if not 0 <= wind_knots <= 150 or not 0 <= daily_rain <= 500:
        raise ValueError("OCR rüzgâr/yağış değeri aralık dışında.")

    age_minutes = max(
        0.0,
        (datetime.now(timezone.utc) - observed_utc).total_seconds() / 60,
    )
    return {
        "station_name": "ENKA Balmumcu",
        "station_id": "ENKA-BALMUMCU-CAMERA-OCR",
        "source": "ENKA Balmumcu live camera image OCR",
        "source_url": HOME_URL,
        "image_url": CURRENT_URL,
        "latitude": 41.1,
        "longitude": 28.9,
        "elevation_m": 107,
        "observed_at_utc": observed_utc.isoformat(timespec="seconds"),
        "timestamp_date_inferred": timestamp_date_inferred,
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
        "observation_method": "tesseract-ocr",
        "ocr_regions": {"weather_overlay": right.strip(), "timestamp_overlay": bottom.strip()},
    }


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
