#!/usr/bin/env python3
"""Poll ENKA Istinye Vantage PRO and publish only when the station timestamp changes."""
import json
import re
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

URL = "https://www.enkaspor.com/weather/currentvaluestr.html"
HOME = "https://www.enkaspor.com/weather/indextr.html"
OUT = Path("public/station-observation.json")
ISTANBUL = ZoneInfo("Europe/Istanbul")


def clean(value):
    value = re.sub(r"<script\b[^>]*>.*?</script>", " ", value, flags=re.I | re.S)
    value = re.sub(r"<style\b[^>]*>.*?</style>", " ", value, flags=re.I | re.S)
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", unescape(value)).strip()


def number(value):
    match = re.search(r"[-+]?\d+(?:[.,]\d+)?", value or "")
    return float(match.group(0).replace(",", ".")) if match else None


def fetch():
    response = requests.get(
        URL,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.0)",
            "Accept": "text/html,application/xhtml+xml",
            "Referer": HOME,
        },
        timeout=20,
    )
    response.raise_for_status()
    response.encoding = response.apparent_encoding or "utf-8"
    page = response.text
    page_text = clean(page)

    stamp = re.search(r"(\d{1,2}/\d{1,2}/\d{2,4})\s+(\d{1,2}:\d{2})", page_text)
    if not stamp:
        raise ValueError("ENKA Istinye observation timestamp not found")
    stamp_text = f"{stamp.group(1)} {stamp.group(2)}"
    observed = None
    for fmt in ("%d/%m/%y %H:%M", "%d/%m/%Y %H:%M"):
        try:
            observed = datetime.strptime(stamp_text, fmt).replace(tzinfo=ISTANBUL)
            break
        except ValueError:
            continue
    if observed is None:
        raise ValueError(f"Unrecognized ENKA timestamp: {stamp_text}")

    rows = {}
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", page, flags=re.I | re.S):
        cells = [clean(x) for x in re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", row, flags=re.I | re.S)]
        if len(cells) >= 2:
            rows[cells[0].strip().lower()] = " ".join(cells[1:])

    def row_value(*labels):
        for label, value in rows.items():
            if any(label.startswith(wanted) for wanted in labels):
                return value
        return ""

    temperature = number(row_value("günlük sıcaklık", "sıcaklık"))
    humidity = number(row_value("bağıl nem"))
    pressure = number(row_value("barometre (hpa)"))
    rain = number(row_value("günlük yağış"))
    wind_line = row_value("rüzgar-10 dakika ortalama", "rüzgar-10 dak")
    wind_speed = number(wind_line)
    direction_line = row_value("rüzgar")
    direction_match = re.search(
        r"\b(NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW|N|NE|E|SE|S|SW|W|NW)\b",
        direction_line,
        flags=re.I,
    )
    direction = direction_match.group(1).upper() if direction_match else None

    if wind_speed is None:
        wind_speed = number(direction_line)
    if any(value is None for value in (temperature, wind_speed, rain)):
        raise ValueError(
            "Incomplete ENKA Istinye data: "
            + json.dumps(
                {"temperature": temperature, "wind": wind_speed, "rain": rain,
                 "humidity": humidity, "pressure": pressure, "rows": rows},
                ensure_ascii=False,
            )
        )

    # ENKA reports wind in knots; retain the 10-minute average where available.
    observed_utc = observed.astimezone(timezone.utc)
    age = max(0.0, (datetime.now(timezone.utc) - observed_utc).total_seconds() / 60)
    return {
        "station_name": "ENKA İstinye",
        "station_id": "ENKA-ISTINYE-VANTAGE-PRO",
        "source": "ENKA İstinye Vantage PRO weather station",
        "source_url": URL,
        "station_home_url": HOME,
        "latitude": 41.1124167,
        "longitude": 29.0373833,
        "elevation_m": 113,
        "observed_at_utc": observed_utc.isoformat(timespec="seconds"),
        "age_minutes": round(age, 1),
        "is_stale": age > 90,
        "temperature_2m_c": temperature,
        "wind_speed_10m_kmh": round(wind_speed * 1.852, 1),
        "wind_speed_10m_knots": wind_speed,
        "wind_direction_cardinal": direction,
        "precipitation_1h_mm": None,
        "precipitation_daily_mm": rain,
        "humidity_percent": humidity,
        "station_pressure_hpa": pressure,
    }


def main():
    observation = fetch()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    previous = old.get("station_observation") or {}
    if previous.get("observed_at_utc") == observation["observed_at_utc"]:
        print(f"No new ENKA observation ({observation['observed_at_utc']}); no publish.")
        return
    document = {
        "schema": "gfs-watch.station-observation.v1",
        "station_observation": observation,
        "updated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    OUT.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"New ENKA İstinye observation published: {observation['observed_at_utc']}")


if __name__ == "__main__":
    main()
