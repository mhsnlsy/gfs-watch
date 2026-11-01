"""Static smoke tests for the one-click ECMWF EPS website view."""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "site" / "index.html"


def main() -> None:
    html = HTML.read_text(encoding="utf-8")
    required = (
        'id="model-gfs-button"',
        'id="model-ecmwf-button"',
        'id="gfs-model-view"',
        'id="ecmwf-model-view"',
        'id="ecmwf-daily-grid"',
        'id="ecmwf-temperature-chart"',
        'id="ecmwf-precipitation-chart"',
        'id="ecmwf-pressure-findings"',
        'const ECMWF_DATA_URL="./data/ecmwf/latest.json";',
        'localStorage.setItem("istanbul-hava-model-view",activeModel)',
        'localStorage.getItem("istanbul-hava-model-view")',
        'document.forecasts.length!==55',
        'function renderDaily(items,targetId="daily-grid")',
        'function renderChart(metric,targetId,sourceData=forecastData)',
        'renderDaily(viewData.daily_summary,"ecmwf-daily-grid")',
        'renderChart("precipitation","ecmwf-precipitation-chart",viewData)',
        'http-equiv="refresh" content="300"',
    )
    missing = [item for item in required if item not in html]
    if missing:
        raise AssertionError("Missing ECMWF website contract: " + ", ".join(missing))

    ids = re.findall(r'\bid="([^"]+)"', html)
    duplicates = sorted(name for name, count in Counter(ids).items() if count > 1)
    if duplicates:
        raise AssertionError("Duplicate HTML IDs: " + ", ".join(duplicates))

    gfs_start = html.index('<div id="gfs-model-view">')
    ecmwf_start = html.index('<div id="ecmwf-model-view"')
    main_end = html.index("</main>", ecmwf_start)
    if not (gfs_start < ecmwf_start < main_end):
        raise AssertionError("GFS and ECMWF model views are not correctly separated.")

    if "ecmwf-wind-chart" in html or "ecmwf-forecast-table" in html:
        raise AssertionError("Legacy ECMWF-only layout remains in the website.")

    print("[ECMWF UI SMOKE] Shared GFS/ECMWF layout, model selector, persistence, "
          "5-minute refresh, 55-step contract and unique IDs passed.")


if __name__ == "__main__":
    main()
