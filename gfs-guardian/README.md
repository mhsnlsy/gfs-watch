# GFS Cloudflare Guardian

This Worker is a watchdog for the Istanbul GFS pipeline. It does not download model data, build reports, publish Pages, or send Telegram messages. GitHub Actions remains the only producer.

## Behaviour

- Runs on the Cloudflare Cron Trigger every nine minutes (UTC).
- Reads the latest runs of `.github/workflows/istanbul-gfs-10min.yml` on `main`.
- Does nothing while the GFS workflow is queued or running.
- Treats a successful workflow completion in the last 15 minutes as a healthy heartbeat.
- If the last successful completion is older than 15 minutes (or none exists), dispatches that same GitHub workflow on `main`.
- Applies an 18-minute cooldown after a fallback dispatch to avoid rapid retry storms.
- Existing workflow concurrency and publication/Telegram idempotency remain authoritative.

## Required secret

Set the GitHub Actions repository secret `GITHUB_GFS_DISPATCH_TOKEN` before deployment. Use a fine-grained PAT restricted to `mhsnlsy/gfs-watch` with **Actions: Read and write** permission. The token is stored as the Cloudflare Worker secret `GITHUB_DISPATCH_TOKEN` by the deployment workflow; it is never written to the repository.

The existing repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are also required by the deployment workflow.

## Health check

After deployment:

`https://gfs-watch-gfs-guardian.muhsin-ulusoy.workers.dev/health`

The Worker exposes only static configuration metadata on this route. It does not expose the GitHub token or pipeline state.
