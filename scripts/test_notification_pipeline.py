"""Regression tests for independent Telegram/Pages delivery and retained GFS history."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    main_source = (ROOT / "main.py").read_text(encoding="utf-8")
    process_start = main_source.index("async def process_gfs_update(")
    process_end = main_source.index("\nasync def run_manual_multi_comparison", process_start)
    process = main_source[process_start:process_end]

    commit_at = process.index("await asyncio.to_thread(save_run, run_id, payload)")
    publish_at = process.index("publish_public_notification")
    telegram_at = process.index("await asyncio.wait_for(deliver_telegram_report()")
    assert commit_at < publish_at < telegram_at
    assert "TELEGRAM REPORT ERROR" in process
    assert "send_telegram_voice(audio_file, cleanup=False)" in process, (
        "Pages must be able to archive the voice asset while Telegram sends it."
    )
    assert "[GFS CYCLE COMMITTED]" in process

    gfs_workflow = (ROOT / ".github/workflows/gfs-watch.yml").read_text(encoding="utf-8")
    restore_start = gfs_workflow.index("Restore GFS run and Pages notification history")
    report_start = gfs_workflow.index("Watch MeteoPT until the 3-hour series reaches +180h")
    restore_section = gfs_workflow[restore_start:report_start]
    assert "git archive origin/gfs-watch-state public | tar -x -C ." in restore_section
    assert gfs_workflow.index("rm -rf public/notifications") < gfs_workflow.index('cp -a "$RUNNER_TEMP/public/." public/')
    assert 'if [ "${{ steps.check-gfs.outcome }}" = "success" ] && [ -d public ]; then' in gfs_workflow
    assert "Report step failed; keeping the previously published Pages forecast and notification archive." in gfs_workflow
    deploy_section = gfs_workflow.split("  deploy-pages:", 1)[1].split("  send-web-push:", 1)[0]
    assert "if: needs.check-gfs.result == 'success' && needs.check-gfs.outputs.gfs_updated == 'true'" in deploy_section
    assert "needs.telegram" not in deploy_section.lower()

    pages_workflow = (ROOT / ".github/workflows/pages.yml").read_text(encoding="utf-8")
    assert "Verify latest GFS report and every referenced Pages asset" in pages_workflow
    assert 'base_url="${PAGE_URL%/}/data/notifications"' in pages_workflow
    assert "latest.json?verify=$GITHUB_RUN_ID" in pages_workflow
    assert "Live Pages serves" in pages_workflow
    assert "Pages notification media is missing" in pages_workflow

    for workflow_name in (
        "render-pages-charts-from-saved-data.yml",
    ):
        workflow = (ROOT / ".github/workflows" / workflow_name).read_text(encoding="utf-8")
        assert "actions: write" in workflow, f"{workflow_name} cannot dispatch Pages."
        assert 'gh workflow run pages.yml --ref main --repo "$GITHUB_REPOSITORY"' in workflow, (
            f"{workflow_name} must redeploy Pages after publishing notification files."
        )

    print("[NOTIFICATION PIPELINE SMOKE] Shared GFS trigger, independent parallel channel attempts, "
          "non-blocking failure handling and live Pages media verification passed.")


if __name__ == "__main__":
    main()
