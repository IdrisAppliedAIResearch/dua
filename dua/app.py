"""FastAPI application factory: REST API plus the static book client."""

from __future__ import annotations

import base64
import binascii
import logging
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .store import EntryStore, NotFound, ValidationError

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

logger = logging.getLogger("dua")


class EntryPayload(BaseModel):
    date: str | None = None
    title: str = ""
    name: str | None = None  # short index label; None preserves the stored one
    body: str


class MediaPayload(BaseModel):
    name: str
    data_b64: str


def create_app(db_path: str | Path | None = None) -> FastAPI:
    root = Path(__file__).resolve().parent.parent
    store = EntryStore(db_path or os.environ.get("DUA_DB") or root / "data" / "dua.db")
    app = FastAPI(title="Dua", docs_url=None, redoc_url=None)

    def guard(fn, *args, **kwargs) -> Any:
        try:
            return fn(*args, **kwargs)
        except NotFound:
            raise HTTPException(status_code=404, detail="not found")
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc))

    @app.middleware("http")
    async def cache_policy(request: Request, call_next) -> Response:
        """The book client is a handful of stamped files behind one index.html.

        A cached shell pins last week's JavaScript, which then renders a
        picture line as a sentence. So the shell is never stored at all, the
        stamped code is revalidated on every load, and the API is never cached
        at all. A picture is the one thing worth holding on to: it revalidates
        by sha256 and answers 304 instead of arriving a hundred kilobytes again.
        """
        response = await call_next(request)
        path = request.url.path
        if path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        elif path == "/" or path.endswith(".html"):
            # no-store, not merely no-cache. A shell saved while this app sent no
            # freshness headers at all lives entirely on browser heuristics:
            # Safari guessed hours of freshness for a six-day-old index.html and
            # asked the server for nothing at all in that window, so no header
            # added afterwards could ever reach it. The shell is 2 KB; it is
            # never worth the risk of serving a stale book.
            response.headers["Cache-Control"] = "no-store"
        elif path.startswith("/js/") or path.startswith("/css/"):
            # Revalidate rather than trust heuristics: bumping the ?v= stamp is
            # the intent, but a deploy that forgets one must still land.
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/api/entries")
    def list_entries() -> Any:
        return store.list()

    @app.post("/api/entries", status_code=201)
    def create_entry(payload: EntryPayload) -> Any:
        return guard(
            store.create,
            date=payload.date,
            title=payload.title,
            name=payload.name or "",
            body=payload.body,
        )

    @app.get("/api/entries/{entry_id}")
    def get_entry(entry_id: int) -> Any:
        return guard(store.get, entry_id)

    @app.put("/api/entries/{entry_id}")
    def update_entry(entry_id: int, payload: EntryPayload) -> Any:
        return guard(
            store.update,
            entry_id,
            date=payload.date,
            title=payload.title,
            name=payload.name,
            body=payload.body,
        )

    @app.delete("/api/entries/{entry_id}", status_code=204)
    def delete_entry(entry_id: int) -> None:
        guard(store.delete, entry_id)

    @app.get("/api/export")
    def export() -> JSONResponse:
        data = store.export()
        return JSONResponse(
            data,
            headers={"Content-Disposition": 'attachment; filename="dua.json"'},
        )

    @app.exception_handler(Exception)
    def fail(request: Request, exc: Exception) -> JSONResponse:
        # The client only ever sees "server error"; the traceback goes to the
        # server log so a failure in production can actually be diagnosed there.
        logger.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse({"detail": "server error"}, status_code=500)

    # Pictures are bytes in this database, named by a body line. A name is a
    # table key and never a path, so there is no directory to traverse: an
    # unknown name is a 404, which the client renders as the plain-text line it
    # came from. Registered before "/" so the book client cannot swallow it.

    @app.get("/api/media")
    def list_media() -> Any:
        return store.list_media()

    @app.post("/api/media", status_code=201)
    def put_media(payload: MediaPayload) -> Any:
        try:
            data = base64.b64decode(payload.data_b64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=422, detail="data_b64 is not base64")
        existed = store.has_media(payload.name.strip())
        meta = guard(store.put_media, name=payload.name, data=data)
        return JSONResponse(meta, status_code=200 if existed else 201)

    @app.get("/api/media/{name}")
    def media_meta(name: str) -> Any:
        return guard(store.media_meta, name)

    @app.delete("/api/media/{name}", status_code=204)
    def delete_media(name: str) -> None:
        guard(store.delete_media, name)

    @app.get("/media/{name}")
    def media_file(name: str, request: Request) -> Any:
        row = guard(store.get_media, name)
        etag = '"%s"' % row["sha256"]
        headers = {"ETag": etag, "Cache-Control": "no-cache"}
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=headers)
        return Response(content=row["bytes"], media_type=row["mime"], headers=headers)

    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app
