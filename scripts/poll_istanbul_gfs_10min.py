"""Ten-minute Istanbul GFS state machine.

Polls MeteoPT for the newest available cycle. F72 is cached immediately.
The same cycle is considered publication-ready only when F180 exists.
Canonical run JSON is written exactly once; report generation and delivery
are separate workflow jobs.

State lives on the istanbul-gfs-data branch, so a runner replacement cannot
forget which cycle milestones have already been archived.
"""
from __future__ import annotations

import os
import sys
import json
from pathlib import Path

ROOT = Path.cwd()
GFS_DIR = ROOT / "gfs"
sys.path.insert(0, str(ROOT / "scripts"))

from fetch_istanbul_gfs_meteopt import fetch_cycle, normalize, run_datetime  # noqa: E402

CYCLE_HOURS = (18, 12, 6, 0)


def output(name: str, value: str) -> None:
    target = os.getenv("GITHUB_OUTPUT")
    if target:
        with open(target, "a", encoding="utf-8") as fh:
            fh.write(f"{name}={value}\n")


def steps_of(document: dict) -> set[int]:
    result = set()
    for value in ((document.get("steps") or {}).get("values") or []):
        try:
            result.add(int(float(value)))
        except (TypeError, ValueError):
            pass
    return result


def save_atomic(path: Path, document: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temp.replace(path)


def has_publication(run_id: str) -> bool:
    manifest_path = GFS_DIR / "notifications" / "latest.json"
    if not manifest_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return False
    return any(
        item.get("run_id_utc") == run_id
        for item in (manifest.get("items") or [])
        if isinstance(item, dict)
    )


def main() -> int:
    (GFS_DIR / "runs").mkdir(parents=True, exist_ok=True)
    (GFS_DIR / "milestones" / "f72").mkdir(parents=True, exist_ok=True)
    (GFS_DIR / "notifications" / "telegram-sent").mkdir(parents=True, exist_ok=True)

    candidates = []
    errors = []
    for hour in CYCLE_HOURS:
        try:
            document, url = fetch_cycle(hour)
            cycle = run_datetime(document.get("run"))
            if cycle.hour != hour:
                errors.append(f"{hour:02d}Z returned {cycle.isoformat()}")
                continue
            steps = steps_of(document)
            candidates.append((cycle, document, url, steps))
            print(
                f"[GFS 10M] {cycle.isoformat()} · "
                f"F72={'yes' if 72 in steps else 'no'} · "
                f"F180={'yes' if 180 in steps else 'no'}"
            )
        except Exception as exc:
            errors.append(f"{hour:02d}Z: {exc}")

    if not candidates:
        print("[GFS 10M] No usable cycle returned.")
        output("new_run", "false")
        output("f72_cached", "false")
        output("f180_ready", "false")
        output("run_id", "")
        output("reason", "source_unavailable")
        return 0

    candidates.sort(key=lambda item: item[0], reverse=True)
    any_new_run = False
    f72_cached = False
    f180_ready = False
    selected_f72_run = ""
    selected_f180_run = ""

    # F72 is cached for every newly visible cycle; F180 publication remains
    # limited to one newest unpublished cycle per poll.
    for cycle, document, url, steps in candidates:
        run_id = cycle.isoformat(timespec="seconds")
        f72_path = GFS_DIR / "milestones" / "f72" / f"{run_id}.json"
        run_path = GFS_DIR / "runs" / f"{run_id}.json"

        if 72 in steps and not f72_path.exists():
            cached = normalize(document, url, cycle, require_f180=False)
            cached["milestone"] = "F72"
            cached["forecast_6_hourly"] = [
                point for point in cached["forecast_6_hourly"]
                if point.get("forecast_hour", 0) <= 72
            ]
            cached["forecast_horizon_hours"] = 72
            save_atomic(f72_path, cached)
            f72_cached = True
            any_new_run = True
            selected_f72_run = selected_f72_run or run_id
            print(f"[GFS 10M] F72 cached: {run_id}")

        if 180 in steps and not f180_ready:
            if not run_path.exists():
                full = normalize(document, url, cycle, require_f180=True)
                save_atomic(run_path, full)
                any_new_run = True
                print(f"[GFS 10M] F180 canonical run archived: {run_id}")

            # A raw run file can survive a failed validation/build. Retry report
            # generation until that run has an entry in the durable manifest.
            if not has_publication(run_id):
                f180_ready = True
                selected_f180_run = run_id
                print(f"[GFS 10M] F180 ready for report retry: {run_id}")
            else:
                print(f"[GFS 10M] F180 already published: {run_id}")

    output("new_run", "true" if any_new_run else "false")
    output("f72_cached", "true" if f72_cached else "false")
    output("f180_ready", "true" if f180_ready else "false")
    output("run_id", selected_f180_run or selected_f72_run)
    output(
        "reason",
        "f180_ready" if f180_ready else (
            "f72_cached" if f72_cached else "no_new_milestone"
        ),
    )
    if errors:
        print("[GFS 10M] Non-fatal probe warnings:")
        for error in errors:
            print(f"::warning::{error}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
