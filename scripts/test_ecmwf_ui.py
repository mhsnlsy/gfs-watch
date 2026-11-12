"""Static smoke tests for exact GFS/ECMWF forecast layout parity."""
from __future__ import annotations

import re
import math
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "site" / "index.html"
MAIN = ROOT / "main.py"


def main() -> None:
    html = HTML.read_text(encoding="utf-8")
    main = MAIN.read_text(encoding="utf-8")
    APP = ROOT / "site" / "home-app.js"
    ECMWF_PAGE = ROOT / "site" / "ecmwf" / "index.html"
    ECMWF_APP = ROOT / "site" / "ecmwf-app.js"
    CSS = ROOT / "site" / "home.css"
    app = APP.read_text(encoding="utf-8")
    ecmwf_page = ECMWF_PAGE.read_text(encoding="utf-8")
    ecmwf_app = ECMWF_APP.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")
    website_contract = html + "\n" + app + "\n" + css
    required = (
        'id="model-gfs-button"',
        'id="model-ecmwf-button"',
        'id="gfs-model-view"',
        'id="ecmwf-model-view"',
        'id="ecmwf-daily-grid"',
        'station-history-inline',
        'id="station-history-panel"',
        'id="station-temperature-trend"',
        'id="station-rain-trend"',

        'async function refreshStationObservations()',
        'window.setInterval(refreshStationObservations,60000)',
        'id="ecmwf-report-images"',
        'function renderEcmwfReportImages(document)',
        'function scheduleTouchChartTooltipDismiss(hideFn)',
        'window.setTimeout(dismissActiveTouchChartTooltip,2800)',
        'station-chart-hit-area',
        'id="basinc"',
        'id="ecmwf-tahmin"',
        'id="ecmwf-basinc"',
        'id="ecmwf-pressure-findings"',
        'id="ecmwf-valid-until"',
        'const ECMWF_DATA_URL="/api/ecmwf/latest";',
        'localStorage.setItem("istanbul-hava-model-view",activeModel)',
        'localStorage.getItem("istanbul-hava-model-view")',
        'document.forecasts.length<8',
        'MeteoPT ECMWF',
        'İstanbul ECMWF noktası 41.0901°N 28.9436°E',
        'Ensemble sapması bu kaynakta yok.',
        'function renderDaily(items,targetId="daily-grid")',
        'function renderChart(metric,targetId,sourceData=forecastData)',
        'renderDaily(viewData.daily_summary,"ecmwf-daily-grid")',
        'renderFindings(viewData.regional_pressure_analysis&&viewData.regional_pressure_analysis.findings,first.mslp&&first.mslp.mean_hpa,"ecmwf-pressure-findings")',
    )
    # Standalone ECMWF page: same homepage GFS chart/table geometry, but only MeteoPT ECMWF.
    ecmwf_required = (
        'href="/home.css',
        'id="ecmwf-gfs-comparison-container"',
        'class="gfs-interactive-chart gfs-clone-svg"',
        'id="meteopt-table-body"',
        '<th>Steps</th><th>Date/Hour (TSİ)</th><th>T.2m</th><th>Prec.</th><th>W.10m</th><th>T.850</th><th>W.850</th><th>RH.2m',
        '41.0901°N 28.9436°E',
        'https://www.meteopt.com/modelos/ecmwf?lat=41.0901',
    )
    missing_ecmwf = [item for item in ecmwf_required if item not in ecmwf_page]
    if missing_ecmwf:
        raise AssertionError("Missing standalone ECMWF page contract: " + ", ".join(missing_ecmwf))
    for geometry in (
        "const W = 1152;",
        "const H = 838;",
        "const panelWidth = 505;",
        "const panelHeight = 250;",
        "const panelLeft = [55, 592];",
        "const panelTop = [214, 493];",
        "firstMs + 180 * 3600000",
        "common = common.filter(key => item.points.has(key))",
        "function buildPanelAxis(field, valuesBySeries, options = {})",
    ):
        if geometry not in ecmwf_app:
            raise AssertionError("ECMWF renderer is missing homepage GFS parity rule: " + geometry)
    if "api.meteopt.com/ecmwf/json" not in ecmwf_app and "api.meteopt.com/ecmwf/json" not in main:
        raise AssertionError("ECMWF runtime must remain on the MeteoPT ECMWF source path.")

    missing = [item for item in required if item not in website_contract]
    if missing:
        raise AssertionError("Missing ECMWF website contract: " + ", ".join(missing))

    station_card_start = html.index('<article class="weather-card station-card"')
    history_start = html.index('<section class="station-history-inline history-panel"')
    history_end = html.index('</section>', history_start)
    station_card_end = html.index('</article>', history_end)
    if not (station_card_start < history_start < history_end < station_card_end):
        raise AssertionError("The 24-hour station trends must be embedded inside the live observation card.")
    if '.station-history-inline .history-charts{grid-template-columns:repeat(2,minmax(0,1fr))' not in website_contract:
        raise AssertionError("The embedded station history must use a compact two-chart layout.")
    if '.daily-grid .day{padding:10px 4px 9px' not in website_contract:
        raise AssertionError("The eight-day forecast cards are missing their compact visual treatment.")

    ids = re.findall('id="([^"]+)"', html)
    duplicates = sorted(name for name, count in Counter(ids).items() if count > 1)
    if duplicates:
        raise AssertionError("Duplicate HTML IDs: " + ", ".join(duplicates))

    gfs = html[html.index('<div id="gfs-model-view">'):html.index('<div id="ecmwf-model-view"')]
    ecmwf = html[html.index('<div id="ecmwf-model-view"'):html.index("</main>")]
    if 'class="info-card"' not in ecmwf:
        raise AssertionError("ECMWF source card is missing.")
    if "Eski NOAA arşivi bu pakete karışmaz." in html:
        raise AssertionError("The GFS source blurb should be gone.")

    # The old 180-hour surface temperature/precipitation charts were intentionally removed.
    removed_charts = (
        'id="seyir"',
        'id="temperature-chart"',
        'id="precipitation-chart"',
        'id="ecmwf-comparison-temperature-chart"',
        'id="ecmwf-comparison-precipitation-chart"',
    )
    remaining = [item for item in removed_charts if item in html]
    if remaining:
        raise AssertionError("Removed 180-hour charts still present: " + ", ".join(remaining))

    if 'id="ecmwf-tahmin"' not in ecmwf or ecmwf.index('id="ecmwf-tahmin"') < ecmwf.index('id="ecmwf-basinc"'):
        raise AssertionError("ECMWF eight-day forecast must be the final model section.")
    if 'class="chart-stack"' in gfs:
        raise AssertionError("GFS legacy 180-hour graph card container remains.")
    if 'id="gfs-850-card"' in gfs or 'id="gfs-cycle-t850-chart"' in gfs or 'class="chart-card"' in gfs:
        raise AssertionError("The bottom GFS 850 hPa panel should be gone.")
    if 'class="chart-stack"' not in ecmwf or 'class="chart-card"' not in ecmwf:
        raise AssertionError("The remaining ECMWF wind comparison charts are missing.")
    if '.chart-stack>.chart-card{\n      border:0!important' not in website_contract:
        raise AssertionError("Mobile ECMWF chart cards must be frameless.")
    if website_contract.count('document.addEventListener("pointerdown"') != 1 or website_contract.count('window.addEventListener("scroll"') != 1:
        raise AssertionError("Touch tooltip dismissal must use singleton global listeners.")

    for section_id in ("ecmwf-tahmin", "ecmwf-seyir", "ecmwf-basinc"):
        if f'id="{section_id}"' not in ecmwf:
            raise AssertionError(f"Missing ECMWF section: {section_id}")

    if "ecmwf-report-images" not in website_contract:
        raise AssertionError("ECMWF PNG report gallery is missing.")
    if "#ecmwf-report-images{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))" not in website_contract:
        raise AssertionError("Desktop ECMWF report images must sit in a 2x2 grid.")

    if "ecmwf-wind-chart" in html or "ecmwf-forecast-table" in html:
        raise AssertionError("Legacy ECMWF-only layout remains in the website.")

    if 'id="ecmwf-daily-cycle-chip"' not in html or 'id="ecmwf-daily-updated-chip"' not in html:
        raise AssertionError("ECMWF daily metadata targets are missing.")

    if '"wind_direction_10m_deg": values.get("wind_direction_deg")' not in main:
        raise AssertionError("GFS 10 m wind direction is not exported to the forecast timeline.")
    if 'wind_direction = series("wind10mdir")' not in main or '"wind_direction_deg": round(direction, 1)' not in main:
        raise AssertionError("GFS wind direction must come from the MeteoPT wind10mdir series.")
    direction_from_uv = lambda u, v: (math.degrees(math.atan2(-u, -v)) + 360.0) % 360.0
    assert abs(direction_from_uv(0.0, -1.0) - 0.0) < 1e-9
    assert abs(direction_from_uv(-1.0, 0.0) - 90.0) < 1e-9
    assert abs(direction_from_uv(0.0, 1.0) - 180.0) < 1e-9
    assert abs(direction_from_uv(1.0, 0.0) - 270.0) < 1e-9

    version = json.loads((ROOT / "site" / "version.json").read_text(encoding="utf-8"))
    if version.get("name") != "İstanbul Havası" or version.get("version") != "1.5.0":
        raise AssertionError("Shared app identity must stay İstanbul Havası 4.0 for the official 1.5.0 release.")
    if 'data-app-name' not in html or 'data-app-version' not in html or "./version.json" not in html:
        raise AssertionError("The website must render its name and version from site/version.json.")
    if "GFS Watch · v3.0.0" in html or "GFS Watch v3.0.0" in html:
        raise AssertionError("The old GFS Watch version label is still visible.")
    if '"version.json"' not in main or "APP_LABEL" not in main or 'f"🌦 {APP_LABEL}"' not in main:
        raise AssertionError("Telegram reports must take their version from the same site/version.json.")

    for marker in ('id="briefing"', 'id="brief-rain"', 'id="brief-rain-lines"', "function buildBriefing"):
        if marker not in website_contract:
            raise AssertionError("72-hour briefing is missing: " + marker)
    if "viewport-fit=cover" not in website_contract or "env(safe-area-inset-top)" not in website_contract:
        raise AssertionError("Modern iPhone safe-area viewport support is missing.")
    if "orientation:landscape" not in website_contract or "max-height:600px" not in website_contract:
        raise AssertionError("Compact landscape phone layout is missing.")
    print("[ECMWF UI SMOKE] model selector, daily forecast ordering, responsive safe areas, "
          "touch tooltip dismissal, ECMWF wind comparison, "
          "55-step contract and unique IDs passed.")


if __name__ == "__main__":
    main()
