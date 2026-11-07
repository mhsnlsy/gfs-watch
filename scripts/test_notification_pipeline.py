"""Offline contract tests for the Cloudflare-first weather platform."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def main() -> None:
    publisher = read(".github/workflows/publish-live-site.yml")
    report_workflow = read(".github/workflows/istanbul-gfs-10min.yml")
    platform_workflow = read(".github/workflows/deploy-cloudflare-platform.yml")
    istanbul_deploy = read(".github/workflows/deploy-istanbul-gfs-worker.yml")
    poller = read("scripts/poll_istanbul_gfs_10min.py")
    builder = read("scripts/build_istanbul_gfs_publication.py")
    sender = read("scripts/send_pending_istanbul_gfs_telegram.py")

    # Pages remains an on-demand/source-change fallback, not a 5-minute publisher.
    assert "Publish GitHub Pages Fallback" in publisher
    assert "workflow_dispatch:" in publisher
    assert "actions/deploy-pages@v4" in publisher
    assert "schedule:" not in publisher
    assert "group: live-pages-publisher" in publisher
    assert "push:" not in publisher and "workflow_run:" not in publisher

    # Cloudflare is the only live GFS collector. GitHub syncs D1 for reports.
    assert 'cron: "*/10 * * * *"' in report_workflow
    assert "ISTANBUL_GFS_API" in report_workflow
    assert "gfs-watch-web.muhsin-ulusoy.workers.dev/gfs/latest" in report_workflow
    assert "scripts/poll_istanbul_gfs_10min.py" in report_workflow
    assert "Cloudflare D1" in report_workflow
    assert "steps.poll.outputs.f180_ready == 'true'" in report_workflow
    assert "publish-live-site.yml" not in report_workflow
    assert "publish-pages:" not in report_workflow
    assert "pages: write" not in report_workflow
    assert "telegram:" in report_workflow
    assert "scripts/send_pending_istanbul_gfs_telegram.py" in report_workflow
    assert "TELEGRAM_TOKEN" in report_workflow and "CHAT_ID" in report_workflow
    assert "cancel-in-progress: false" in report_workflow

    assert "gfs-watch-web.muhsin-ulusoy.workers.dev/gfs/latest" in poller
    assert "comparison_runs" in poller
    assert "is_f180_ready" in poller and "is_f72_ready" in poller
    assert "fetch_cycle" not in poller
    assert "fetch_istanbul_gfs_meteopt" not in poller

    # Report rendering and exactly-once Telegram delivery remain unchanged.
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
    services = {item["binding"]: item["service"] for item in web["services"]}
    assert services == {
        "ISTANBUL_GFS": "gfs-watch-istanbul-gfs",
        "KOY_GFS": "gfs-watch-koy-gfs",
        "STATIONS": "gfs-watch-stations",
    }
    assert "Deploy Cloudflare Worker + Static Assets" in platform_workflow
    assert "Verify Cloudflare website and proxied APIs" in platform_workflow
    assert "istanbul-gfs-worker/**" not in platform_workflow
    assert "Locate or create Istanbul GFS D1" not in platform_workflow
    assert "Deploy Istanbul GFS Worker + D1" in istanbul_deploy
    assert "istanbul-gfs-worker/**" in istanbul_deploy
    assert "Deploy autonomous Istanbul GFS Cron Worker" in istanbul_deploy

    istanbul = json.loads(read("istanbul-gfs-worker/wrangler.jsonc"))
    koy = json.loads(read("koy-gfs-worker/wrangler.jsonc"))
    stations = json.loads(read("station-worker/wrangler.jsonc"))
    assert istanbul["triggers"]["crons"] == ["*/10 * * * *"]
    assert koy["triggers"]["crons"] == ["*/10 * * * *"]
    assert stations["triggers"]["crons"] == ["*/2 * * * *"]
    assert istanbul["d1_databases"][0]["database_name"] == "gfs-watch-istanbul-gfs"
    assert koy["d1_databases"][0]["database_name"] == "gfs-watch-koy-gfs"
    assert stations["d1_databases"][0]["database_name"] == "gfs-watch-stations"

    api_config = read("site/gfs-api-config.js")
    index = read("site/index.html")
    koy_page = read("site/koy.js")
    comparison = read("site/gfs-cycle-compare.html")
    assert "gfs-watch-web.muhsin-ulusoy.workers.dev" in api_config
    assert "/gfs/latest" in index
    assert "/api/koy-gfs/" in koy_page
    assert 'const stationApi=(window.GFS_WATCH_API_BASE||window.location.origin)+"/api/history/"+' in comparison
    assert "gfs-watch-stations.muhsin-ulusoy.workers.dev" not in comparison

    print(
        "[CLOUDFLARE-FIRST PLATFORM] Static Assets, Service Bindings, D1 Cron "
        "collections, same-origin API routing, Pages fallback and Telegram "
        "report sidecar contracts passed."
    )


if __name__ == "__main__":
    main()
