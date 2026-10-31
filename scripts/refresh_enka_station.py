#!/usr/bin/env python3
"""Lightweight ENKA Balmumcu station poller; updates data only for a new observation."""
import json
import re
import os
from datetime import datetime, timezone
from html import unescape
from pathlib import Path

import requests

URL = "https://w.enka.com/weather/currentvalues.html"
HOME = "https://w.enka.com/weather/index.html"
OUT = Path("public/station-observation.json")


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
    stamp = re.search(
        r"As\s+of\s*:?[ ]*(\d{1,2}/\d{1,2}/\d{2,4})\s+(\d{1,2}:\d{2})",
        page_text,
        flags=re.I,
    )
    if not stamp:
        raise ValueError("ENKA observation timestamp not found")
    stamp_text = f"{stamp.group(1)} {stamp.group(2)}"
    observed = None
    for fmt in ("%d/%m/%y %H:%M", "%d/%m/%Y %H:%M", "%m/%d/%y %H:%M"):
        try:
            observed = datetime.strptime(stamp_text, fmt).replace(tzinfo=__import__("zoneinfo").ZoneInfo("Europe/Istanbul"))
            break
        except ValueError:
            pass
    if observed is None:
        raise ValueError(f"Unrecognized ENKA timestamp: {stamp_text}")

    values = {}
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", page, flags=re.I | re.S):
        cells = [clean(x) for x in re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", row, flags=re.I | re.S)]
        if len(cells) < 2:
            continue
        label, value = cells[0].strip().lower(), cells[1]
        if "day temperature" in label or label == "temperature":
            values["temperature"] = number(value)
        elif label == "humidity":
            values["humidity"] = number(value)
        elif "wind - 10 min avg" in label or "wind – 10 min avg" in label:
            values["wind_knots"] = number(value)
        elif label == "wind":
            direction = re.match(r"\s*(NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW|N|NE|E|SE|S|SW|W|NW)\b", value, flags=re.I)
            values["direction"] = direction.group(1).upper() if direction else None
            values.setdefault("wind_knots", number(value))
        elif label == "daily rain":
            values["rain"] = number(value)
        elif label.startswith("barometer (hpa)"):
            values["pressure"] = number(value)

    if any(values.get(k) is None for k in ("temperature", "wind_knots", "rain")):
        raise ValueError(f"Incomplete ENKA data: {values}")

    observed_utc = observed.astimezone(timezone.utc)
    age = max(0.0, (datetime.now(timezone.utc) - observed_utc).total_seconds() / 60)
    return {
        "station_name": "ENKA Balmumcu",
        "station_id": "ENKA-BALMUMCU-VANTAGE-PRO",
        "source": "ENKA Balmumcu Vantage PRO weather station",
        "source_url": URL,
        "station_home_url": HOME,
        "latitude": 41.1,
        "longitude": 28.9,
        "elevation_m": 107,
        "observed_at_utc": observed_utc.isoformat(timespec="seconds"),
        "age_minutes": round(age, 1),
        "is_stale": age > 90,
        "temperature_2m_c": values["temperature"],
        "wind_speed_10m_kmh": round(values["wind_knots"] * 1.852, 1),
        "wind_speed_10m_knots": values["wind_knots"],
        "wind_direction_cardinal": values.get("direction"),
        "precipitation_1h_mm": None,
        "precipitation_daily_mm": values["rain"],
        "humidity_percent": values.get("humidity"),
        "station_pressure_hpa": values.get("pressure"),
    }


def main():
    observation = fetch()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    old = {}
    if OUT.exists():
        old = json.loads(OUT.read_text(encoding="utf-8"))
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
    print(f"New ENKA observation published: {observation['observed_at_utc']}")


if __name__ == "__main__":
    main()
