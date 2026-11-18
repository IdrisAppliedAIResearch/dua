"""The media/ line convention: a body paragraph naming a file, served beside the book.

A picture in a body is a whole paragraph of exactly ``media/<file>.jpg`` — the
API contract is still plain text, so these tests pin the two things that make
the convention safe: the stored words come back untouched, and the /media mount
serves only files that sit inside the media directory.
"""

import pathlib
import tempfile

import pytest
from fastapi.testclient import TestClient

from dua.app import create_app

# A one-pixel PNG, for a real content-type and real bytes.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d4944415478da63f8cfc0000003010100"
    "18dd8db00000000049454e44ae426082"
)


@pytest.fixture()
def media(tmp_path):
    """App whose media directory is tmp_path/media, with one staged picture."""
    (tmp_path / "media").mkdir()
    (tmp_path / "media" / "01-first.jpg").write_bytes(PNG)
    (tmp_path / "outside.txt").write_text("not for the book", encoding="utf-8")
    app = create_app(db_path=tmp_path / "dua.db")
    with TestClient(app) as c:
        yield c


def test_media_file_is_served_with_its_bytes(media):
    r = media.get("/media/01-first.jpg")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content == PNG


def test_missing_media_is_a_plain_404_not_the_app(media):
    """A missing picture must not fall through to the web mount."""
    r = media.get("/media/nope.jpg")
    assert r.status_code == 404
    assert "html" not in r.headers["content-type"]


def test_media_cannot_escape_its_directory(media):
    for target in (
        "/media/../outside.txt",
        "/media/..%2Foutside.txt",
        "/media/%2e%2e%2Foutside.txt",
        "/media//outside.txt",
    ):
        r = media.get(target)
        assert r.status_code != 200, target
        assert b"not for the book" not in r.content, target


def test_env_can_point_media_elsewhere(tmp_path, monkeypatch):
    other = tmp_path / "elsewhere"
    other.mkdir()
    (other / "pic.png").write_bytes(PNG)
    monkeypatch.setenv("DUA_MEDIA", str(other))
    app = create_app(db_path=tmp_path / "sub" / "dua.db")
    with TestClient(app) as c:
        assert c.get("/media/pic.png").content == PNG
    monkeypatch.delenv("DUA_MEDIA")


def test_media_lines_round_trip_through_the_api_verbatim(media):
    body = (
        "O Allah, forgive me.\n\n"
        "media/01-first.jpg\n\n"
        "And have mercy on us, Lord of the worlds."
    )
    created = media.post("/api/entries", json={"date": None, "body": body}).json()
    assert created["body"] == body
    rows = media.get("/api/entries").json()
    assert len(rows) == 1
    assert rows[0]["body"] == body
    # The marker is a paragraph on its own, so splicing one in never touches
    # the words around it.
    sections = rows[0]["body"].split("\n\n")
    assert sections[1] == "media/01-first.jpg"

    edited = media.put(
        f"/api/entries/{created['id']}",
        json={"body": body + "\n\nmedia/01-first.jpg"},
    ).json()
    assert edited["body"] == body + "\n\nmedia/01-first.jpg"


def test_media_marker_is_not_special_to_the_store(media):
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
    created = media.post("/api/entries", json={"date": None, "body": body}).json()
    assert created["body"] == body


def test_media_directory_is_created_beside_the_book(tmp_path):
    nested = tmp_path / "deep" / "nest" / "dua.db"
    app = create_app(db_path=nested)
    with TestClient(app) as c:
        assert c.get("/media/anything.jpg").status_code == 404
    assert (tmp_path / "deep" / "nest" / "media").is_dir()
