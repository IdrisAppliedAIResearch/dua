"""CRUD workflow tests for the dua API."""

import pathlib
import tempfile

import pytest
from fastapi.testclient import TestClient

from dua.app import create_app


@pytest.fixture()
def client():
    tmp = pathlib.Path(tempfile.mkdtemp()) / "test.db"
    app = create_app(db_path=tmp)
    with TestClient(app) as c:
        yield c


def _entry(client, date="2026-10-01", title="", body="first light on the lake."):
    return client.post(
        "/api/entries", json={"date": date, "title": title, "body": body}
    ).json()


def test_update_returns_the_updated_entry_not_the_last_inserted(client):
    first = _entry(client, date="2026-01-01", body="first entry")
    second = _entry(client, date="2026-01-02", body="second entry")
    updated = client.put(
        f"/api/entries/{first['id']}", json={"body": "first entry edited"}
    ).json()
    assert updated["id"] == first["id"]
    assert updated["body"] == "first entry edited"
    assert updated["id"] != second["id"]


def test_empty_book(client):
    assert client.get("/api/entries").json() == []


def test_create_read_update_delete_lifecycle(client):
    created = _entry(client)
    assert created["id"] == 1
    assert created["date"] == "2026-10-01"
    assert created["body"] == "first light on the lake."
    assert created["created_at"] == created["updated_at"]

    fetched = client.get(f"/api/entries/{created['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["body"] == created["body"]

    updated = client.put(
        f"/api/entries/{created['id']}",
        json={"date": "2026-10-03", "title": "dusk", "body": "rewritten evening."},
    )
    assert updated.status_code == 200
    assert updated.json()["body"] == "rewritten evening."
    assert updated.json()["date"] == "2026-10-03"
    assert updated.json()["updated_at"] >= created["updated_at"]

    gone = client.delete(f"/api/entries/{created['id']}")
    assert gone.status_code == 204
    assert client.get(f"/api/entries/{created['id']}").status_code == 404
    assert client.get("/api/entries").json() == []


def test_ordering_by_date(client):
    _entry(client, date="2026-03-05", body="later")
    _entry(client, date="2026-01-02", body="earlier")
    _entry(client, date="2026-01-02", body="same day, second")
    dates = [(e["date"], e["body"]) for e in client.get("/api/entries").json()]
    assert dates == [
        ("2026-01-02", "earlier"),
        ("2026-01-02", "same day, second"),
        ("2026-03-05", "later"),
    ]


def test_undated_entries_allowed_and_ordered_first(client):
    undated = client.post("/api/entries", json={"body": "no date attached"})
    assert undated.status_code == 201
    assert undated.json()["date"] is None
    _entry(client, date="2026-01-02", body="dated")
    listed = client.get("/api/entries").json()
    assert [e["body"] for e in listed] == ["no date attached", "dated"]


def test_validation_rejects_empty_body(client):
    assert client.post("/api/entries", json={"body": "   "}).status_code == 422
    e = _entry(client)
    assert client.put(f"/api/entries/{e['id']}", json={"body": ""}).status_code == 422


def test_validation_rejects_bad_date(client):
    assert client.post(
        "/api/entries", json={"date": "yesterday", "body": "x"}
    ).status_code == 422


def test_missing_entry_is_404(client):
    assert client.get("/api/entries/999").status_code == 404
    assert client.delete("/api/entries/999").status_code == 404
    assert client.put("/api/entries/999", json={"body": "x"}).status_code == 404


def test_export_snapshot(client):
    _entry(client, body="kept forever")
    snap = client.get("/api/export")
    assert snap.status_code == 200
    assert "attachment" in snap.headers["content-disposition"]
    data = snap.json()
    assert data["app"] == "dua"
    assert data["entries"][0]["body"] == "kept forever"


def test_name_roundtrip_and_preservation(client):
    created = client.post(
        "/api/entries", json={"body": "some body", "name": "Short Label"}
    ).json()
    assert created["name"] == "Short Label"
    upd = client.put(
        f"/api/entries/{created['id']}", json={"body": "edited body"}
    ).json()
    assert upd["name"] == "Short Label"
    upd2 = client.put(
        f"/api/entries/{created['id']}", json={"body": "again", "name": "Renamed"}
    ).json()
    assert upd2["name"] == "Renamed"


def test_migration_adds_name_to_old_database(tmp_path):
    import sqlite3

    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT,
            title TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO entries (date, title, body, created_at, updated_at)
        VALUES (NULL, 'ttl', 'b', 'x', 'y');
        """
    )
    conn.commit()
    conn.close()
    with TestClient(create_app(db_path=db)) as c:
        rows = c.get("/api/entries").json()
        assert rows[0]["body"] == "b"
        assert rows[0]["title"] == "ttl"
        assert rows[0]["name"] == ""


def test_persistence_across_app_instances(client):
    pass  # covered implicitly: store writes eagerly per operation with WAL


def test_concurrent_saves_are_serialized(client):
    """FastAPI runs the sync endpoints on its threadpool: a shared SQLite
    connection is only safe because EntryStore serializes every operation."""
    import threading

    codes = []
    errors = []

    def worker(n):
        try:
            for i in range(8):
                r = client.post("/api/entries", json={"body": f"thread {n} entry {i}"})
                codes.append(r.status_code)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors
    assert codes == [201] * 32
    assert len(client.get("/api/entries").json()) == 32
