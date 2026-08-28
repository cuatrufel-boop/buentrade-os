#!/usr/bin/env python3
"""Local dev server that tells the browser to never cache — every request always gets the
current file on disk, no matter how recently it was requested before. Plain python3 -m
http.server sends no Cache-Control header at all, so browsers fall back to heuristic caching
(roughly 10% of the file's age since last edit) and can silently keep serving a stale copy
for hours even on a manual reload — exactly the confusion that cost real time this session."""

import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8837


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    http.server.test(HandlerClass=NoCacheHandler, port=PORT)
