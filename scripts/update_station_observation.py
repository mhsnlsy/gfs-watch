#!/usr/bin/env python3
"""Refresh the live MGM Eyüpsultan station observation in the published forecast JSON."""
import json
import math
import os
import sys
import tempfile
from datetime import datetime, timezone

import requests

BASE_URL = "https://servis.mgm.gov.tr"
STATION_NUMBER = 18101
STATION_PAGE = "https://wstatmap.com/stations/eyupsultan-18101"
HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.0)",
    "Origin": "https://www.mgm.gov.tr",
    "Referer": "https://www.mgm.gov.tr/",
}


def number(value):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(result) or result <= -9000:
        return None
    return result


def parse_time(value):
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def fetch_observation():
    session = requests.Session()
    session.headers.update(HEADERS)

    response = session.get(
        f"{BASE_URL}/web/merkezler",
        params={"il": "istanbul"},
        timeout=20,
    )
    response.raise_for_status()
    centres = response.json()
    if not isinstance(centres, list):
        raise ValueError("MGM centre response is not a JSON array.")

    centre = next(
        (
            item for item in centres
            if any(
                str(item.get(key, "")).strip() == str(STATION_NUMBER)
                for key in (
                    "sondurumIstNo", "istNo", "istasyonNo",
                    "sonDurumIstNo", "sondurumIstasyonNo",
                )
            )
        ),
        None,
    )
    if not centre:
        stations_response = session.get(
            f"{BASE_URL}/web/istasyonlar",
            timeout=20,
        )
        stations_response.raise_for_status()
        all_stations = stations_response.json()
        station_matches = [
            item for item in all_stations
            if str(item.get("istNo", "")).strip() == str(STATION_NUMBER)
        ] if isinstance(all_stations, list) else []
        if station_matches:
            centre = station_matches[0]
            print(
                f"[MGM STATION MATCH] {station_matches[0].get('istAd')} "
                f"istNo={station_matches[0].get('istNo')} "
                f"ilce={station_matches[0].get('ilce')}"
            )
        else:
            raise LookupError(
                f"Station {STATION_NUMBER} was not found in MGM centre or station inventories."
            )

    centre_id = (
        centre.get("merkezId")
        or centre.get("merkezid")
        or centre.get("istNo")
        or STATION_NUMBER
    )

    response = session.get(
        f"{BASE_URL}/web/sondurumlar",
        params={"merkezid": centre_id},
        timeout=20,
    )
    response.raise_for_status()
    observations = response.json()
    if not isinstance(observations, list) or not observations:
        raise LookupError("MGM returned an empty station observation.")

    observation = next(
        (
            item for item in observations
            if str(item.get("istNo", "")).strip() == str(STATION_NUMBER)
        ),
        None,
    )
    if observation is None:
        raise LookupError(
            "MGM observation station number does not match Eyüpsultan 18101."
        )

    observed_at = observation.get("veriZamani")
    if not observed_at:
        raise ValueError("MGM observation has no veriZamani timestamp.")

    observed_dt = parse_time(observed_at)
    age_minutes = max(
        0.0,
        (datetime.now(timezone.utc) - observed_dt).total_seconds() / 60.0,
    )
    result = {
        "station_name": "Eyüpsultan",
        "station_number": STATION_NUMBER,
        "source": "MGM official station observations via WStatMap station 18101",
        "source_url": STATION_PAGE,
        "observed_at_utc": observed_dt.isoformat(timespec="seconds"),
        "is_stale": age_minutes > 90,
        "temperature_2m_c": number(observation.get("sicaklik")),
        "wind_speed_10m_kmh": number(observation.get("ruzgarHiz")),
        "wind_direction_degrees": number(observation.get("ruzgarYon")),
        "precipitation_1h_mm": number(observation.get("yagis1Saat")),
        "precipitation_10m_mm": number(observation.get("yagis10Dk")),
        "precipitation_6h_mm": number(observation.get("yagis6Saat")),
        "precipitation_24h_mm": number(observation.get("yagis24Saat")),
        "humidity_percent": number(observation.get("nem")),
        "station_pressure_hpa": number(observation.get("aktuelBasinc")),
        "sea_level_pressure_hpa": number(
            observation.get("denizeIndirgenmisBasinc")
        ),
    }
    if all(
        result[field] is None
        for field in (
            "temperature_2m_c",
            "wind_speed_10m_kmh",
            "precipitation_1h_mm",
        )
    ):
        raise ValueError("MGM returned no usable temperature, wind or precipitation.")

    return result


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
                f"[STATION UNCHANGED] Eyüpsultan 18101 observation "
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
        f"[STATION UPDATED] Eyüpsultan 18101 | "
        f"{station['temperature_2m_c']} °C | "
        f"{station['precipitation_1h_mm']} mm/1h | "
        f"{station['wind_speed_10m_kmh']} km/h | "
        f"{station['observed_at_utc']} UTC"
    )

if __name__ == "__main__":
    main()
