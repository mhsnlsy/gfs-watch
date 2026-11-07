# gfs-watch ECMWF Container

Staged Cloudflare Container runtime for the ECMWF publication job.

The container runs the existing scripts/fetch_ecmwf_eps.py and
scripts/render_ecmwf_report_charts.py. The current production path uses
the MeteoPT ECMWF JSON endpoint; the older ecCodes/GRIB2 functions remain
in the source as unused fallback code.

The Worker publishes generated JSON/PNG assets to the existing
gfs-watch-live-archive R2 bucket under data/ecmwf/.

Schedule: 10:15 UTC and 22:15 UTC.

This is intentionally staged separately from the existing GitHub Actions
publisher. The GitHub publisher remains active until a live Container ->
R2 -> web verification succeeds.

Deployment token note: the Container deploy workflow uses CLOUDFLARE_CONTAINER_API_TOKEN, which was configured for broad account access.


Deployment diagnostics: before deploying, the workflow runs `wrangler whoami` and `wrangler containers list` to distinguish account authentication/plan access from deployment configuration failures.
