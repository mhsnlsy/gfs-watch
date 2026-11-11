"""Offline contract tests for the Cloudflare-first weather platform."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def main() -> None:
    publisher = read(".github/workflows/publish-live-site.yml")
    report_workflow_path = ROOT / ".github/workflows/istanbul-gfs-10min.yml"
    platform_workflow = read(".github/workflows/deploy-cloudflare-platform.yml")
    archive_sync = read(".github/workflows/sync-cloudflare-live-archive.yml")
    istanbul_deploy = read(".github/workflows/deploy-istanbul-gfs-worker.yml")
    guardian = read("gfs-guardian/src/index.js")
    guardian_config = json.loads(read("gfs-guardian/wrangler.jsonc"))
    gfs_worker = read("istanbul-gfs-worker/src/index.js")
    meteopt_source = read("shared/meteopt-source.js")
    assert "METEOPT_GFS_API" in gfs_worker
    assert "METEOPT_ECMWF_API" in gfs_worker
    assert "api.meteopt.com/ecmwf/json" in meteopt_source
    assert "api.meteopt.com/gfs/json" in meteopt_source
    assert '41.0901' in gfs_worker and '28.9436' in gfs_worker
    assert 'ECMWF_ARCHIVE' in gfs_worker
    assert '/ecmwf/latest' in gfs_worker
    assert '/ecmwf/comparison' in gfs_worker
    gfs_publication = read("istanbul-gfs-worker/src/publication.js")
    web_worker = read("web-worker/src/index.js")
    web_config = json.loads(read("web-worker/wrangler.jsonc"))
    koy_worker = read("koy-gfs-worker/src/index.js")
    assert "METEOPT_GFS_API" in koy_worker
    assert "METEOPT_SOURCE_POLICY" in koy_worker
    koy_svg_workflow = read(".github/workflows/rebuild-koy-gfs-interactive-svg.yml")
    istanbul_svg_workflow = read(".github/workflows/rebuild-istanbul-gfs-images.yml")
    koy_deploy = read(".github/workflows/deploy-koy-gfs-worker.yml")
    poller = read("scripts/poll_istanbul_gfs_10min.py")
    builder = read("scripts/build_istanbul_gfs_publication.py")
    sender = read("scripts/send_pending_istanbul_gfs_telegram.py")
    dispatch_migration = read("istanbul-gfs-worker/migrations/0002_create_report_dispatch_queue.sql")
    native_delivery_migration = read("istanbul-gfs-worker/migrations/0004_cloudflare_native_report_delivery.sql")
    delivery_lease_migration = read("istanbul-gfs-worker/migrations/0005_report_delivery_leases.sql")
    heartbeat_photo_migration = read("istanbul-gfs-worker/migrations/0006_heartbeat_and_telegram_photo.sql")

    # Pages remains an on-demand/source-change fallback, not a 5-minute publisher.
    assert "Publish GitHub Pages Fallback" in publisher
    assert "workflow_dispatch:" in publisher
    assert "actions/deploy-pages@v4" in publisher
    assert "schedule:" not in publisher
    assert "group: live-pages-publisher" in publisher
    # GitHub Pages is a manual-only rollback path, never an automatic workflow_run deployment.
    assert "workflow_run:" not in publisher

    # Istanbul GFS collection, F180 report generation and Telegram delivery are now
    # fully Cloudflare-native. GitHub has no runtime GFS update workflow.
    assert not report_workflow_path.exists()

    assert "gfs-watch-web.muhsin-ulusoy.workers.dev/gfs/latest" in poller
    assert "comparison_runs" in poller
    assert "is_f180_ready" in poller and "is_f72_ready" in poller
    assert "fetch_cycle" not in poller
    assert "fetch_istanbul_gfs_meteopt" not in poller
    assert "GFS_TRIGGERED_RUN_ID" in poller

    # Python publication remains an explicit emergency fallback; the live renderer and sender are Worker-native.
    assert "GFS_TARGET_RUN_ID" in builder
    assert "create_valid_time_comparison_assets" in builder
    assert "save_public_notification_svg_image" in builder
    assert "telegram_image_path" in builder
    assert "telegram-sent" in sender
    assert "text_message_id" in sender and "photo_message_id" in sender
    assert "send_photo" in sender

    # Cloudflare web host: Static Assets + Service Bindings.
    web = json.loads(read("web-worker/wrangler.jsonc"))
    assert web["assets"]["directory"] == "./public"
    assert web["assets"]["binding"] == "ASSETS"
    r2_bindings = web.get("r2_buckets", [])
    assert any(item.get("binding") == "LIVE_ARCHIVE" and item.get("bucket_name") == "gfs-watch-live-archive" for item in r2_bindings)
    assert "/data/ecmwf/*" in web["assets"]["run_worker_first"]
    assert "/koy-data/gfs/*" in web["assets"]["run_worker_first"]
    assert "/data/notifications/*" in web["assets"]["run_worker_first"]
    services = {item["binding"]: item["service"] for item in web["services"]}
    assert services == {
        "ISTANBUL_GFS": "gfs-watch-istanbul-gfs",
        "KOY_GFS": "gfs-watch-koy-gfs",
        "STATIONS": "gfs-watch-stations",
    }
    assert "Deploy Cloudflare Worker + Static Assets" in platform_workflow
    assert "Verify Cloudflare website and proxied APIs" in platform_workflow
    # MGM observations are D1/API-only; do not check out or ship their old static branch.
    assert "koy-mgm-data" not in platform_workflow
    assert "koy-mgm-data/mgm" not in platform_workflow
    assert "koy-mgm-data" not in publisher
    # R2 migration is staged independently and uses a dedicated least-privilege token.
    assert "workflow_dispatch:" in archive_sync
    assert "push:" not in archive_sync
    assert "push:" not in archive_sync
    assert "CLOUDFLARE_R2_API_TOKEN" in archive_sync
    assert "koy-mgm-data" not in archive_sync
    assert "istanbul-gfs-worker/**" not in platform_workflow
    assert "Locate or create Istanbul GFS D1" not in platform_workflow
    assert "Deploy Istanbul GFS Worker + D1" in istanbul_deploy
    assert "istanbul-gfs-worker/**" in istanbul_deploy
    assert "Deploy autonomous Istanbul GFS Cron Worker" in istanbul_deploy
    assert "GFS_DISPATCH_TOKEN" in istanbul_deploy
    assert "wrangler secret put GFS_DISPATCH_TOKEN" in istanbul_deploy
    assert "gfs_report_dispatch_queue" in gfs_worker
    # Live report assets are now published into Istanbul D1; the web gateway
    # serves them through the Istanbul Service Binding instead of requiring
    # the GitHub archive branch on the primary Cloudflare site.
    assert "gfs_publication_assets" in gfs_worker
    assert "/gfs/publication-upload" in gfs_worker
    assert "/gfs/publication-asset/" in gfs_worker
    assert gfs_worker.index('if (path === "/gfs/publication-upload")') < gfs_worker.index('if (request.method !== "GET")')
    assert '"Access-Control-Allow-Methods": "GET, POST, OPTIONS"' in gfs_worker
    assert "X-GFS-Archive-Source" in web_worker
    assert "fetchArchiveObject(request, env, path)" in web_worker
    assert "R2" in web_worker
    assert "fetchD1PublicationAsset" in web_worker
    assert '"/gfs/publication-asset/" + normalized' in web_worker
    assert 'path.startsWith("/gfs/publication-asset/")' in web_worker
    assert 'path.startsWith("/api/publication-asset/")' in web_worker
    # Legacy SVG rebuild remains manual-only; production SVG generation is Cloudflare-native.
    assert "workflow_dispatch:" in istanbul_svg_workflow
    assert "push:" not in istanbul_svg_workflow
    assert "Publish rebuilt report assets to Cloudflare D1" in istanbul_svg_workflow
    assert "gfs/publication-upload" in istanbul_svg_workflow
    assert "GFS_DISPATCH_TOKEN" in istanbul_svg_workflow
    assert "publication-asset/notifications/latest.json" in istanbul_svg_workflow
    assert "Verified D1 live SVG dark surfaces" in istanbul_svg_workflow
    assert 'path.startsWith("/data/notifications/")' in web_worker
    # ECMWF is now collected by the Istanbul GFS Worker from the canonical MeteoPT source and archived
    # directly into D1/R2; there is no separate ECMWF GitHub Actions workflow.
    assert "METEOPT_ECMWF_API" in gfs_worker
    assert "wind10mdir" in gfs_worker
    assert "wind_direction_10m_deg = number(windDirectionSeries, index)" in gfs_worker
    assert 'UPDATE gfs_runs SET payload_json = ?' in gfs_worker
    assert "ECMWF_ARCHIVE" in gfs_worker
    assert "data/ecmwf/latest.json" in platform_workflow
    assert "Verified live ECMWF payload served from R2" in platform_workflow
    assert 'path.startsWith("/data/ecmwf/")' in web_worker
    assert "path.slice(1)" in web_worker
    assert '"public/ecmwf/**"' not in platform_workflow
    # Köy four-panel SVG rendering now runs inside the Cloudflare Worker and persists to D1.
    assert "gfs_publication_assets" in koy_worker
    assert 'wind_direction_enrichment_checked: true' in koy_worker
    assert 'needsWindDirectionEnrichment' in koy_worker
    assert 'KOY_SVG_RENDERER_VERSION = "cloudflare-js-v4"' in koy_worker
    assert "function buildKoyInteractiveSvg" in koy_worker
    assert "function publishLatestKoySvg" in koy_worker
    assert 'const KOY_SVG_RENDERER_VERSION = "cloudflare-js-v4"' in koy_worker
    assert 'path === "/api/comparison.svg"' in koy_worker
    assert "comparison_svg_published" in koy_worker
    assert "svg_renderer: KOY_SVG_RENDERER_VERSION" in koy_worker
    assert "/api/publication-asset/" in koy_worker
    assert "/api/publication-upload" not in koy_worker
    assert "GFS_DISPATCH_TOKEN" not in koy_worker and "GFS_DISPATCH_TOKEN" not in koy_deploy
    assert 'path.startsWith("/koy-data/gfs/")' in web_worker
    assert "/koy-data/gfs/*" in web_config["assets"]["run_worker_first"]
    assert '"/api/publication-asset/" + assetKey' in web_worker
    assert "workflow_dispatch:" in koy_svg_workflow
    assert "schedule:" not in koy_svg_workflow
    assert "push:" not in koy_svg_workflow
    assert "comparison.svg" in koy_svg_workflow
    assert "cloudflare-js-v3" in koy_svg_workflow
    assert "matplotlib" not in koy_svg_workflow.lower()
    assert "workflow_run:" not in platform_workflow
    assert "actions/workflows/istanbul-gfs-10min.yml/dispatches" not in gfs_worker
    assert "processQueuedReports(env)" in gfs_worker
    assert "deliverPendingTelegram(env)" in gfs_worker
    assert "sendPhoto" in gfs_worker and "sendMessage" in gfs_worker
    assert "sendDocument" not in gfs_worker
    assert 'form.set("photo"' in gfs_worker
    assert "png_asset_key" in gfs_worker and "photo_message_id" in gfs_worker
    assert "renderIstanbulPhotoPng" in gfs_worker
    photo_renderer = read("istanbul-gfs-worker/src/photo.js")
    assert "Resvg.async" in photo_renderer and "asPng()" in photo_renderer
    assert "gfs_worker_heartbeat" in gfs_worker
    assert "last_cron_success_at_utc" in gfs_worker
    assert "/internal/reconcile" in gfs_worker
    assert "native_report_generation: true" in gfs_worker
    assert "telegram_configured" in gfs_worker
    assert "pending_report_publications" in gfs_worker
    assert "sent_report_publications" in gfs_worker
    assert "exhausted_report_publications" in gfs_worker
    assert "latest_report_publication" in gfs_worker
    assert "retainedItems" in gfs_worker
    assert ".slice(0, 4)" in gfs_worker
    assert "export function buildIstanbulInteractiveSvg" in gfs_publication
    assert "export function buildIstanbulReportText" in gfs_publication
    assert "gfs_report_publications" in native_delivery_migration
    assert "text_message_id TEXT" in native_delivery_migration
    assert "document_message_id TEXT" in native_delivery_migration
    assert "photo_message_id TEXT" in heartbeat_photo_migration
    assert "png_asset_key TEXT" in heartbeat_photo_migration
    assert "CREATE TABLE IF NOT EXISTS gfs_worker_heartbeat" in heartbeat_photo_migration
    assert "lease_until_utc TEXT" in delivery_lease_migration
    assert "status = 'sending'" in gfs_worker
    assert "lease_until_utc" in gfs_worker
    assert "LIMIT 1" in gfs_worker
    assert "CREATE TABLE IF NOT EXISTS gfs_report_dispatch_queue" in dispatch_migration
    assert "status TEXT NOT NULL DEFAULT 'pending'" in dispatch_migration
    assert guardian_config["triggers"]["crons"] == ["5,15,25,35,45,55 * * * *"]
    assert guardian_config["services"] == [{"binding": "ISTANBUL_GFS", "service": "gfs-watch-istanbul-gfs"}]
    assert "ISTANBUL_GFS.fetch" in guardian
    assert "/internal/reconcile" in guardian
    assert "api.github.com" not in guardian
    assert "workflow_dispatch" not in guardian

    istanbul = json.loads(read("istanbul-gfs-worker/wrangler.jsonc"))
    koy = json.loads(read("koy-gfs-worker/wrangler.jsonc"))
    stations = json.loads(read("station-worker/wrangler.jsonc"))
    assert istanbul["triggers"]["crons"] == ["*/10 * * * *"]
    assert {"binding": "STATIONS", "service": "gfs-watch-stations"} in istanbul.get("services", [])
    assert "fetchActiveEnkaStationObservation(env)" in gfs_worker
    assert "env.STATIONS.fetch" in gfs_worker
    assert 'rh2m: "humidity_2m_percent"' in gfs_worker
    assert koy["triggers"]["crons"] == ["*/10 * * * *"]
    assert stations["triggers"]["crons"] == ["*/2 * * * *"]
    assert istanbul["d1_databases"][0]["database_name"] == "gfs-watch-istanbul-gfs"
    assert koy["d1_databases"][0]["database_name"] == "gfs-watch-koy-gfs"
    assert stations["d1_databases"][0]["database_name"] == "gfs-watch-stations"

    api_config = read("site/gfs-api-config.js")
    index = read("site/index.html")
    home_app = read("site/home-app.js")
    koy_page = read("site/koy.js")
    assert "gfs-watch-web.muhsin-ulusoy.workers.dev" in api_config
    assert "/gfs/latest" in home_app
    assert "DATA_API_BASE=(window.ISTANBUL_GFS_API_BASE||window.location.origin)" in home_app
    assert '+"/api/"' in koy_page
    # Köy report SVG is served at the existing URL from its D1 Service Binding,
    # while the live site verifies the production notification path directly.
    assert "Verify the production notification path is served Worker-first from D1" in platform_workflow
    assert "/gfs/notification-latest?verify=" in platform_workflow
    assert "/data/notifications/$LIVE_SVG_PATH" in platform_workflow
    assert "Check out Köy GFS archive" not in platform_workflow
    assert "ref: koy-gfs-data" not in platform_workflow
    assert "GITHUB_WORKSPACE/koy-data" not in platform_workflow
    assert "KOY_SVG_REL" not in platform_workflow

    print(
        "[CLOUDFLARE-FIRST PLATFORM] Static Assets, Service Bindings, D1 Cron "
        "collections, same-origin API routing, Pages fallback and Telegram "
        "report sidecar contracts passed."
    )


if __name__ == "__main__":
    main()
