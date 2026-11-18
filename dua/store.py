"""SQLite persistence for Dua. One file, two tables: the words as text, the
pictures as bytes.

INVARIANT: bodies are the author's words, verbatim. Never rewrite them —
no correction, reformatting, or "improvement" at any layer.
"""

from __future__ import annotations

import hashlib
import sqlite3
import threading
from datetime import date as _date
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    title TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_order ON entries ((date IS NOT NULL), date, id);
CREATE TABLE IF NOT EXISTS media (
    name TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    bytes BLOB NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """Allow NULL dates; a pre-existing NOT NULL date column is rebuilt.
    Adds the `name` column (short index label) to older databases."""
    info = conn.execute("PRAGMA table_info(entries)").fetchall()
    if not info:
        return
    if "name" not in [c[1] for c in info]:
        conn.execute("ALTER TABLE entries ADD COLUMN name TEXT NOT NULL DEFAULT ''")
        info = conn.execute("PRAGMA table_info(entries)").fetchall()
    date_col = next((c for c in info if c[1] == "date"), None)
    if date_col is None or not date_col[3]:
        return
    copy = conn.execute(
        "SELECT id, date, title, body, created_at, updated_at, name FROM entries"
    ).fetchall()
    conn.execute("DROP TABLE IF EXISTS entries_old")
    conn.execute("ALTER TABLE entries RENAME TO entries_old")
    conn.execute(SCHEMA.split(";")[0])
    conn.executemany(
        "INSERT INTO entries (id, date, title, body, created_at, updated_at, name)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        [(r[0], r[1] or None, r[2], r[3], r[4], r[5], r[6]) for r in copy],
    )
    conn.execute("DROP TABLE entries_old")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_entries_order ON entries ((date IS NOT NULL), date, id)"
    )

EXPORT_VERSION = 1


class StoreError(Exception):
    pass


class ValidationError(StoreError):
    pass


class NotFound(StoreError):
    pass


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _check_date(value: str) -> str:
    try:
        parsed = _date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValidationError(f"date must be YYYY-MM-DD, got {value!r}")
    return parsed.isoformat()


# A body names a picture as `media/<name>`; the bytes live in this database, so
# the name is a table key and never a path. Only types a browser can decode are
# accepted, and the extension decides the content type the route will answer
# with - nothing here ever guesses a type from the bytes.
MEDIA_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
}
MAX_MEDIA_BYTES = 20 * 1024 * 1024


def _check_media(name: str, data: bytes) -> str:
    """Return the content type for this name, or refuse the picture."""
    if not isinstance(name, str) or not name.strip():
        raise ValidationError("name must not be empty")
    name = name.strip()
    if len(name) > 200:
        raise ValidationError("name is too long")
    if "/" in name or "\\" in name or ".." in name or name.startswith("."):
        raise ValidationError(f"name must be a single file name, got {name!r}")
    mime = MEDIA_TYPES.get(Path(name).suffix.lower())
    if mime is None:
        raise ValidationError(
            "unsupported picture type %r, expected one of %s"
            % (Path(name).suffix, ", ".join(sorted(MEDIA_TYPES)))
        )
    if not isinstance(data, (bytes, bytearray)):
        raise ValidationError("picture data must be bytes")
    if not data:
        raise ValidationError("picture data is empty")
    if len(data) > MAX_MEDIA_BYTES:
        raise ValidationError(
            f"picture is {len(data)} bytes, over the {MAX_MEDIA_BYTES} byte limit"
        )
    return mime


class EntryStore:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=2000")
        self._conn.executescript(SCHEMA)
        _migrate(self._conn)
        self._conn.commit()
        # FastAPI runs the sync endpoints on its threadpool, so every call on
        # this shared connection must be serialized: an interleaved execute/
        # commit between threads used to be able to raise mid-transaction.
        self._lock = threading.RLock()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        return dict(row)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            cur = self._conn.execute(
                "SELECT * FROM entries ORDER BY (date IS NOT NULL), date, id"
            )
            return [self._row_to_dict(r) for r in cur.fetchall()]

    def get(self, entry_id: int) -> dict[str, Any]:
        with self._lock:
            cur = self._conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,))
            row = cur.fetchone()
            if row is None:
                raise NotFound(f"entry {entry_id}")
            return self._row_to_dict(row)

    def create(
        self, *, date: str | None, title: str, body: str, name: str = ""
    ) -> dict[str, Any]:
        day = _check_date(date) if date else None
        body = (body or "").strip("\ufeff")
        if not body.strip():
            raise ValidationError("body must not be empty")
        now = _utcnow()
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO entries (date, title, name, body, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (day, (title or "").strip(), (name or "").strip(), body, now, now),
            )
            self._conn.commit()
            return self.get(cur.lastrowid)

    def update(
        self,
        entry_id: int,
        *,
        date: str | None,
        title: str,
        body: str,
        name: str | None = None,
    ) -> dict[str, Any]:
        body = (body or "").strip("\ufeff")
        if body is None or not body.strip():
            raise ValidationError("body must not be empty")
        with self._lock:
            existing = self.get(entry_id)
            day = _check_date(date) if date else existing["date"]
            name = (name or "").strip() if name is not None else existing["name"]
            cur = self._conn.execute(
                "UPDATE entries SET date=?, title=?, name=?, body=?, updated_at=? WHERE id=?",
                (day, (title or "").strip(), name, body, _utcnow(), entry_id),
            )
            self._conn.commit()
            if cur.rowcount == 0:
                raise NotFound(f"entry {entry_id}")
            # NOT cur.lastrowid: after an UPDATE that value still points at the
            # most recent INSERT, which used to make saves return the wrong entry.
            return self.get(entry_id)

    def delete(self, entry_id: int) -> None:
        with self._lock:
            cur = self._conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
            self._conn.commit()
            if cur.rowcount == 0:
                raise NotFound(f"entry {entry_id}")

    def export(self) -> dict[str, Any]:
        return {"app": "dua", "version": EXPORT_VERSION, "entries": self.list()}

    # Pictures: bytes in this file, named by a body line. Removing the line from
    # an entry never touches the stored picture, and deleting a picture never
    # touches any body - the two are only ever joined at render time.

    def list_media(self) -> list[dict[str, Any]]:
        with self._lock:
            cur = self._conn.execute(
                "SELECT name, mime, length(bytes) AS bytes, sha256,"
                " created_at, updated_at FROM media ORDER BY name"
            )
            return [dict(r) for r in cur.fetchall()]

    def has_media(self, name: str) -> bool:
        with self._lock:
            return (
                self._conn.execute("SELECT 1 FROM media WHERE name = ?", (name,)).fetchone()
                is not None
            )

    def get_media(self, name: str) -> dict[str, Any]:
        with self._lock:
            row = self._conn.execute("SELECT * FROM media WHERE name = ?", (name,)).fetchone()
            if row is None:
                raise NotFound(f"picture {name}")
            return dict(row)

    def put_media(self, *, name: str, data: bytes) -> dict[str, Any]:
        name = (name or "").strip()
        mime = _check_media(name, data)
        digest = hashlib.sha256(bytes(data)).hexdigest()
        now = _utcnow()
        with self._lock:
            self._conn.execute(
                "INSERT INTO media (name, mime, bytes, sha256, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(name) DO UPDATE SET mime=excluded.mime,"
                " bytes=excluded.bytes, sha256=excluded.sha256, updated_at=excluded.updated_at",
                (name, mime, sqlite3.Binary(data), digest, now, now),
            )
            self._conn.commit()
            return self.media_meta(name)

    def media_meta(self, name: str) -> dict[str, Any]:
        """One row without its bytes: what the API answers with."""
        with self._lock:
            row = self._conn.execute(
                "SELECT name, mime, length(bytes) AS bytes, sha256,"
                " created_at, updated_at FROM media WHERE name = ?",
                (name,),
            ).fetchone()
            if row is None:
                raise NotFound(f"picture {name}")
            return dict(row)

    def delete_media(self, name: str) -> None:
        with self._lock:
            cur = self._conn.execute("DELETE FROM media WHERE name = ?", (name,))
            self._conn.commit()
            if cur.rowcount == 0:
                raise NotFound(f"picture {name}")
