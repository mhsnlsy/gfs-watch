import json
import os
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
BASE = os.path.dirname(os.path.abspath(__file__))


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"status": "ok", "service": "gfs-pressure-centers"})
        if self.path == "/latest":
            try:
                result = subprocess.run(
                    ["python", os.path.join(BASE, "fetch_latest_grib2.py")],
                    capture_output=True,
                    text=True,
                    timeout=180,
                    check=True,
                )
                return self._send(200, json.loads(result.stdout))
            except subprocess.CalledProcessError as exc:
                return self._send(502, {"status": "error", "error": exc.stderr[-4000:] or "analysis failed"})
            except Exception as exc:
                return self._send(500, {"status": "error", "error": str(exc)})
        return self._send(404, {"status": "error", "error": "not found"})

    def do_POST(self):
        if self.path != "/analyze":
            return self._send(404, {"status": "error", "error": "not found"})
        length = int(self.headers.get("content-length", "0"))
        if length <= 0:
            return self._send(400, {"status": "error", "error": "empty request body"})
        data = self.rfile.read(length)
        with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tmp:
            tmp.write(data)
            path = tmp.name
        try:
            result = subprocess.run(
                ["python", os.path.join(BASE, "grib2_analyze.py"), path],
                capture_output=True,
                text=True,
                timeout=180,
                check=True,
            )
            return self._send(200, json.loads(result.stdout))
        except subprocess.CalledProcessError as exc:
            return self._send(422, {"status": "error", "error": exc.stderr[-4000:] or "analysis failed"})
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    def log_message(self, fmt, *args):
        print(fmt % args)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
