"""Rebuild a missing/stale Pages report from the latest published GFS cycle.

This repair path never sends Telegram messages and does not change the selected
GFS cycle. It rebuilds the human-readable report, optional voice, and comparison
images, then publishes the notification manifest for GitHub Pages.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as archive


async def rebuild() -> None:
    public_dir = Path(archive.PUBLIC_DATA_DIR)
    latest_path = public_dir / "latest.json"
    if not latest_path.is_file():
        raise RuntimeError("public/latest.json is missing; cannot rebuild a report.")

    latest = json.loads(latest_path.read_text(encoding="utf-8"))
    run_id = archive._parse_utc_datetime(latest.get("run_id_utc")).isoformat(timespec="seconds")
    print(f"[REPORT REPAIR] Rebuilding missing Pages report for {run_id}.")

    payload = await asyncio.to_thread(archive.fetch_full_weather_data, run_id)
    if not payload or "_pending_noaa_gfs" in payload:
        raise RuntimeError(
            "NOAA GFS data could not be rebuilt: "
            f"{(payload or {}).get('_reason', 'no data returned')}"
        )

    noaa = latest.get("noaa_source_file", {})
    payload["model_metadata"] = {
        "noaa_f180_available": noaa.get("f180_available", True),
        "last_modified_time": noaa.get("f180_last_modified_utc"),
        "source_name": noaa.get("f180_source_name"),
        "source_url": noaa.get("f180_source_url"),
        "source_object_size_bytes": noaa.get("global_grib2_size_bytes"),
    }
    payload["station_observation"] = latest.get("station_observation")

    previous_runs = []
    try:
        previous_runs = await archive.load_previous_three_runs_for_comparison(run_id)
        if len(previous_runs) != 3:
            raise RuntimeError(f"Expected three prior cycles, found {len(previous_runs)}.")
    except Exception as exc:
        print(f"[REPORT REPAIR WARNING] Comparison history unavailable: {exc}")
        previous_runs = []

    full_text_report, speech_text = archive.analyze_and_build_output(
        run_id, payload, previous_runs
    )

    images = []
    if previous_runs:
        charts = archive.create_pages_comparison_charts(run_id, payload, previous_runs)
        expected = {"temperature", "temperature_850", "precipitation", "wind_10m"}
        if set(charts) == expected:
            try:
                images = await asyncio.to_thread(
                    archive.save_public_notification_images, run_id, charts
                )
            finally:
                for buffer in charts.values():
                    buffer.close()
        else:
            for buffer in charts.values():
                buffer.close()
            print(f"[REPORT REPAIR WARNING] Four-chart set incomplete: {sorted(charts)}")

    audio_file = await archive.generate_speech_with_retry(speech_text)
    try:
        await asyncio.to_thread(
            archive.publish_public_notification,
            run_id,
            full_text_report,
            speech_text,
            None,
            audio_file,
            images,
        )
    finally:
        if audio_file and Path(audio_file).exists():
            Path(audio_file).unlink()

    manifest_path = public_dir / "notifications" / "latest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    item = manifest.get("items", [None])[0]
    if not item or item.get("run_id_utc") != run_id or not item.get("report_text", "").strip():
        raise RuntimeError("Rebuilt Pages report failed its manifest validation.")

    run_key = archive._parse_utc_datetime(run_id).strftime("%Y%m%dT%HZ")
    expected_images = {
        f"gfs-{run_key}-temperature.png",
        f"gfs-{run_key}-temperature_850.png",
        f"gfs-{run_key}-precipitation.png",
        f"gfs-{run_key}-wind_10m.png",
    }
    images = item.get("images")
    image_paths = [image.get("path", "") for image in images or [] if isinstance(image, dict)]
    if len(image_paths) != 4 or {Path(path).name for path in image_paths} != expected_images:
        raise RuntimeError(
            "Rebuilt Pages report must contain exactly four PNG comparison charts; "
            f"found {image_paths!r}"
        )

    # Keep the embedded forecast report and the notification feed identical.
    # Otherwise latest.json can continue exposing deleted legacy SVG paths.
    latest["report"] = item
    latest_text = json.dumps(latest, ensure_ascii=False, indent=2) + "\\n"
    if ".svg" in latest_text.lower():
        raise RuntimeError("Legacy SVG reference remains in public/latest.json.")
    archive._write_json_atomically(str(latest_path), latest)
    print(
        f"[REPORT REPAIR COMPLETE] {run_id}; "
        f"images={len(image_paths)} PNG; embedded report synced; audio={'yes' if item.get('audio_path') else 'no'}."
    )


if __name__ == "__main__":
    asyncio.run(rebuild())
