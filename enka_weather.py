"""Fetch and publish the live ENKA Balmumcu Vantage PRO observation."""

import json
import math
import os
import re
import time
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

TR_TZ = ZoneInfo("Europe/Istanbul")
CURRENT_URL = "https://w.enka.com/weather/currentvalues.html"
HOME_URL = "https://w.enka.com/weather/index.html"
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


def _clean_html(fragment):
    fragment = re.sub(r"<script\\b[^>]*>.*?</script>", " ", fragment, flags=re.I | re.S)
    fragment = re.sub(r"<style\\b[^>]*>.*?</style>", " ", fragment, flags=re.I | re.S)
    fragment = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\\s+", " ", unescape(fragment)).strip()


def _number(value):
    match = re.search(r"[-+]?\\d+(?:[.,]\\d+)?", value or "")
    if not match:
        return None
    try:
        result = float(match.group(0).replace(",", "."))
    except ValueError:
        return None
    return result if math.isfinite(result) else None


def _text_number(page_text, pattern):
    match = re.search(pattern, page_text, flags=re.I)
    return _number(match.group(1)) if match else None


def _fetch_page():
    """Fetch a cache-busted ENKA page, retrying transient network errors."""
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.1)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
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
                timeout=20,
            )
            response.raise_for_status()
            response.encoding = response.apparent_encoding or "utf-8"
            page = response.text
            if len(page) < 300:
                raise ValueError(f"ENKA yanıtı beklenenden kısa ({len(page)} karakter).")
            return page
        except (requests.RequestException, ValueError) as error:
            last_error = error
            print(f"[ENKA FETCH] Deneme {attempt + 1}/3 başarısız: {error}")
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"ENKA sayfası üç denemede alınamadı: {last_error}")


def fetch_enka_station_observation():
    page = _fetch_page()
    page_text = _clean_html(page)

    timestamp_match = re.search(
        r"As\\s+of\\s*:?\\s*(\\d{1,2}/\\d{1,2}/\\d{2,4})\\s+(\\d{1,2}:\\d{2})",
        page_text,
        flags=re.I,
    )
    if not timestamp_match:
        raise ValueError("ENKA sayfasında ölçüm zaman damgası bulunamadı.")

    timestamp_text = f"{timestamp_match.group(1)} {timestamp_match.group(2)}"
    observed_local = None
    for date_format in ("%d/%m/%y %H:%M", "%d/%m/%Y %H:%M", "%m/%d/%y %H:%M"):
        try:
            observed_local = datetime.strptime(timestamp_text, date_format).replace(tzinfo=TR_TZ)
            break
        except ValueError:
            continue
    if observed_local is None:
        raise ValueError(f"ENKA zaman damgası çözümlenemedi: {timestamp_text}")
    observed_utc = observed_local.astimezone(timezone.utc)

    # First parse the traditional HTML table. ENKA has used more than one
    # table layout, so text-pattern fallbacks below cover the rendered layout.
    rows = []
    for row_html in re.findall(r"<tr\\b[^>]*>(.*?)</tr>", page, flags=re.I | re.S):
        cells = re.findall(r"<t[dh]\\b[^>]*>(.*?)</t[dh]>", row_html, flags=re.I | re.S)
        cleaned = [_clean_html(cell) for cell in cells]
        if len(cleaned) >= 2:
            rows.append(cleaned)

    temperature = humidity = wind_knots = wind_direction = daily_rain = pressure = None
    for cells in rows:
        label = cells[0].strip().lower().rstrip(".")
        value = cells[1]
        if "day temperature" in label or label == "temperature":
            temperature = _number(value)
        elif label == "humidity":
            humidity = _number(value)
        elif "wind - 10 min avg" in label or "wind – 10 min avg" in label:
            wind_knots = _number(value)
        elif label == "wind":
            direction = re.match(rf"\\s*({WIND_PATTERN})\\b", value, flags=re.I)
            if direction:
                wind_direction = direction.group(1).upper()
            if wind_knots is None:
                wind_knots = _number(value)
        elif label == "daily rain":
            daily_rain = _number(value)
        elif label.startswith("barometer (hpa)"):
            pressure = _number(value)

    # Fallbacks parse the actual visible ENKA labels even if the page stops
    # using table rows/cells or changes the number of columns.
    if temperature is None:
        temperature = _text_number(
            page_text,
            r"\\bDay\\s+Temperature\\s*: ?([-+]?\\d+(?:[.,]\\d+)?)\\s*°?\\s*C\\b",
        )
    if humidity is None:
        humidity = _text_number(
            page_text,
            r"\\bHumidity\\s*: ?([-+]?\\d+(?:[.,]\\d+)?)\\s*%",
        )
    if wind_knots is None:
        wind_knots = _text_number(
            page_text,
            r"\\bWind\\s*[-–—]\\s*10\\s*Min(?:ute)?s?\\s*Avg\\.?\\s*: ?([-+]?\\d+(?:[.,]\\d+)?)\\s*kt\\b",
        )
    if wind_direction is None:
        direction_match = re.search(
            rf"\\bWind\\s+({WIND_PATTERN})\\s+[-+]?\\d+(?:[.,]\\d+)?\\s*kt\\b",
            page_text,
            flags=re.I,
        )
        if direction_match:
            wind_direction = direction_match.group(1).upper()
    if daily_rain is None:
        daily_rain = _text_number(
            page_text,
            r"\\bDaily\\s+Rain\\s*: ?([-+]?\\d+(?:[.,]\\d+)?)\\s*mm\\b",
        )
    if pressure is None:
        pressure = _text_number(
            page_text,
            r"\\bBarometer\\s*\\(hPa\\)\\s*: ?([-+]?\\d+(?:[.,]\\d+)?)",
        )

    missing = [
        name for name, value in (
            ("temperature", temperature),
            ("10-min wind", wind_knots),
            ("daily rain", daily_rain),
        ) if value is None
    ]
    if missing:
        raise ValueError(
            "ENKA ölçüm alanları okunamadı: "
            + ", ".join(missing)
            + f". Sayfa uzunluğu={len(page)} karakter."
        )

    age_minutes = max(
        0.0,
        (datetime.now(timezone.utc) - observed_utc).total_seconds() / 60,
    )
    return {
        "station_name": "ENKA Balmumcu",
        "station_id": "ENKA-BALMUMCU-VANTAGE-PRO",
        "source": "ENKA Balmumcu Vantage PRO weather station",
        "source_url": CURRENT_URL,
        "station_home_url": HOME_URL,
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
    """Append one point per distinct fresh ENKA measurement to the 7-day log."""
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
        })

    cutoff = logged_at.timestamp() - 7 * 24 * 60 * 60
    retained = []
    for sample in samples:
        try:
            timestamp = datetime.fromisoformat(
                str(sample["logged_at_utc"]).replace("Z", "+00:00")
            ).timestamp()
            temperature = float(sample["temperature_2m_c"])
            if math.isfinite(temperature) and timestamp >= cutoff:
                retained.append(sample)
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    retained = retained[-2016:]

    document = {
        "schema": "gfs-watch.station-temperature-history.v1",
        "station_id": observation["station_id"],
        "station_name": observation["station_name"],
        "sampling_interval_minutes": 5,
        "aggregation_interval_minutes": 90,
        "retention_days": 7,
        "updated_at_utc": logged_at.isoformat(timespec="seconds"),
        "samples": retained,
    }
    temporary_path = history_path.with_suffix(history_path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\\n",
        encoding="utf-8",
    )
    temporary_path.replace(history_path)
    print(f"[TEMPERATURE LOG] {len(retained)} kayıt tutuluyor; 7 günlük kayan arşiv.")
    return len(retained)


def main():
    observation = fetch_enka_station_observation()
    _reject_older_observation(observation)

    document = {
        "schema": "gfs-watch.station-observation.v1",
        "station_observation": observation,
        "updated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    Path("public").mkdir(exist_ok=True)
    Path("public/station-observation.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\\n",
        encoding="utf-8",
    )
    update_temperature_history(observation)
    print(
        f"[ENKA LIVE] {observation['station_name']} | "
        f"{observation['temperature_2m_c']}°C | "
        f"{observation['wind_speed_10m_kmh']} km/sa | "
        f"ölçüm zamanı {observation['observed_at_utc']} | "
        f"ölçüm yaşı {observation['age_minutes']} dk"
    )


if __name__ == "__main__":
    main()
