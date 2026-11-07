"""Sync canonical Istanbul GFS cycles from Cloudflare D1.

Cloudflare's autonomous Cron Worker is the only MeteoPT collector. This
GitHub workflow only reads its D1-backed API, backfills the publication
workspace, and builds the report/PNG bundle when a new F180 cycle is ready.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path.cwd()
GFS_DIR = ROOT / "gfs"
API_URL = os.getenv(
    "ISTANBUL_GFS_API",
    "https://gfs-watch-web.muhsin-ulusoy.workers.dev/gfs/latest",
)


def output(name: str, value: str) -> None:
    target = os.getenv("GITHUB_OUTPUT")
    if target:
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def parse_run(value: str) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def save_atomic(path: Path, document: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def fetch_latest() -> dict:
    separator = "&" if "?" in API_URL else "?"
    request = Request(
        API_URL + separator + "report_sync=" + str(int(time.time())),
        headers={
            "Accept": "application/json",
            "Cache-Control": "no-cache",
            "User-Agent": "GFS-Watch-Report-Sync/1.0",
        },
    )
    try:
        with urlopen(request, timeout=45) as response:
            document = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cloudflare GFS API is unavailable: {exc}") from exc

    if not isinstance(document, dict) or document.get("schema") != "gfs-watch.forecast.v1":
        raise RuntimeError("Cloudflare GFS API returned an unexpected payload schema")
    if not isinstance(document.get("forecast_6_hourly"), list):
        raise RuntimeError("Cloudflare GFS API returned no forecast time series")
    return document


def all_runs(latest: dict) -> list[dict]:
    candidates = latest.get("comparison_runs")
    rows = [item for item in candidates if isinstance(item, dict)] if isinstance(candidates, list) else []
    latest_run_id = latest.get("run_id_utc")
    if latest_run_id and not any(item.get("run_id_utc") == latest_run_id for item in rows):
        rows.append(latest)

    unique: dict[str, dict] = {}
    for item in rows:
        run_id = item.get("run_id_utc")
        points = item.get("forecast_6_hourly")
        if not run_id or not isinstance(points, list):
            continue
        try:
            parse_run(run_id)
        except (TypeError, ValueError):
            continue
        clean = dict(item)
        clean.pop("comparison_runs", None)
        unique[str(run_id)] = clean

    return sorted(
        unique.values(),
        key=lambda item: parse_run(item["run_id_utc"]),
        reverse=True,
    )


def is_f72_ready(document: dict) -> bool:
    milestone = document.get("f72")
    if isinstance(milestone, dict) and milestone.get("available") is True:
        return True
    points = document.get("forecast_6_hourly") or []
    return sum(
        1 for point in points
        if isinstance(point, dict) and 0 < int(point.get("forecast_hour") or 0) <= 72
    ) >= 12


def is_f180_ready(document: dict) -> bool:
    milestone = document.get("f180")
    if isinstance(milestone, dict) and milestone.get("available") is True:
        return True
    points = document.get("forecast_6_hourly") or []
    leads = [
        int(point.get("forecast_hour") or 0)
        for point in points if isinstance(point, dict)
    ]
    return bool(leads) and max(leads) >= 180 and sum(1 for lead in leads if 0 < lead <= 180) >= 30


def has_publication(run_id: str) -> bool:
    manifest_path = GFS_DIR / "notifications" / "latest.json"
    if not manifest_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return False
    return any(
        isinstance(item, dict) and item.get("run_id_utc") == run_id
        for item in (manifest.get("items") or [])
    )


def main() -> int:
    for directory in (
        GFS_DIR / "runs",
        GFS_DIR / "milestones" / "f72",
        GFS_DIR / "notifications" / "telegram-sent",
    ):
        directory.mkdir(parents=True, exist_ok=True)

    try:
        latest = fetch_latest()
        runs = all_runs(latest)
    except RuntimeError as exc:
        print(f"::warning::{exc}")
        output("new_run", "false")
        output("f72_cached", "false")
        output("f180_ready", "false")
        output("run_id", "")
        output("reason", "cloudflare_api_unavailable")
        return 0

    if not runs:
        print("[GFS REPORT SYNC] Cloudflare D1 has no archived GFS runs yet.")
        output("new_run", "false")
        output("f72_cached", "false")
        output("f180_ready", "false")
        output("run_id", "")
        output("reason", "no_archived_runs")
        return 0

    any_new_run = False
    f72_cached = False
    f180_ready = False
    selected_f72_run = ""
    selected_f180_run = ""

    for document in runs:
        run_id = str(document["run_id_utc"])
        f72_path = GFS_DIR / "milestones" / "f72" / f"{run_id}.json"
        run_path = GFS_DIR / "runs" / f"{run_id}.json"
        points = document.get("forecast_6_hourly") or []

        if is_f72_ready(document) and not f72_path.exists():
            cached = dict(document)
            cached.pop("comparison_runs", None)
            cached["milestone"] = "F72"
            cached["forecast_horizon_hours"] = 72
            cached["forecast_6_hourly"] = [
                point for point in points
                if 0 < int(point.get("forecast_hour") or 0) <= 72
            ]
            save_atomic(f72_path, cached)
            f72_cached = True
            any_new_run = True
            selected_f72_run = selected_f72_run or run_id
            print(f"[GFS REPORT SYNC] F72 milestone backfilled from D1: {run_id}")

        if not is_f180_ready(document):
            continue

        if not run_path.exists():
            save_atomic(run_path, document)
            any_new_run = True
            print(f"[GFS REPORT SYNC] Canonical F180 run imported from D1: {run_id}")

        if not f180_ready and not has_publication(run_id):
            f180_ready = True
            selected_f180_run = run_id
            print(f"[GFS REPORT SYNC] F180 ready for report generation: {run_id}")

    output("new_run", "true" if any_new_run else "false")
    output("f72_cached", "true" if f72_cached else "false")
    output("f180_ready", "true" if f180_ready else "false")
    output("run_id", selected_f180_run or selected_f72_run)
    output(
        "reason",
        "f180_ready" if f180_ready else (
            "f72_backfilled" if f72_cached else "no_new_milestone"
        ),
    )

    print(
        "[GFS REPORT SYNC] "
        f"source=Cloudflare D1; archived_runs={len(runs)}; "
        f"new_f72={f72_cached}; unpublished_f180={f180_ready}; "
        f"checked_at_utc={datetime.now(timezone.utc).isoformat(timespec='seconds')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
