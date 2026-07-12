"""Daily brief: composed from real state, inputs stored beside output,
idempotent per day, honest when nothing exists yet."""
from __future__ import annotations

from datetime import date

import pytest

pytestmark = pytest.mark.db


def test_brief_generation_and_idempotency(client, auth_headers, app_and_engine):
    from sqlalchemy.orm import Session

    from app import llm
    from app.services import brief

    _, engine = app_and_engine
    llm.set_transport(lambda **kw: ("## Today\n- Check the inbox.", 800, 120))
    try:
        with Session(engine, expire_on_commit=False) as s:
            row = brief.generate(s, today=date(2026, 7, 12))
            s.commit()
            first_id = row.id
            assert row.body_md.startswith("## Today")
            assert "inbox_pending" in row.inputs  # traceable inputs stored
        with Session(engine, expire_on_commit=False) as s:
            again = brief.generate(s, today=date(2026, 7, 12))
            assert again.id == first_id  # one brief per day
    finally:
        llm.set_transport(None)

    r = client.get("/api/v1/brief/latest", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is True
    assert body["brief_date"] == "2026-07-12"
