#!/usr/bin/env python3
"""Local receiver for extractListing() results (see tools/enrich/README.md).

  python3 receiver.py OUT.json [--port 8765]

Listens on 127.0.0.1 only. The listing tab in Chrome navigates to
  http://127.0.0.1:8765/save?id=<listing id>&d=<base64url(JSON of extractListing(window))>
and the result is stored in OUT.json as {"items": [{"id", "data"}, ...]} (one entry per id, last wins),
ready for `firestore_enrich.py write OUT.json`. GET /stop ends the receiver.
This way the data goes from the page to the Mac without being copied by hand.
"""
import base64
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

OUT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "enrich-results.json"
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8765
LOCK = threading.Lock()


def load():
    if os.path.exists(OUT):
        with open(OUT) as f:
            return json.load(f)
    return {"items": []}


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, text):
        body = f"<!doctype html><meta charset=utf-8><title>LWR</title><main><pre>{text}</pre></main>".encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/stop":
            self.reply(200, "LWR-STOPPED")
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if u.path != "/save":
            self.reply(404, "LWR-UNKNOWN")
            return
        q = parse_qs(u.query)
        try:
            lid = q["id"][0]
            raw = q["d"][0]
            data = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8"))
        except Exception as e:  # noqa: BLE001 – report anything malformed to the tab
            self.reply(400, f"LWR-ERROR {e}")
            return
        with LOCK:
            doc = load()
            doc["items"] = [it for it in doc["items"] if it["id"] != lid] + [{"id": lid, "data": data}]
            with open(OUT, "w") as f:
                json.dump(doc, f, ensure_ascii=False, indent=1)
        self.reply(200, f"LWR-OK {lid} photos={len(data.get('photos') or [])} baths={data.get('baths')} letAgreed={data.get('letAgreed')}")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
