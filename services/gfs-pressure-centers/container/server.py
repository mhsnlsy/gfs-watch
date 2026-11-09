import json, os, subprocess, tempfile, time
from http.server import BaseHTTPRequestHandler, HTTPServer

LATEST_CACHE_TTL = 300
_latest_cache = None
_latest_cache_at = 0.0


def _cors_headers(handler):
    handler.send_header("access-control-allow-origin", "*")
    handler.send_header("access-control-allow-methods", "GET,POST,OPTIONS")
    handler.send_header("access-control-allow-headers", "content-type")


def _latest():
    global _latest_cache, _latest_cache_at
    now = time.time()
    if _latest_cache is not None and now - _latest_cache_at < LATEST_CACHE_TTL:
        return _latest_cache
    result = subprocess.run(
        ["python", "/app/fetch_latest_grib2.py"],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if result.returncode:
        raise RuntimeError(result.stderr[-6000:] or "latest GRIB2 analysis failed")
    payload = json.loads(result.stdout)
    _latest_cache = payload
    _latest_cache_at = now
    return payload


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        _cors_headers(self)
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self.send_response(204)
        _cors_headers(self)
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"status": "ok", "service": "gfs-pressure-centers"})
            return
        if self.path == "/latest":
            try:
                self._send(200, _latest())
            except Exception as exc:
                self._send(503, {
                    "status": "error",
                    "service": "gfs-pressure-centers",
                    "error": "latest_grib2_unavailable",
                    "detail": str(exc)[-6000:],
                })
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/analyze":
            self._send(404, {"error": "not_found"})
            return
        n = int(self.headers.get("content-length", "0"))
        data = self.rfile.read(n)
        with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as f:
            f.write(data)
            name = f.name
        try:
            r = subprocess.run(
                ["python", "/app/grib2_analyze.py", name],
                capture_output=True,
                text=True,
                timeout=90,
            )
            if r.returncode:
                self._send(422, {"status": "error", "stderr": r.stderr[-4000:]})
                return
            self._send(200, json.loads(r.stdout))
        finally:
            try:
                os.unlink(name)
            except OSError:
                pass


HTTPServer(("0.0.0.0", 8080), H).serve_forever()
