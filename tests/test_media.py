"""Pictures as bytes in the database, named by a body line.

A picture in a body is a whole paragraph of exactly ``media/<name>``; the bytes
themselves live in the ``media`` table beside the entries, so the .db file is
the whole book and nothing has to be copied alongside it. These tests pin what
makes that safe: the API contract for a body is still plain text, a name is a
table key and never a path, and the shell that loads the layout is always
revalidated so it cannot pin last week's JavaScript.
"""

import base64
import sqlite3

import pytest
from fastapi.testclient import TestClient

from dua.app import create_app

# A one-pixel PNG. Named .jpg on purpose: the content type comes from the name,
# and that is the rule worth pinning.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d4944415478da63f8cfc0000003010100"
    "18dd8db00000000049454e44ae426082"
)


@pytest.fixture()
def book(tmp_path):
    """A fresh app with one picture already added through its own API."""
    app = create_app(db_path=tmp_path / "dua.db")
    with TestClient(app) as c:
        r = c.post("/api/media", json={"name": "01-first.jpg", "data_b64": _b64(PNG)})
        assert r.status_code == 201, r.text
        yield c


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def test_a_picture_is_stored_in_the_database_next_to_the_words(book, tmp_path):
    """No folder beside the database, no file to lose on the way to the server."""
    assert not (tmp_path / "media").exists()
    row = sqlite3.connect(str(tmp_path / "dua.db")).execute(
        "SELECT name, mime, length(bytes), sha256 FROM media"
    ).fetchone()
    assert row[0] == "01-first.jpg"
    assert row[1] == "image/jpeg"
    assert row[2] == len(PNG)
    assert len(row[3]) == 64

    r = book.get("/media/01-first.jpg")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content == PNG
    assert r.headers["etag"].strip('"') == row[3]


def test_missing_picture_is_a_plain_404_not_the_app(book):
    """The client needs a 404 it can turn back into the line it came from."""
    r = book.get("/media/nope.jpg")
    assert r.status_code == 404
    assert "html" not in r.headers["content-type"]


def test_a_picture_name_is_a_key_and_never_a_path(book, tmp_path):
    (tmp_path / "outside.txt").write_text("not for the book", encoding="utf-8")
    for target in (
        "/media/../outside.txt",
        "/media/..%2Foutside.txt",
        "/media/%2e%2e%2Foutside.txt",
        "/media//outside.txt",
        "/media/dua.db",
    ):
        r = book.get(target)
        assert r.status_code != 200, target
        assert b"not for the book" not in r.content, target

    for bad in ("../outside.jpg", "sub/inner.jpg", "..", "no-extension", "notes.txt"):
        r = book.post("/api/media", json={"name": bad, "data_b64": _b64(PNG)})
        assert r.status_code == 422, bad


def test_only_types_a_browser_can_decode_are_accepted(book):
    for bad in ("notes.txt", "movie.mp4", "script.exe", ""):
        r = book.post("/api/media", json={"name": bad, "data_b64": _b64(PNG)})
        assert r.status_code == 422, bad
    assert book.post("/api/media", json={"name": "x.png", "data_b64": "###"}).status_code == 422
    assert book.post("/api/media", json={"name": "y.png", "data_b64": ""}).status_code == 422
    assert [m["name"] for m in book.get("/api/media").json()] == ["01-first.jpg"]


def test_adding_the_same_name_again_replaces_the_bytes(book):
    second = PNG + b"second version"
    r = book.post("/api/media", json={"name": "01-first.jpg", "data_b64": _b64(second)})
    assert r.status_code == 200  # 201 the first time, 200 once it already existed
    assert r.json()["bytes"] == len(second)
    assert book.get("/media/01-first.jpg").content == second
    assert len(book.get("/api/media").json()) == 1


def test_a_picture_can_go_away_without_touching_a_single_word(book):
    body = "O Allah, forgive me.\n\nmedia/01-first.jpg"
    entry = book.post("/api/entries", json={"date": None, "body": body}).json()

    assert book.delete("/api/media/01-first.jpg").status_code == 204
    assert book.get("/media/01-first.jpg").status_code == 404
    assert book.get("/api/media/01-first.jpg").status_code == 404
    assert book.get(f"/api/entries/{entry['id']}").json()["body"] == body


def test_the_book_lists_its_pictures_without_their_bytes(book):
    rows = book.get("/api/media").json()
    assert rows == [
        {
            "name": "01-first.jpg",
            "mime": "image/jpeg",
            "bytes": len(PNG),
            "sha256": rows[0]["sha256"],
            "created_at": rows[0]["created_at"],
            "updated_at": rows[0]["updated_at"],
        }
    ]


def test_an_unchanged_picture_comes_back_as_304(book):
    first = book.get("/media/01-first.jpg")
    again = book.get("/media/01-first.jpg", headers={"If-None-Match": first.headers["etag"]})
    assert again.status_code == 304
    assert not again.content


def test_the_shell_is_never_stored_so_a_stale_layout_engine_cannot_survive(book):
    """A cached index.html is a stale layout engine: it renders a picture line
    as a sentence, and a shell cached with no freshness headers at all can sit in
    Safari for hours without ever asking the server again. The API must not be
    cached at all; the stamped code must always be revalidated."""
    assert book.get("/").headers["cache-control"] == "no-store"
    assert book.get("/index.html").headers["cache-control"] == "no-store"
    assert book.get("/api/entries").headers["cache-control"] == "no-store"
    assert book.get("/api/media").headers["cache-control"] == "no-store"
    assert book.get("/js/layout.js").headers["cache-control"] == "no-cache"
    # A picture is worth caching: bytes are revalidated by sha256, not refetched.
    assert book.get("/media/01-first.jpg").headers["cache-control"] == "no-cache"


def test_picture_bytes_never_enter_a_body_or_an_export(book):
    body = "Say: O Allah, Lord of the Prophet Muhammad.\n\nmedia/01-first.jpg"
    book.post("/api/entries", json={"date": None, "body": body})
    export = book.get("/api/export").json()
    assert export["entries"][0]["body"] == body
    assert "media" not in export
    assert PNG.hex() not in book.get("/api/export").text


def test_picture_lines_round_trip_through_the_api_verbatim(book):
    body = (
        "O Allah, forgive me.\n\n"
        "media/01-first.jpg\n\n"
        "And have mercy on us, Lord of the worlds."
    )
    created = book.post("/api/entries", json={"date": None, "body": body}).json()
    assert created["body"] == body
    rows = book.get("/api/entries").json()
    assert len(rows) == 1
    assert rows[0]["body"] == body
    # The marker is a paragraph on its own, so splicing one in never touches
    # the words around it.
    sections = rows[0]["body"].split("\n\n")
    assert sections[1] == "media/01-first.jpg"

    edited = book.put(
        f"/api/entries/{created['id']}",
        json={"body": body + "\n\nmedia/01-first.jpg"},
    ).json()
    assert edited["body"] == body + "\n\nmedia/01-first.jpg"


def test_a_marker_line_is_not_special_to_the_store(book):
    """The server never invents, rewrites or strips a media line: it is text.

    Anything that only *looks* like a marker (trailing words, a nested path,
    another extension) is stored exactly as typed and rendered as a line.
    """
    body = (
        "media/not-a-picture.txt\n\n"
        "media/01-first.jpg extra words\n\n"
        "media/../outside.txt\n\n"
        "Media/01-first.jpg\n\n"
        "media\\01-first.jpg"
    )
    created = book.post("/api/entries", json={"date": None, "body": body}).json()
    assert created["body"] == body
