"""Database engine/session plus the Procrastinate job-queue app.

One Postgres serves both the ORM and the job queue (Procrastinate is
Postgres-backed) — no Redis, one fewer always-on service on the Pi.
"""
from __future__ import annotations

import procrastinate
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .config import settings

engine = create_engine(settings.database_url, pool_size=5, max_overflow=5, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_session():
    """FastAPI dependency."""
    with SessionLocal() as session:
        yield session
        session.commit()


def _psycopg_dsn() -> str:
    # Procrastinate wants a plain psycopg DSN, not the SQLAlchemy URL.
    return settings.database_url.replace("postgresql+psycopg://", "postgresql://")


job_app = procrastinate.App(
    connector=procrastinate.SyncPsycopgConnector(conninfo=_psycopg_dsn()),
    import_paths=["app.jobs.tasks", "app.jobs.periodic"],
)


def session() -> Session:
    """Plain session for job/task code (not request-scoped)."""
    return SessionLocal()
