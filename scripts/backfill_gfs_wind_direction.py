"""Fast backfill of the first 72 hours of native GFS 10 m wind direction.

The main forecast JSON can predate the wind-direction export field. The decoded
NOAA cache already contains the native 10 m U/V vectors, so this repair reads
those compact cached values first and only fetches missing GRIB leads.
"""
from __future__ import annotations

import json
import math
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

MAX_DIRECTION_HOUR = 72
MIN_WIND_SPEED_KMH = 0.72
FETCH_WORKERS = max(2, min(6, int(os.getenv("WIND_DIRECTION_FETCH_WORKERS", "4"))))


def wind_direction_from_uv(u_value: float, v_value: float) -> float | None:
    """Meteorological wind-from bearing, clockwise from true north."""
    u_value = float(u_value)
    v_value = float(v_value)
    if math.hypot(u_value, v_value) < 0.2:
        return None
    return round((math.degrees(math.atan2(-u_value, -v_value)) + 360.0) % 360.0, 1)


def apply_direction_values(document: dict, directions: dict[int, float | None]) -> int:
    """Apply direction values to the forecast hours supplied; leave other leads untouched."""
    changed = 0
    for point in document.get("forecast_6_hourly", []):
        try:
            lead = int(point.get("forecast_hour"))
        except (TypeError, ValueError):
            continue
        if lead in directions:
            value = directions[lead]
            point["wind_direction_10m_deg"] = value
            if value is not None:
                changed += 1
    return changed


def _load_step(run_id: str, lead: int) -> dict:
    import main as archive
    import requests

    decoded = archive._read_noaa_decoded_cache_file(run_id, lead)
    if decoded and decoded.get("wind_u") and decoded.get("wind_v"):
        return decoded

    grib_bytes = archive._read_noaa_cache_file(run_id, lead)
    if grib_bytes is None:
        run_dt = archive._parse_utc_datetime(run_id)
        with requests.Session() as session:
            grib_bytes, error, filename = archive._download_noaa_grib_file(
                session,
                run_dt,
                lead,
                {"User-Agent": "GFS-Watch-Wind-Direction/1.0"},
            )
        if error:
            raise RuntimeError(f"f{lead:03d}: {error}")
        archive._write_noaa_cache_file(run_id, lead, grib_bytes)

    decoded, error = archive._decode_noaa_grib_step(run_id, lead, grib_bytes)
    if error:
        raise RuntimeError(f"f{lead:03d}: {error}")
    archive._write_noaa_decoded_cache_file(run_id, lead, decoded)
    if not decoded.get("wind_u") or not decoded.get("wind_v"):
        raise RuntimeError(f"f{lead:03d}: 10 m U/V bileşenleri GRIB2 içinde bulunamadı.")
    return decoded


def _read_latest_forecast():
    import main as archive
    path = Path(archive.PUBLIC_DATA_DIR) / "latest.json"
    if not path.is_file():
        return None, path
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"Yayımlanmış GFS JSON okunamadı: {exc}") from exc
    if document.get("schema") != "gfs-watch.forecast.v1":
        raise RuntimeError("Yayımlanmış GFS JSON şeması beklenen biçimde değil.")
    return document, path


def _write_github_output(updated: bool):
    output_path = os.getenv("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as output:
            output.write(f"updated={'true' if updated else 'false'}\n")


def backfill_latest_wind_direction() -> bool:
    import main as archive
    document, latest_path = _read_latest_forecast()
    if document is None:
        print("[WIND DIRECTION] public/latest.json henüz yok; onarım atlandı.")
        return False

    run_id = document.get("run_id_utc")
    if not run_id:
        raise RuntimeError("Yayımlanmış GFS tahmininde run_id_utc eksik.")
    run_id = _parse_utc_datetime(run_id).isoformat(timespec="seconds")

    points_by_hour = {}
    for point in document.get("forecast_6_hourly", []):
        try:
            lead = int(point.get("forecast_hour"))
        except (TypeError, ValueError):
            continue
        if 0 <= lead <= MAX_DIRECTION_HOUR:
            points_by_hour[lead] = point

    required_hours = archive.gfs_forecast_hours(MAX_DIRECTION_HOUR)
    absent = [lead for lead in required_hours if lead not in points_by_hour]
    if absent:
        raise RuntimeError(
            "İlk 72 saatlik GFS zaman çizelgesi eksik: "
            + ", ".join(f"f{lead:03d}" for lead in absent[:8])
        )

    # A near-calm wind has no stable meteorological direction. Do not repeatedly
    # fetch those points; only repair missing directions where wind is measurable.
    missing_hours = []
    for lead in required_hours:
        point = points_by_hour[lead]
        direction = point.get("wind_direction_10m_deg")
        if isinstance(direction, (int, float)) and math.isfinite(float(direction)):
            continue
        speed = point.get("wind_speed_10m_kmh")
        if isinstance(speed, (int, float)) and math.isfinite(float(speed)):
            if float(speed) < MIN_WIND_SPEED_KMH:
                point["wind_direction_10m_deg"] = None
                continue
        missing_hours.append(lead)

    if not missing_hours:
        print("[WIND DIRECTION] İlk 72 saatte ölçülebilir tüm rüzgâr yönleri hazır.")
        return False

    print(
        f"[WIND DIRECTION] {run_id}: ilk 72 saatte {len(missing_hours)} "
        "eksik yön noktası onarılıyor; önce çözülmüş NOAA U/V önbelleği kullanılacak."
    )
    directions = {}
    cached_count = 0
    missing_cache = []

    for lead in missing_hours:
        decoded = _read_noaa_decoded_cache_file(run_id, lead)
        if decoded and decoded.get("wind_u") and decoded.get("wind_v"):
            u_value = decoded["wind_u"].get("Istanbul")
            v_value = decoded["wind_v"].get("Istanbul")
            if u_value is not None and v_value is not None:
                directions[lead] = wind_direction_from_uv(u_value, v_value)
                cached_count += 1
                continue
        missing_cache.append(lead)

    if missing_cache:
        print(
            f"[WIND DIRECTION] {len(missing_cache)} lead çözümlenmiş önbellekte yok; "
            "yalnızca eksik adımların GRIB2 girdileri alınacak."
        )

        def fetch_one(lead: int):
            decoded = _load_step(run_id, lead)
            u_value = decoded["wind_u"].get("Istanbul")
            v_value = decoded["wind_v"].get("Istanbul")
            if u_value is None or v_value is None:
                raise RuntimeError(f"f{lead:03d}: İstanbul 10 m U/V değeri eksik.")
            return lead, wind_direction_from_uv(u_value, v_value)

        with ThreadPoolExecutor(max_workers=min(FETCH_WORKERS, len(missing_cache))) as executor:
            futures = {executor.submit(fetch_one, lead): lead for lead in missing_cache}
            for future in as_completed(futures):
                lead, direction = future.result()
                directions[lead] = direction

    changed = apply_direction_values(document, directions)
    available = sum(
        isinstance(points_by_hour[lead].get("wind_direction_10m_deg"), (int, float))
        and math.isfinite(float(points_by_hour[lead]["wind_direction_10m_deg"]))
        for lead in required_hours
    )
    measurable = sum(
        not (
            isinstance(points_by_hour[lead].get("wind_speed_10m_kmh"), (int, float))
            and float(points_by_hour[lead]["wind_speed_10m_kmh"]) < MIN_WIND_SPEED_KMH
        )
        for lead in required_hours
    )
    if available < max(50, int(measurable * 0.80)):
        raise RuntimeError(
            f"Rüzgâr yönü kapsaması yetersiz: {available}/{measurable} ölçülebilir saat."
        )

    document["wind_direction_metadata"] = {
        "source": "NOAA/NCEP GFS 0.25° native GRIB2 · 10 m U/V",
        "available_hourly_points": int(available),
        "forecast_hours_covered": MAX_DIRECTION_HOUR,
        "updated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    archive._write_json_atomically(str(latest_path), document)

    run_dt = _parse_utc_datetime(run_id)
    archive_path = (
        Path(PUBLIC_DATA_DIR)
        / "runs"
        / (run_dt.strftime("%Y%m%dT%HZ") + ".json")
    )
    _write_json_atomically(str(archive_path), document)

    print(
        f"[WIND DIRECTION OK] {run_id}: {available}/{measurable} ölçülebilir saat "
        f"hazır; {cached_count} nokta doğrudan decoded cache'ten alındı, "
        f"{len(missing_cache)} nokta tamamlandı. {changed} değer yazıldı."
    )
    return True


def main():
    try:
        updated = backfill_latest_wind_direction()
        _write_github_output(updated)
    except Exception as exc:
        _write_github_output(False)
        print(f"[WIND DIRECTION ERROR] {exc}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
