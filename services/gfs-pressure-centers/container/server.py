import json, os, subprocess, tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b=json.dumps(obj,ensure_ascii=False).encode()
        self.send_response(code); self.send_header('content-type','application/json'); self.send_header('content-length',str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path=='/health': self._send(200,{'status':'ok','service':'gfs-pressure-centers'}); return
        self._send(404,{'error':'not_found'})
    def do_POST(self):
        if self.path!='/analyze': self._send(404,{'error':'not_found'}); return
        n=int(self.headers.get('content-length','0'))
        data=self.rfile.read(n)
        with tempfile.NamedTemporaryFile(suffix='.grib2',delete=False) as f:
            f.write(data); name=f.name
        try:
            r=subprocess.run(['python','/app/grib2_analyze.py',name],capture_output=True,text=True,timeout=90)
            if r.returncode: self._send(422,{'status':'error','stderr':r.stderr[-4000:]}); return
            self._send(200,json.loads(r.stdout))
        finally:
            try: os.unlink(name)
            except OSError: pass

HTTPServer(('0.0.0.0',8080),H).serve_forever()