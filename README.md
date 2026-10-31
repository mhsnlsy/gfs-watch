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
4. The scheduled workflow checks for new GFS runs every 5 minutes during four Istanbul-time windows: 06:30–08:30, 12:30–14:30, 18:30–20:30 and 00:30–02:30. GitHub may delay scheduled starts during periods of high load.

The workflow installs the ecCodes system library and Python package automatically on its GitHub-hosted runner.

## Run tracking and +180-hour threshold

- During the four daily Istanbul-time windows (06:30–08:30, 12:30–14:30, 18:30–20:30 and 00:30–02:30), the workflow checks NOAA S3 every five minutes for the latest six GFS cycle files (00Z, 06Z, 12Z and 18Z, including recent prior cycles).
- A run becomes eligible as soon as its exact global `f180` GRIB2 object exists on NOAA S3. This is the run-discovery trigger; Open-Meteo metadata and its archive API are not required.
- Before +180 is published, the watcher incrementally prefetches up to four available early forecast files (f000–f174) per check and stores them in a GitHub Actions cache shared with the next check. When the exact global f180 object appears, the watcher reuses those cached files and downloads only the missing forecast steps.
- A full +0 to +180 timeline still uses all 31 six-hour forecast steps and only the nearest GFS grid cell for the configured coordinate. Cache entries are removed after a run is processed and abandoned cycle caches are pruned after 48 hours.
- Each actual NOMADS subset HTTP request remains spaced by at least 10 seconds, in line with the NOMADS Grib Filter guidance. Cached files do not incur network pacing delays.

## Public machine-readable JSON

After a GFS run has been successfully processed, the workflow publishes JSON files on the public `gfs-watch-state` branch:

- [Latest forecast JSON](https://raw.githubusercontent.com/mhsnlsy/gfs-watch/gfs-watch-state/public/latest.json) — always points to the latest processed run.
- Archived run JSON files use `public/runs/YYYYMMDDTHHZ.json`, for example `20261031T06Z.json`. The workflow retains the latest 10 days of run files.

The JSON includes the exact requested coordinate (41.014°N, 28.950°E), the nearest native GFS grid point (41.000°N, 29.000°E), the GFS run time, 31 six-hour forecast points through +180 hours, daily summaries, units and source metadata. Forecast timestamps include both UTC and Europe/Istanbul time. The live current-conditions snapshot is separately labelled as Open-Meteo; the forecast itself is NOAA/NCEP GFS.

This is a downloadable public data file, not a live feed automatically consumed by WXCharts or Meteopt. Those platforms would need to support and be configured for a custom data source.

## Run history and comparisons

- The SQLite database is stored in the `gfs-watch-state` branch and restored before each check.
- The latest 10 days of run history are retained.
- Run-to-run temperature, six-hour precipitation and 10 m wind-speed changes are presented in the four-cycle comparison image, not repeated in the text report or voice script.
- The comparison image uses a shared set of overlapping Istanbul calendar dates across all four cycles. Every panel labels each date with its Turkish weekday. The first lead of a new cycle has no six-hour precipitation interval preceding its own initialisation, so that point is excluded from precipitation comparisons.
- At model initialisation, a separate NOAA/NCEP mean-sea-level pressure subset is analysed inside a 2,500 km diameter circle centred on 41.014°N, 28.950°E. High/low pressure findings are written in the text report only and are not included in the voice script.
- Do not delete or manually edit the `gfs_watch.db` file in the state branch; the workflow maintains it.

## Report clarity

- The Telegram report identifies the output type, model-cycle time in TSİ and UTC, report creation time, and the full +180-hour validity interval in TSİ.
- Daily summaries use Turkish weekday names and calendar dates instead of relative labels such as "tomorrow" or "the following day".
- The voice script also uses weekday names for daily summaries. Regional pressure findings and all previous-run change/comparison narration are excluded from the voice script. Run-to-run changes appear only in the four-cycle comparison image.

## Notification behaviour

- One text notification is sent per eligible GFS run; there are no separate notifications for forecast changes.
- Every automatic GFS cycle notification (00Z, 06Z, 12Z and 18Z) also sends a four-cycle PNG comparison chart to Telegram: the current run plus the three immediately preceding six-hour cycles. For example, a 12Z notification compares 18Z (previous day), 00Z, 06Z and the new 12Z run.
- The chart contains grouped daily temperature candlesticks (first/last six-hour sample as open/close; daily low/high as wick), grouped daily precipitation totals and grouped daily maximum wind speed. All four runs use the same set of overlapping Istanbul calendar dates and consistent colours across panels.
- The three exact preceding runs are loaded from SQLite in read-only mode. If a run is missing from retained history, its NOAA/NCEP forecast is fetched read-only for chart generation; this fallback does not save a DB row, alter notification state or update public JSON. Manual report resends do not generate or send comparison images.
- Telegram text delivery does not wait for TTS. Audio generation starts concurrently in a background thread.
- TTS generation and Telegram voice delivery each retry up to three times after failures. If audio cannot be produced or sent, the text report remains delivered.
- GitHub Actions prevents overlapping GFS Watch jobs.
