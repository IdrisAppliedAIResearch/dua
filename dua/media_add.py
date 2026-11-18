"""Put picture files into a running Dua, through its API.

    python -m dua.media_add [--url http://127.0.0.1:8644] FILE [FILE ...]

Nothing here opens the database: the app is the only writer wherever it runs, so
a picture travels as base64 over HTTP and lands in the same SQLite file as the
words. The stored name is the file's own name; a second add of the same name
replaces the bytes.

Afterwards, name the picture in an entry as a paragraph of its own:

    media/01-IMG_1578.jpg
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


def post(url: str, payload: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        url.rstrip("/") + "/api/media",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, {"detail": exc.read().decode("utf-8", "replace")[:400]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m dua.media_add")
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument(
        "--url",
        default=os.environ.get("DUA_URL", "http://127.0.0.1:8644"),
        help="the app to add to (default: $DUA_URL or this)",
    )
    args = parser.parse_args(argv)

    failed = 0
    for path in args.files:
        if not path.is_file():
            print(f"{path.name}: no such file")
            failed += 1
            continue
        status, meta = post(
            args.url,
            {"name": path.name, "data_b64": base64.b64encode(path.read_bytes()).decode()},
        )
        if status >= 400:
            print(f"{path.name}: HTTP {status} {meta.get('detail', '')}")
            failed += 1
            continue
        verb = "replaced" if status == 200 else "added"
        print(f"{verb}: media/{meta['name']}  {meta['bytes']} bytes  {meta['mime']}  {meta['sha256'][:16]}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
