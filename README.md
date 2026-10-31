# GFS Watch

A point-specific GFS forecast watcher for 41.014°N, 28.950°E. GitHub Actions checks NOAA's published GFS +180-hour GRIB2 objects and sends one Telegram text and voice notification per exact model run after the point-specific NOAA subset is available.

## Data sources and point-specific forecast retrieval

- Run discovery is performed directly against NOAA's public `noaa-gfs-bdp-pds` S3 inventory. The watcher sends lightweight HTTP HEAD requests for each recent 00Z/06Z/12Z/18Z cycle's `f180` GRIB2 object. A successful response confirms that the exact +180-hour global model file has been published; it does not download the 500+ MB object.
- WXCharts identifies NOAA/NCEP as its GFS source. Instead of scraping third-party chart pages or waiting for a secondary archive API, this project reads the underlying operational NOAA/NCEP GFS 0.25° GRIB2 data directly.
- Forecast files are requested through the [NOAA/NCEP NOMADS regional GRIB filter](https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl). The filter is constrained to a tiny bounding box around the requested location; the global GRIB files are not downloaded.
- Requested coordinate: **41.014°N, 28.950°E**. The nearest native GFS 0.25° grid node is **41.000°N, 29.000°E**. Forecast values represent that model grid cell, not an interpolation over all of Istanbul.
- GRIB2 messages are decoded with ecCodes. The point forecast uses 2 m temperature, 10 m U/V wind components and surface precipitation. The live current-condition snapshot is retrieved separately from the Forecast API at the exact requested latitude/longitude.
- Values are converted to °C, km/h and mm. Precipitation uses the specific six-hour accumulation period when available; cumulative run totals are not added repeatedly.
- The forecast timeline contains the 31 six-hour valid times from +0 to +180. Daily minima/maxima, precipitation totals and wind maxima are aggregated from those six-hour samples, so daily extremes are sample-based rather than hourly.

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

- Every 10 minutes, the workflow checks NOAA S3 for the latest six GFS cycle files (00Z, 06Z, 12Z and 18Z, including recent prior cycles).
- A run becomes eligible as soon as its exact global `f180` GRIB2 object exists on NOAA S3. This is the run-discovery trigger; Open-Meteo metadata and its archive API are not required.
- The watcher then requests the compact single-point +180 file from NOAA/NCEP NOMADS first. If the filtered NOMADS data or any earlier six-hour step is not yet available, the run remains unprocessed and is retried on the next scheduled check.
- Each NOMADS subset request is spaced by at least 10 seconds. A full +0 to +180 timeline uses six-hour forecast steps and only the nearest GFS grid cell for the configured coordinate.

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
