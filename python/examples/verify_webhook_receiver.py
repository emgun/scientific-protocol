from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from os import environ

from scientific_protocol_client import verify_webhook_signature


SIGNING_SECRET = environ["SP_WEBHOOK_SIGNING_SECRET"]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        content_length = int(self.headers.get("content-length", "0"))
        payload_body = self.rfile.read(content_length).decode("utf-8")
        signature = self.headers.get("x-sp-webhook-signature", "")
        timestamp = self.headers.get("x-sp-webhook-timestamp", "")

        verified = verify_webhook_signature(
            payload_body=payload_body,
            secret=SIGNING_SECRET,
            signature=signature,
            timestamp=timestamp,
        )
        if not verified:
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b'{"ok":false,"error":"invalid_signature"}')
            return

        event = json.loads(payload_body)
        print(json.dumps(event, indent=2, sort_keys=True))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", 8787), Handler)
    print("listening on http://127.0.0.1:8787")
    server.serve_forever()
