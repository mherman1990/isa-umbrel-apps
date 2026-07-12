"""FastAPI app factory.

API-first is structural (Hard Requirement #14): everything lives under
/api/v1 and the PWA is just static files mounted at / — a native client
uses the identical endpoints.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api.v1 import router as v1_router
from .config import settings

FRONTEND_DIST = Path(__file__).resolve().parent.parent / "static"


def create_app() -> FastAPI:
    app = FastAPI(title="Farm OS", version="0.1.0", docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.include_router(v1_router)

    @app.get("/healthz")
    def healthz():
        from sqlalchemy import text as sql_text

        from .db import engine

        try:
            with engine.connect() as conn:
                conn.execute(sql_text("SELECT 1"))
            db_ok = True
        except Exception:  # noqa: BLE001
            db_ok = False
        return {"ok": db_ok, "db": db_ok}

    if FRONTEND_DIST.exists():
        app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            candidate = FRONTEND_DIST / path
            if path and candidate.is_file() and candidate.resolve().is_relative_to(FRONTEND_DIST.resolve()):
                return FileResponse(candidate)
            return FileResponse(FRONTEND_DIST / "index.html")

    return app


app = create_app()
