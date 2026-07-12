"""Computed nudges: deadline window, failed captures, backup staleness."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

pytestmark = pytest.mark.db


def test_deadline_and_state_nudges(client, auth_headers, app_and_engine):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import AppUser, CaptureEvent, Program, RegionPackRow

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        pack = s.scalar(select(RegionPackRow))
        if pack is None:
            pack = RegionPackRow(region_code="US-TEST", version="1", source_path="t", content_sha256="0" * 64)
            s.add(pack)
            s.flush()
        s.add(Program(
            region_pack_id=pack.id, program_key="nudge-test-program", name="Nudge Test Cost Share",
            agency="TEST", tier="state", summary="test", source_url="https://example.test",
            last_verified=date.today(), verify_by=date.today() + timedelta(days=365),
            signup_deadline="soon", signup_deadline_date=date.today() + timedelta(days=10),
        ))
        user = s.query(AppUser).first()
        s.add(CaptureEvent(
            client_id=uuid.uuid4(), user_id=user.id, kind="voice",
            artifact_path="artifacts/x.webm", artifact_sha256="ab" * 32, mime_type="audio/webm",
            captured_at=datetime.now(timezone.utc), status="failed", status_detail="transcription: boom",
        ))
        s.commit()

    body = client.get("/api/v1/nudges", headers=auth_headers).json()
    types = {n["type"] for n in body["nudges"]}

    deadline = next(n for n in body["nudges"] if n["type"] == "deadline" and n["program_key"] == "nudge-test-program")
    assert deadline["days_left"] == 10
    assert deadline["severity"] == "high"  # inside 14 days

    assert "capture_failed" in types  # failed captures are never silent
    assert "backup" in types  # test env has no backup configured
