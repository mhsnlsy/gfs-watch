#!/usr/bin/env python3
"""Score archived GFS runs against station temperature histories.

Error is forecast minus observed. Positive means the model was warmer.
The operational score uses, for each past hour, the latest GFS run that
had already been issued (the forecast a reader could have seen).
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

IST = ZoneInfo("Europe/Istanbul")
MATCH_WINDOW = timedelta(minutes=45)
LEAD_BUCKETS = (
    ("0–6 saat", 0, 6),
    ("6–24 saat", 6, 24),
    ("1–2 gün", 24, 48),
    ("2–3 gün", 48, 72),
    ("3 gün ve sonrası", 72, 10_000),
)


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def load_json(path: Path):
    if not path or not path.is_file():
        return None
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def station_samples(document) -> list[dict]:
    if not isinstance(document, dict):
        return []
    samples = document.get("samples")
    if not isinstance(samples, list):
        return []
    cleaned = []
    for sample in samples:
        if not isinstance(sample, dict):
            continue
        stamp = sample.get("observed_at_utc") or sample.get("logged_at_utc")
        temp = sample.get("temperature_2m_c")
        if not stamp or not isinstance(temp, (int, float)):
            continue
        try:
            when = parse_time(stamp)
        except ValueError:
            continue
        cleaned.append({**sample, "_when": when, "temperature_2m_c": float(temp)})
    cleaned.sort(key=lambda item: item["_when"])
    return cleaned


def nearest(samples: list[dict], moment: datetime):
    best = None
    best_gap = None
    for sample in samples:
        gap = abs(sample["_when"] - moment)
        if best_gap is None or gap < best_gap:
            best = sample
            best_gap = gap
    if best is None or best_gap > MATCH_WINDOW:
        return None
    return best


def round1(value: float) -> float:
    return round(value, 1)


def summarize(pairs: list[dict]) -> dict:
    if not pairs:
        return {"pairs": 0, "mae_c": None, "bias_c": None, "within_1c_pct": None, "within_2c_pct": None}
    errors = [pair["error_c"] for pair in pairs]
    count = len(errors)
    return {
        "pairs": count,
        "mae_c": round1(sum(abs(error) for error in errors) / count),
        "bias_c": round1(sum(errors) / count),
        "within_1c_pct": round(100 * sum(abs(error) <= 1 for error in errors) / count),
        "within_2c_pct": round(100 * sum(abs(error) <= 2 for error in errors) / count),
    }


def lead_rows(pairs: list[dict]) -> list[dict]:
    rows = []
    for label, start, end in LEAD_BUCKETS:
        chosen = [pair for pair in pairs if start <= pair["lead_hours"] < end]
        row = {"label": label, **summarize(chosen)}
        rows.append(row)
    return rows


def rain_skill(pairs: list[dict], samples: list[dict]) -> dict | None:
    hits = false_alarms = misses = correct_dry = 0
    for pair in pairs:
        forecast_rain = pair.get("precipitation_6h_mm")
        lead = pair["lead_hours"]
        if not isinstance(forecast_rain, (int, float)) or lead < 6:
            continue
        earlier = nearest(samples, pair["_valid"] - timedelta(hours=6))
        later = pair.get("_obs")
        if earlier is None or later is None:
            continue
        if earlier["_when"].astimezone(IST).date() != pair["_valid"].astimezone(IST).date():
            continue
        early_rain = earlier.get("precipitation_daily_mm")
        late_rain = later.get("precipitation_daily_mm")
        if not isinstance(early_rain, (int, float)) or not isinstance(late_rain, (int, float)):
            continue
        observed = max(0.0, float(late_rain) - float(early_rain))
        forecast_wet = float(forecast_rain) >= 0.2
        observed_wet = observed >= 0.2
        if forecast_wet and observed_wet:
            hits += 1
        elif forecast_wet and not observed_wet:
            false_alarms += 1
        elif not forecast_wet and observed_wet:
            misses += 1
        else:
            correct_dry += 1
    total = hits + false_alarms + misses + correct_dry
    if total < 6:
        return None
    return {
        "pairs": total,
        "hits": hits,
        "false_alarms": false_alarms,
        "misses": misses,
        "correct_dry": correct_dry,
        "accuracy_pct": round(100 * (hits + correct_dry) / total),
        "wet_events": hits + misses,
    }


def load_runs(runs_dir: Path) -> list[dict]:
    runs = []
    if not runs_dir.is_dir():
        return runs
    for path in sorted(runs_dir.glob("*.json")):
        document = load_json(path)
        if not isinstance(document, dict):
            continue
        run_id = document.get("run_id_utc")
        points = document.get("forecast_6_hourly")
        if not run_id or not isinstance(points, list):
            continue
        try:
            issued = parse_time(run_id)
        except ValueError:
            continue
        cleaned = []
        for point in points:
            if not isinstance(point, dict):
                continue
            valid = point.get("valid_time_utc")
            temp = point.get("temperature_2m_c")
            if not valid or not isinstance(temp, (int, float)):
                continue
            try:
                moment = parse_time(valid)
            except ValueError:
                continue
            lead = point.get("forecast_hour")
            if not isinstance(lead, (int, float)):
                lead = (moment - issued).total_seconds() / 3600
            cleaned.append({
                "valid": moment,
                "lead_hours": int(lead),
                "temperature_2m_c": float(temp),
                "precipitation_6h_mm": point.get("precipitation_6h_mm") if isinstance(point.get("precipitation_6h_mm"), (int, float)) else None,
            })
        if cleaned:
            runs.append({"run_id_utc": run_id, "issued": issued, "points": cleaned})
    runs.sort(key=lambda item: item["issued"])
    return runs


def score_station(runs: list[dict], samples: list[dict], now: datetime) -> dict:
    cutoff = now - timedelta(minutes=20)
    per_run = []
    all_pairs = []
    by_valid = {}
    for run in runs:
        run_pairs = []
        for point in run["points"]:
            if point["valid"] > cutoff or point["valid"] < run["issued"]:
                continue
            obs = nearest(samples, point["valid"])
            if obs is None:
                continue
            error = point["temperature_2m_c"] - obs["temperature_2m_c"]
            pair = {
                "run_id_utc": run["run_id_utc"],
                "valid_time_utc": point["valid"].isoformat(),
                "lead_hours": point["lead_hours"],
                "forecast_c": round1(point["temperature_2m_c"]),
                "observed_c": round1(obs["temperature_2m_c"]),
                "error_c": round1(error),
                "precipitation_6h_mm": point["precipitation_6h_mm"],
                "_valid": point["valid"],
                "_obs": obs,
            }
            run_pairs.append(pair)
            previous = by_valid.get(point["valid"])
            if previous is None or run["issued"] >= previous["_issued"]:
                by_valid[point["valid"]] = {**pair, "_issued": run["issued"]}
        summary = summarize(run_pairs)
        if summary["pairs"]:
            verified = max(pair["_valid"] for pair in run_pairs)
            per_run.append({
                "run_id_utc": run["run_id_utc"],
                "verified_through_utc": verified.isoformat(),
                **summary,
            })
        all_pairs.extend(run_pairs)

    operational = [by_valid[key] for key in sorted(by_valid)]
    op_summary = summarize(operational)
    if operational:
        op_summary["from_utc"] = operational[0]["valid_time_utc"]
        op_summary["to_utc"] = operational[-1]["valid_time_utc"]
    recent = []
    for pair in sorted(operational, key=lambda item: item["_valid"], reverse=True)[:12]:
        recent.append({
            "valid_time_utc": pair["valid_time_utc"],
            "run_id_utc": pair["run_id_utc"],
            "lead_hours": pair["lead_hours"],
            "forecast_c": pair["forecast_c"],
            "observed_c": pair["observed_c"],
            "error_c": pair["error_c"],
        })
    return {
        "operational": op_summary,
        "by_lead": lead_rows(all_pairs),
        "runs": list(reversed(per_run)),
        "recent": recent,
        "rain": rain_skill(all_pairs, samples),
        "logged_pairs": len(all_pairs),
    }


def build(runs_dir: Path, enka_path: Path, eyup_path: Path) -> dict:
    now = datetime.now(timezone.utc)
    runs = load_runs(runs_dir)
    stations = {
        "enka": score_station(runs, station_samples(load_json(enka_path)), now),
        "eyupsultan": score_station(runs, station_samples(load_json(eyup_path)), now),
    }
    return {
        "schema": "gfs-watch.forecast-verification.v1",
        "generated_at_utc": now.isoformat(),
        "model": "NOAA/NCEP GFS 0.25°",
        "grid": {"latitude": 41.0, "longitude": 29.0},
        "match_window_minutes": int(MATCH_WINDOW.total_seconds() // 60),
        "runs_scored": len(runs),
        "stations": stations,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs-dir", required=True)
    parser.add_argument("--enka-history", required=True)
    parser.add_argument("--eyup-history", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    document = build(Path(args.runs_dir), Path(args.enka_history), Path(args.eyup_history))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    enka = document["stations"]["enka"]["operational"]
    eyup = document["stations"]["eyupsultan"]["operational"]
    print(
        f"Verification written: {output} · "
        f"ENKA {enka['pairs']} saat MAE {enka['mae_c']} · "
        f"Eyüpsultan {eyup['pairs']} saat MAE {eyup['mae_c']}"
    )


if __name__ == "__main__":
    main()
