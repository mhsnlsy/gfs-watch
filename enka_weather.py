"""Fetch the live ENKA Balmumcu Vantage PRO observation."""
import json
import math
import os
import re
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

TR_TZ = ZoneInfo("Europe/Istanbul")
CURRENT_URL = "https://w.enka.com/weather/currentvalues.html"
HOME_URL = "https://w.enka.com/weather/index.html"

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


def _clean_html(fragment):
    fragment = re.sub(r"<script\b[^>]*>.*?</script>", " ", fragment, flags=re.I | re.S)
    fragment = re.sub(r"<style\b[^>]*>.*?</style>", " ", fragment, flags=re.I | re.S)
    fragment = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", unescape(fragment)).strip()


def _number(value):
    match = re.search(r"[-+]?\d+(?:[.,]\d+)?", value or "")
    if not match:
        return None
    try:
        result = float(match.group(0).replace(",", "."))
    except ValueError:
        return None
    return result if math.isfinite(result) else None


def fetch_enka_station_observation():
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.0)",
        "Accept": "text/html,application/xhtml+xml",
        "Referer": HOME_URL,
    }
    response = requests.get(CURRENT_URL, headers=headers, timeout=25)
    response.raise_for_status()
    response.encoding = response.apparent_encoding or "utf-8"
    page = response.text
    page_text = _clean_html(page)

    timestamp_match = re.search(
        r"As\s+of\s*:?\s*(\d{1,2}/\d{1,2}/\d{2,4})\s+(\d{1,2}:\d{2})",
        page_text, flags=re.I,
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
            pass
    if observed_local is None:
        raise ValueError(f"ENKA zaman damgası çözümlenemedi: {timestamp_text}")
    observed_utc = observed_local.astimezone(timezone.utc)

    rows = []
    for row_html in re.findall(r"<tr\b[^>]*>(.*?)</tr>", page, flags=re.I | re.S):
        cells = re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", row_html, flags=re.I | re.S)
        cleaned = [_clean_html(cell) for cell in cells]
        if len(cleaned) >= 2:
            rows.append(cleaned)

    temperature = humidity = wind_knots = wind_direction = daily_rain = pressure = None
    for cells in rows:
        label = cells[0].strip().lower()
        if "day temperature" in label or label == "temperature":
            temperature = _number(cells[1])
        elif label == "humidity":
            humidity = _number(cells[1])
        elif "wind - 10 min avg" in label or "wind – 10 min avg" in label:
            wind_knots = _number(cells[1])
        elif label == "wind":
            wind_text = cells[1]
            direction = re.match(
                r"\s*(NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW|N|NE|E|SE|S|SW|W|NW)\b",
                wind_text, flags=re.I,
            )
            if direction:
                wind_direction = direction.group(1).upper()
            if wind_knots is None:
                wind_knots = _number(wind_text)
        elif label == "daily rain":
            daily_rain = _number(cells[1])
        elif label.startswith("barometer (hpa)"):
            pressure = _number(cells[1])

    if temperature is None or wind_knots is None or daily_rain is None:
        raise ValueError(
            f"ENKA ölçüm alanları eksik: T={temperature}, wind_kt={wind_knots}, rain={daily_rain}"
        )
    age_minutes = max(0.0, (datetime.now(timezone.utc) - observed_utc).total_seconds() / 60)
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
        "is_stale": age_minutes > 90,
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


def update_temperature_history(observation):
    """Append this poll's fresh temperature sample to a rolling seven-day log."""
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

    # Do not create a new point from an old/stale reading.
    if observation.get("is_stale") or observation.get("temperature_2m_c") is None:
        print(
            "[TEMPERATURE LOG] ENKA ölçümü eski veya geçersiz; "
            "bu kontrol için yeni sıcaklık kaydı eklenmedi."
        )
        return len(samples)

    logged_at = datetime.now(timezone.utc)
    samples.append({
        "logged_at_utc": logged_at.isoformat(timespec="seconds"),
        "observed_at_utc": observation["observed_at_utc"],
        "temperature_2m_c": float(observation["temperature_2m_c"]),
    })

    # Keep seven days: 2,016 samples at the intended five-minute cadence.
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
        json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(history_path)
    print(
        f"[TEMPERATURE LOG] {observation['temperature_2m_c']}°C kaydedildi; "
        f"toplam {len(retained)} kayıt, 7 günlük kayan arşiv."
    )
    return len(retained)


def main():
    observation = fetch_enka_station_observation()
    document = {
        "schema": "gfs-watch.station-observation.v1",
        "station_observation": observation,
        "updated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    Path("public").mkdir(exist_ok=True)
    Path("public/station-observation.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    update_temperature_history(observation)
    print(
        f"[ENKA LIVE] {observation['station_name']} | "
        f"{observation['temperature_2m_c']}°C | "
        f"{observation['wind_speed_10m_kmh']} km/sa | "
        f"ölçüm yaşı {observation['age_minutes']} dk"
    )


if __name__ == "__main__":
    main()
