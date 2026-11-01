"""Fetch the public WStatMap Eyüpsultan station page and normalize its live observation."""

import argparse
import html
import json
import math
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

TR_TZ = ZoneInfo("Europe/Istanbul")
STATION_URL = "https://wstatmap.com/tr/stations/eyupsultan-18101"
STATION_ID = "18101"
WSTAT_INTERNAL_STATION_ID = "1963"
STALE_AFTER_MINUTES = 20

WIND_DIRECTIONS = [
    ("Kuzey", "N"), ("Kuzey-kuzeydoğu", "NNE"), ("Kuzeydoğu", "NE"),
    ("Doğu-kuzeydoğu", "ENE"), ("Doğu", "E"), ("Doğu-güneydoğu", "ESE"),
    ("Güneydoğu", "SE"), ("Güney-güneydoğu", "SSE"), ("Güney", "S"),
    ("Güney-güneybatı", "SSW"), ("Güneybatı", "SW"), ("Batı-güneybatı", "WSW"),
    ("Batı", "W"), ("Batı-kuzeybatı", "WNW"), ("Kuzeybatı", "NW"),
    ("Kuzey-kuzeybatı", "NNW"),
]


def number(match, field):
    if not match:
        raise ValueError(f"WStatMap sayfasında {field} alanı bulunamadı.")
    value = float(match.group(1).replace(",", "."))
    if not math.isfinite(value):
        raise ValueError(f"WStatMap {field} değeri geçersiz.")
    return value


def fetch_page():
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.0; personal weather dashboard)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": "https://wstatmap.com/tr/",
    }
    last_error = None
    for attempt in range(3):
        try:
            response = requests.get(
                STATION_URL,
                params={"_gfs_watch": int(time.time() * 1000)},
                headers=headers,
                timeout=25,
            )
            response.raise_for_status()
            page = response.text
            if len(page) < 5000 or "Eyüpsultan" not in page or "Just a moment" in page:
                raise ValueError("WStatMap istasyon sayfası beklenen içerikle dönmedi.")
            return page
        except (requests.RequestException, ValueError) as error:
            last_error = error
            print(f"[WSTAT FETCH] Deneme {attempt + 1}/3 başarısız: {error}")
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"WStatMap sayfası üç denemede alınamadı: {last_error}")


def visible_text(page):
    page = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", page, flags=re.I | re.S)
    page = re.sub(r"</(?:div|p|span|li|h[1-6]|section|article|br|dt|dd|strong|button)>", "\n", page, flags=re.I)
    page = re.sub(r"<[^>]+>", " ", page)
    page = html.unescape(page).replace("\xa0", " ")
    return re.sub(r"[ \t\r\f\v]+", " ", page)


def fetch_observation():
    page = fetch_page()
    text = visible_text(page)

    if not re.search(r"\b18101\b", text) or not re.search(r"Eyüpsultan", text, re.I):
        raise ValueError("Sayfa beklenen Eyüpsultan 18101 istasyonuna ait değil.")

    temperature = number(re.search(r"([-+]?\d+(?:[,.]\d+)?)\s*°\s*C", text), "sıcaklık")
    humidity = number(re.search(r"Nem\s*([-+]?\d+(?:[,.]\d+)?)\s*%", text, re.I), "nem")
    wind_speed = number(
        re.search(r"Rüzgar Hızı\s*([-+]?\d+(?:[,.]\d+)?)\s*km/h", text, re.I),
        "rüzgâr hızı",
    )
    wind_direction_match = re.search(r"Rüzgar Yönü\s*(\d{1,3})\s*°", text, re.I)
    wind_degrees = int(wind_direction_match.group(1)) % 360 if wind_direction_match else None
    wind_index = int((wind_degrees + 11.25) // 22.5) % 16 if wind_degrees is not None else None
    wind_cardinal = WIND_DIRECTIONS[wind_index][1] if wind_index is not None else None
    wind_tr = WIND_DIRECTIONS[wind_index][0] if wind_index is not None else None

    daily_rain = number(
        re.search(r"Bugün\s*([-+]?\d+(?:[,.]\d+)?)\s*mm\s*yağdı", text, re.I),
        "günlük yağış",
    )
    one_hour_match = re.search(r"1sa\s*([-+]?\d+(?:[,.]\d+)?)", text, re.I)
    one_hour_rain = float(one_hour_match.group(1).replace(",", ".")) if one_hour_match else None
    pressure = number(
        re.search(r"Deniz Seviyesi Basıncı\s*hPa\s*([-+]?\d+(?:[,.]\d+)?)", text, re.I),
        "deniz seviyesi basıncı",
    )

    age_match = re.search(
        r"Canlı\s*[·•]\s*(\d+)\s*dk\.?\s*önce\s*[·•]\s*18101",
        text,
        re.I,
    )
    if not age_match:
        age_match = re.search(r"Canlı\s*[·•]\s*(\d+)\s*dk\.?\s*önce", text, re.I)
    if not age_match:
        raise ValueError("WStatMap sayfasında ölçüm yaşı okunamadı.")
    age_minutes = max(0, int(age_match.group(1)))
    fetched_at = datetime.now(timezone.utc)
    observed_at = fetched_at - timedelta(minutes=age_minutes)

    observation = {
        "station_name": "Eyüpsultan",
        "station_id": STATION_ID,
        "wstatmap_station_id": WSTAT_INTERNAL_STATION_ID,
        "source": "WStatMap · MGM 18101",
        "source_url": STATION_URL,
        "latitude": 41.102778,
        "longitude": 28.924167,
        "elevation_m": 54,
        "observed_at_utc": observed_at.isoformat(timespec="seconds"),
        "fetched_at_utc": fetched_at.isoformat(timespec="seconds"),
        "age_minutes": round(age_minutes, 1),
        "is_stale": age_minutes > STALE_AFTER_MINUTES,
        "temperature_2m_c": temperature,
        "wind_speed_10m_kmh": round(wind_speed, 1),
        "wind_direction_degrees": wind_degrees,
        "wind_direction_cardinal": wind_cardinal,
        "wind_direction_tr": wind_tr,
        "precipitation_1h_mm": one_hour_rain,
        "precipitation_daily_mm": daily_rain,
        "humidity_percent": humidity,
        "station_pressure_hpa": pressure,
        "pressure_type": "mean_sea_level",
    }

    if not (-35 <= temperature <= 55):
        raise ValueError(f"Eyüpsultan sıcaklığı makul aralık dışında: {temperature}°C")
    if not (0 <= humidity <= 100):
        raise ValueError(f"Eyüpsultan nem değeri makul aralık dışında: {humidity}%")
    if not (0 <= wind_speed <= 250):
        raise ValueError(f"Eyüpsultan rüzgâr değeri makul aralık dışında: {wind_speed} km/h")
    if not (850 <= pressure <= 1100):
        raise ValueError(f"Eyüpsultan basıncı makul aralık dışında: {pressure} hPa")
    if daily_rain < 0 or (one_hour_rain is not None and one_hour_rain < 0):
        raise ValueError("Eyüpsultan yağış değeri negatif olamaz.")
    return observation


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Fetch and validate without writing files.")
    args = parser.parse_args()

    observation = fetch_observation()
    document = {
        "schema": "gfs-watch.station-observation.v1",
        "station_observation": observation,
        "updated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    if args.dry_run:
        print(json.dumps(document, ensure_ascii=False, indent=2))
        return

    output = Path("public/eyupsultan-station-observation.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(output)
    print(
        f"[WSTAT LIVE] {observation['station_name']} | "
        f"{observation['temperature_2m_c']}°C | "
        f"{observation['wind_speed_10m_kmh']} km/sa | "
        f"{observation['humidity_percent']}% nem | "
        f"{observation['station_pressure_hpa']} hPa | "
        f"ölçüm yaşı {observation['age_minutes']} dk"
    )


if __name__ == "__main__":
    main()
