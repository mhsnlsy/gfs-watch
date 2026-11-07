from __future__ import annotations

import json
import mimetypes
import os
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(os.getenv("ECMWF_PUBLIC_DIR", "/tmp/public/ecmwf"))
LOCK = threading.Lock()
STATE = {"running": False, "last_result": None}


def run_forecast() -> dict:
    with LOCK:
        if STATE["running"]:
            return {"ok": False, "error": "ECMWF job already running"}
        STATE["running"] = True
        try:
            if ROOT.exists():
                shutil.rmtree(ROOT)
            ROOT.mkdir(parents=True, exist_ok=True)
            result = subprocess.run(
                ["python", "-u", "/app/scripts/fetch_ecmwf_eps.py",
                 "--output-dir", str(ROOT), "--force"],
                cwd="/app",
                text=True,
                capture_output=True,
                timeout=20 * 60,
            )
            if result.returncode != 0:
                STATE["last_result"] = {
                    "ok": False,
                    "exit_code": result.returncode,
                    "stdout": result.stdout[-12000:],
                    "stderr": result.stderr[-12000:],
                }
                return STATE["last_result"]

            latest = json.loads((ROOT / "latest.json").read_text(encoding="utf-8"))
            files = [
                str(path.relative_to(ROOT))
                for path in sorted(ROOT.rglob("*"))
                if path.is_file() and path.suffix.lower() in {".json", ".png"}
            ]
            STATE["last_result"] = {
                "ok": True,
                "run_id_utc": latest.get("run_id_utc"),
                "forecast_horizon_hours": latest.get("forecast_horizon_hours"),
                "files": files,
                "stdout": result.stdout[-12000:],
            }
            return STATE["last_result"]
        except Exception as exc:
            STATE["last_result"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            return STATE["last_result"]
        finally:
            STATE["running"] = False


class Handler(BaseHTTPRequestHandler):
    def _json(self, payload: dict, status: int = 200):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/health":
            self._json({"ok": True, "service": "gfs-watch-ecmwf-container"})
            return
        if self.path == "/status":
            self._json({"ok": True, "running": STATE["running"], "last_result": STATE["last_result"]})
            return
        if self.path.startswith("/file/"):
            key = self.path[len("/file/"):].lstrip("/")
            target = (ROOT / key).resolve()
            if not str(target).startswith(str(ROOT.resolve()) + os.sep):
                self._json({"ok": False, "error": "Invalid file path"}, 400)
                return
            if not target.is_file():
                self._json({"ok": False, "error": "File not found"}, 404)
                return
            raw = target.read_bytes()
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        self._json({"ok": False, "error": "Not found"}, 404)

    def do_POST(self):
        if self.path != "/run":
            self._json({"ok": False, "error": "Not found"}, 404)
            return
        result = run_forecast()
        self._json(result, 200 if result.get("ok") else 500)

    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
