"""FastAPI application factory: REST API plus the static book client."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
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

    # Embedded pictures: a body line naming media/<file> is served from a
    # directory beside the database, never from the code tree. Registered
    # before "/" so the static book client cannot swallow the path; a missing
    # file is a 404 the client renders as the plain-text line it came from.
    media_dir = Path(os.environ.get("DUA_MEDIA") or (Path(store.path).parent / "media"))
    media_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/media", StaticFiles(directory=media_dir), name="media")

    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app
