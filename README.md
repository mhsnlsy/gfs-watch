# GFS Watch

An Istanbul-focused GFS forecast watcher. GitHub Actions checks GFS run publication metadata and sends one Telegram text and voice notification per exact model run after at least +180 forecast hours are available.

## Data sources and forecast retrieval

- Open-Meteo's public `in-progress.json` and `latest.json` files are used only to discover the active and latest completed GFS run, and to determine the published forecast horizon.
- Forecast values are retrieved directly from NOAA/NCEP's operational GFS 0.25° GRIB2 files through the [NOMADS regional GRIB filter](https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl). This avoids waiting for a secondary archive API to publish an otherwise available GFS cycle.
- The filter returns a small regional subset covering Istanbul, the Balkans, the Black Sea/Crimea and the Mediterranean. The global GRIB files are not downloaded in full.
- GRIB2 messages are decoded with ecCodes. The report uses 2 m temperature, 10 m U/V wind components, mean-sea-level pressure and surface precipitation.
- Values are converted to °C, km/h, hPa and mm. Precipitation uses the specific six-hour accumulation period when available; cumulative run totals are not added repeatedly.
- The forecast timeline contains the 31 six-hour valid times from +0 to +180. Daily minima/maxima, precipitation totals and wind maxima are aggregated from those six-hour samples, so daily extremes are sample-based rather than hourly.
- The current-condition snapshot is separate and is retrieved from the live Forecast API. The forecast and run-to-run comparison use the exact selected NOAA GFS cycle.

## GitHub Actions deployment

The repository runs GFS Watch through GitHub Actions. No separate server or local installation is needed.

1. Open **Settings → Secrets and variables → Actions** in this repository.
2. Add these repository secrets:
   - `TELEGRAM_TOKEN` — Telegram bot token (required).
   - `CHAT_ID` — Telegram chat ID (required).
   - `GCP_SA_KEY` — Google Cloud service-account JSON in one line (optional; without it, text notifications still work).
3. Open the **Actions** tab and select **GFS Watch**. Use **Run workflow** to test it.
4. The scheduled workflow checks for new GFS runs every 10 minutes. GitHub may delay scheduled starts during periods of high load.

The workflow installs the ecCodes system library and Python package automatically on its GitHub-hosted runner.

## Run tracking and +180-hour threshold

- The workflow checks both Open-Meteo GFS metadata documents and calculates the forecast horizon from each run's UTC initialisation time to its latest published valid time.
- A run is not notified or marked as processed until at least +180 forecast hours are published.
- The exact selected cycle is then requested from NOAA/NCEP. The +180 file is checked first; if it is not ready, the run remains pending and is retried on a later scheduled check.
- NOAA filter requests are spaced to respect the service's request guidance. A full +0 to +180 timeline uses six-hour forecast steps.

## Run history and comparisons

- The SQLite database is stored in the `gfs-watch-state` branch and restored before each check.
- The latest 10 days of run history are retained.
- Each eligible run is compared with the immediately preceding stored run at common valid timestamps. Temperature changes of at least 2 °C and six-hour precipitation changes of at least 1 mm are included in the report.
- The first lead of a new cycle has no six-hour precipitation interval preceding its own initialisation, so that point is excluded from precipitation comparisons.
- Do not delete or manually edit the `gfs_watch.db` file in the state branch; the workflow maintains it.

## Notification behaviour

- One text notification is sent per eligible GFS run; there are no separate notifications for forecast changes.
- Telegram text delivery does not wait for TTS. Audio generation starts concurrently in a background thread.
- TTS generation and Telegram voice delivery each retry up to three times after failures. If audio cannot be produced or sent, the text report remains delivered.
- GitHub Actions prevents overlapping GFS Watch jobs.
