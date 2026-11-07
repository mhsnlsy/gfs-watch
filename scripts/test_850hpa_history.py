"""Regression tests for the one-time persistent GFS 850 hPa comparison archive."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    main_source = (ROOT / "main.py").read_text(encoding="utf-8")

    export_start = main_source.index("def export_public_forecast_json(")
    export_end = main_source.index("\ndef _load_gfs_850_comparison_runs", export_start)
    export_function = main_source[export_start:export_end]
    assert "def export_public_forecast_json(" in export_function
    assert "if update_latest:" in export_function
    assert "public/latest.json" in export_function
    assert "public/runs/" in export_function

    history_start = main_source.index("async def load_previous_three_runs_for_comparison(")
    history_end = main_source.index("\nasync def send_telegram_photo", history_start)
    history_loader = main_source[history_start:history_end]
    fetch_at = history_loader.index("fetch_full_weather_data, previous_run_id")
    save_at = history_loader.index("save_run, previous_run_id, fetched_payload")
    export_at = history_loader.index("export_public_forecast_json, previous_run_id, fetched_payload, False")
    assert fetch_at < save_at < export_at
    assert "if not use_meteopt:" in history_loader
    assert "SQLite kaydı kullanılıyor" in history_loader

    backfill = (ROOT / "scripts/backfill_850hpa_comparison.py").read_text(encoding="utf-8")
    assert "archive.export_public_forecast_json(run_id, payload, update_latest=False)" in backfill
    assert "archive.export_public_forecast_json(current_id, current_record[1], update_latest=True)" in backfill
    assert "archive._has_complete_850_wind_daily_series" in backfill
    assert not (ROOT / ".github/workflows/backfill-850hpa-comparison.yml").exists()
    assert not (ROOT / ".github/workflows/archive-latest-telegram-report.yml").exists()

    print("[850 HPA HISTORY SMOKE] MeteoPT archive remains; NOAA backfill workflows are closed.")


if __name__ == "__main__":
    main()
