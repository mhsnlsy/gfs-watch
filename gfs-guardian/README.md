# GFS Cloudflare Guardian

The Guardian is an independent Cloudflare Worker that watches the primary Istanbul GFS Worker. It has no GitHub API or GitHub Actions runtime dependency.

## Behaviour

- Runs at minutes 05, 15, 25, 35, 45 and 55 of every hour.
- Reads the primary Worker's D1-backed /api/health endpoint through a Cloudflare Service Binding.
- Waits while the primary collection is recent or has started within the last 18 minutes.
- If the last successful collection is older than 25 minutes, it calls the primary Worker's authenticated /internal/reconcile route through the same Service Binding.
- The primary Worker remains the only collector, publisher and Telegram sender. The Guardian only requests a recovery collection.

## Bindings and secret

The ISTANBUL_GFS service binding targets gfs-watch-istanbul-gfs. The GFS_DISPATCH_TOKEN Worker secret is used only as a shared Worker-to-Worker authentication token; this Worker does not call GitHub.

## Health check

https://gfs-watch-gfs-guardian.muhsin-ulusoy.workers.dev/health

The health endpoint exposes configuration metadata only, not secrets or live pipeline state.
