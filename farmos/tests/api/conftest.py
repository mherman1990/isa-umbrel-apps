"""API tests against a real PostgreSQL+PostGIS (CI service container).

Set FARMOS_TEST_DATABASE_URL to run; otherwise these skip. The job queue
is stubbed out (deferred jobs are collected, not executed) so tests drive
the pipeline synchronously.
"""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "backend"))

TEST_DB = os.environ.get("FARMOS_TEST_DATABASE_URL")

pytestmark = pytest.mark.db


def pytest_collection_modifyitems(config, items):
    if TEST_DB:
        return
    skip = pytest.mark.skip(reason="FARMOS_TEST_DATABASE_URL not set")
    for item in items:
        item.add_marker(skip)


if TEST_DB:
    os.environ["FARMOS_DATABASE_URL"] = TEST_DB


@pytest.fixture(scope="session")
def data_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp("farmos-data")
    os.environ["FARMOS_DATA_DIR"] = str(d)
    return d


@pytest.fixture(scope="session")
def app_and_engine(data_dir):
    from app.config import settings

    settings.data_dir = data_dir
    settings.database_url = TEST_DB

    import app.db as db_mod
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(TEST_DB)
    db_mod.engine = engine
    db_mod.SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)

    with engine.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        conn.commit()

    from app.models import Base

    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)

    from app.main import create_app

    return create_app(), engine


@pytest.fixture()
def client(app_and_engine, monkeypatch):
    from fastapi.testclient import TestClient

    app, _ = app_and_engine

    deferred: list[tuple[str, dict]] = []

    class FakeDeferrable:
        def __init__(self, name):
            self.name = name

        def defer(self, **kwargs):
            deferred.append((self.name, kwargs))

    import app.api.v1.captures as captures_mod

    def fake_enqueue(capture):
        deferred.append(("transcribe_capture" if capture.kind == "voice" else "route_capture",
                         {"capture_id": str(capture.id)}))

    monkeypatch.setattr(captures_mod, "_enqueue", fake_enqueue)

    c = TestClient(app)
    c.deferred_jobs = deferred
    return c


@pytest.fixture()
def owner_token(client):
    r = client.post("/api/v1/auth/bootstrap", json={"display_name": "Matt"})
    if r.status_code == 409:  # already bootstrapped by an earlier test — pair instead
        pytest.skip("bootstrap already consumed; owner_token fixture is session-order sensitive")
    return r.json()["token"]


@pytest.fixture(scope="session")
def session_owner(app_and_engine):
    """Session-wide owner + token, created directly against the DB."""
    _, engine = app_and_engine
    from sqlalchemy.orm import Session

    from app import auth
    from app.models import AppUser

    with Session(engine, expire_on_commit=False) as s:
        user = AppUser(id=uuid.uuid4(), display_name="Session Owner", role="owner")
        s.add(user)
        s.flush()
        token = auth.mint_token(s, user, "test-device")
        s.commit()
    return {"user_id": str(user.id), "token": token}


@pytest.fixture()
def auth_headers(session_owner):
    return {"Authorization": f"Bearer {session_owner['token']}"}
