"""Fetch and publish the live ENKA Balmumcu Vantage PRO observation."""

import json
import io
import math
import os
import re
import time
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
import pytesseract
from PIL import Image, ImageEnhance, ImageFilter

TR_TZ = ZoneInfo("Europe/Istanbul")
CURRENT_URL = "https://w.enka.com/camhd/cam1/c.jpg"
HOME_URL = "https://w.enka.com/camhd/cam1/index.html"
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

    temperature = _parse_decimal(r"([-+]?\d{1,2}[.,]\d)\s*°?\s*C", right, "sıcaklık")
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

    timestamp_match = re.search(
        r"(\d{1,2})[-/](\d{1,2})[-/](\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})",
        bottom,
    )
    if not timestamp_match:
        # Tesseract may place the date in the right-side crop on some frames.
        timestamp_match = re.search(
            r"(\d{1,2})[-/](\d{1,2})[-/](\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})",
            _ocr_region(image, (0, int(height * 0.91), width, height), 7),
        )
    if not timestamp_match:
        raise ValueError(f"OCR kamera zaman damgasını okuyamadı: {bottom!r}")

    day, month, year, hour, minute, second = map(int, timestamp_match.groups())
    observed_local = datetime(year, month, day, hour, minute, second, tzinfo=TR_TZ)
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


def update_temperature_history(observation):
    """Append one point per distinct fresh ENKA measurement to the 14-day log."""
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
            "precipitation_daily_mm": (
                float(observation["precipitation_daily_mm"])
                if observation.get("precipitation_daily_mm") is not None
                else None
            ),
        })

    cutoff = logged_at.timestamp() - 14 * 24 * 60 * 60
    retained = []
    for sample in samples:
        try:
            timestamp = datetime.fromisoformat(
                str(sample["logged_at_utc"]).replace("Z", "+00:00")
            ).timestamp()
            temperature = float(sample["temperature_2m_c"])
            if math.isfinite(temperature) and timestamp >= cutoff:
                rain = sample.get("precipitation_daily_mm")
                if rain is not None and not math.isfinite(float(rain)):
                    sample["precipitation_daily_mm"] = None
                retained.append(sample)
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    retained = retained[-4500:]

    document = {
        "schema": "gfs-watch.station-temperature-history.v1",
        "station_id": observation["station_id"],
        "station_name": observation["station_name"],
        "sampling_interval_minutes": 5,
        "aggregation_interval_minutes": 30,
        "retention_days": 14,
        "updated_at_utc": logged_at.isoformat(timespec="seconds"),
        "samples": retained,
    }
    temporary_path = history_path.with_suffix(history_path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(history_path)
    print(f"[TEMPERATURE LOG] {len(retained)} kayıt tutuluyor; 14 günlük kayan arşiv.")
    return len(retained)


def main():
    observation = fetch_enka_station_observation()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    document = {
        "schema": "gfs-watch.station-observation.v1",
        "station_observation": observation,
        "updated_at_utc": now,
        "role": "backup",
        "source_priority": 2,
    }
    Path("public").mkdir(exist_ok=True)

    # Always retain the camera-derived reading separately, even when the
    # primary ENKA station feed is healthy.
    backup_path = Path(os.getenv("ENKA_CAMERA_BACKUP_PATH", "public/station-camera-backup.json"))
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    backup_path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )

    history_override = os.getenv("ENKA_CAMERA_BACKUP_HISTORY_PATH")
    if history_override:
        os.environ["STATION_TEMPERATURE_HISTORY_PATH"] = history_override
    update_temperature_history(observation)

    if os.getenv("ENKA_CAMERA_FALLBACK", "0") == "1":
        _reject_older_observation(observation)
        fallback_document = dict(document)
        fallback_document["role"] = "active-fallback"
        fallback_document["source_priority"] = 2
        Path("public/station-observation.json").write_text(
            json.dumps(fallback_document, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
            encoding="utf-8",
        )
        print("[ENKA FALLBACK] Camera OCR reading promoted because primary feed failed.")
    else:
        print("[ENKA BACKUP] Camera OCR archived; primary station data remains active.")

    print(
        f"[ENKA CAMERA] {observation['station_name']} | "
        f"{observation['temperature_2m_c']}°C | "
        f"{observation['wind_speed_10m_kmh']} km/sa | "
        f"ölçüm zamanı {observation['observed_at_utc']} | "
        f"ölçüm yaşı {observation['age_minutes']} dk"
    )


if __name__ == "__main__":
    main()
