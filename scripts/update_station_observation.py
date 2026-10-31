#!/usr/bin/env python3
"""Fetch ENKA Balmumcu Vantage PRO live observations for GFS Watch."""
import json
import math
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from html import unescape
from zoneinfo import ZoneInfo

import requests

ENKA_CURRENT_URL = "https://w.enka.com/weather/currentvalues.html"
ENKA_HOME_URL = "https://w.enka.com/weather/index.html"
ISTANBUL_TZ = ZoneInfo("Europe/Istanbul")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.0)",
    "Accept": "text/html,application/xhtml+xml",
    "Referer": ENKA_HOME_URL,
}


def finite_number(value):
    try:
        result = float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def clean_html(fragment):
    fragment = re.sub(r"<script\b[^>]*>.*?</script>", " ", fragment, flags=re.I | re.S)
    fragment = re.sub(r"<style\b[^>]*>.*?</style>", " ", fragment, flags=re.I | re.S)
    fragment = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", unescape(fragment)).strip()


def first_number(text):
    match = re.search(r"[-+]?\d+(?:[.,]\d+)?", text or "")
    return finite_number(match.group(0)) if match else None


def fetch_observation():
    response = requests.get(ENKA_CURRENT_URL, headers=HEADERS, timeout=25)
    response.raise_for_status()
    response.encoding = response.apparent_encoding or "utf-8"
    page = response.text
    page_text = clean_html(page)

    timestamp_match = re.search(
        r"As\s+of\s*:?\s*(\d{1,2}/\d{1,2}/\d{2,4})\s+(\d{1,2}:\d{2})",
        page_text,
        flags=re.I,
    )
    if not timestamp_match:
        raise ValueError("ENKA current values page has no readable observation timestamp.")

    timestamp_text = f"{timestamp_match.group(1)} {timestamp_match.group(2)}"
    observed_local = None
    for date_format in ("%d/%m/%y %H:%M", "%d/%m/%Y %H:%M", "%m/%d/%y %H:%M"):
        try:
            observed_local = datetime.strptime(timestamp_text, date_format).replace(
                tzinfo=ISTANBUL_TZ
            )
            break
        except ValueError:
            continue
    if observed_local is None:
        raise ValueError(f"Unrecognized ENKA timestamp: {timestamp_text}")
    observed_utc = observed_local.astimezone(timezone.utc)

    rows = []
    for row_html in re.findall(r"<tr\b[^>]*>(.*?)</tr>", page, flags=re.I | re.S):
        cells = re.findall(
            r"<t[dh]\b[^>]*>(.*?)</t[dh]>",
            row_html,
            flags=re.I | re.S,
        )
        cleaned = [clean_html(cell) for cell in cells]
        if len(cleaned) >= 2:
            rows.append(cleaned)

    temperature = None
    humidity = None
    wind_speed_knots = None
    wind_direction = None
    daily_rain = None
    pressure = None
    for cells in rows:
        label = cells[0].strip().lower()
        value_text = " ".join(cells[1:])
        if "day temperature" in label or label == "temperature":
            temperature = first_number(cells[1])
        elif "humidity" == label:
            humidity = first_number(cells[1])
        elif "wind - 10 min avg" in label or "wind – 10 min avg" in label:
            wind_speed_knots = first_number(cells[1])
        elif label == "wind":
            wind_text = cells[1]
            direction_match = re.match(
                r"\s*(NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW|N|NE|E|SE|S|SW|W|NW)\b",
                wind_text,
                flags=re.I,
            )
            if direction_match:
                wind_direction = direction_match.group(1).upper()
            if wind_speed_knots is None:
                wind_speed_knots = first_number(wind_text)
        elif label == "daily rain":
            daily_rain = first_number(cells[1])
        elif label.startswith("barometer (hpa)"):
            pressure = first_number(cells[1])

    if temperature is None or wind_speed_knots is None or daily_rain is None:
        raise ValueError(
            "ENKA current values are incomplete: "
            f"temperature={temperature}, wind_kt={wind_speed_knots}, daily_rain={daily_rain}; "
            "refusing to publish partial or fabricated live values."
        )

    age_minutes = max(
        0.0,
        (datetime.now(timezone.utc) - observed_utc).total_seconds() / 60.0,
    )
    return {
        "station_name": "ENKA Balmumcu",
        "station_id": "ENKA-BALMUMCU-VANTAGE-PRO",
        "source": "ENKA Balmumcu Vantage PRO weather station",
        "source_url": ENKA_CURRENT_URL,
        "station_home_url": ENKA_HOME_URL,
        "latitude": 41.1,
        "longitude": 28.9,
        "elevation_m": 107,
        "observed_at_utc": observed_utc.isoformat(timespec="seconds"),
        "age_minutes": round(age_minutes, 1),
        "is_stale": age_minutes > 90,
        "temperature_2m_c": temperature,
        "wind_speed_10m_kmh": round(wind_speed_knots * 1.852, 1),
        "wind_speed_10m_knots": wind_speed_knots,
        "wind_direction_cardinal": wind_direction,
        "precipitation_1h_mm": None,
        "precipitation_daily_mm": daily_rain,
        "humidity_percent": humidity,
        "station_pressure_hpa": pressure,
    }


def main():
    target = (
        sys.argv[1]
        if len(sys.argv) > 1
        else "forecast-data/public/station-observation.json"
    )
    station = fetch_observation()
    document = {
        "schema": "gfs-watch.station-observation.v1",
        "station_observation": station,
        "updated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    if os.path.isfile(target):
        with open(target, "r", encoding="utf-8") as source:
            previous_document = json.load(source)
        if previous_document.get("station_observation") == station:
            print(
                f"[STATION UNCHANGED] ENKA Balmumcu observation "
                f"{station['observed_at_utc']} is already published."
            )
            return

    directory = os.path.dirname(os.path.abspath(target))
    os.makedirs(directory, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        prefix=".station-observation-", suffix=".tmp", dir=directory
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(
                document, output, ensure_ascii=False, indent=2, allow_nan=False
            )
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)

    print(
        f"[STATION UPDATED] ENKA Balmumcu | "
        f"{station['temperature_2m_c']} °C | "
        f"daily rain {station['precipitation_daily_mm']} mm | "
        f"wind {station['wind_speed_10m_kmh']} km/h | "
        f"{station['observed_at_utc']} UTC"
    )


if __name__ == "__main__":
    main()
