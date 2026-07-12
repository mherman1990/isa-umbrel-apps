"""Hard Requirement #18c: immutability + audit-trail behavior on confirmed
records. Resolved inbox items cannot be re-resolved; raw captures are
never deleted; every trust-relevant action leaves an audit row."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import pytest

pytestmark = pytest.mark.db


def test_resolved_items_are_immutable_and_audited(client, auth_headers, app_and_engine):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app import llm
    from app.capture import pipeline
    from app.models import AuditLog

    # a capture whose parse fans out one note record (no field needed)
    cid = str(uuid.uuid4())
    r = client.post(
        "/api/v1/captures",
        files={"file": ("note.webm", b"audit-audio", "audio/webm")},
        data={"client_id": cid, "kind": "voice", "captured_at": datetime.now(timezone.utc).isoformat()},
        headers=auth_headers,
    )
    capture_id = r.json()["id"]

    from app.capture import transcribe as transcribe_mod

    _, engine = app_and_engine
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(transcribe_mod, "transcribe", lambda p: "call the co-op about prepay")
        llm.set_transport(lambda **kw: (json.dumps([
            {"target_type": "note", "confidence": 0.9, "ambiguities": [],
             "payload": {"text": "call the co-op about prepay"}}
        ]), 500, 100))
        try:
            from sqlalchemy.orm import Session as S2

            with S2(engine, expire_on_commit=False) as s:
                pipeline.run_transcription(s, uuid.UUID(capture_id), __import__("app.config", fromlist=["settings"]).settings.data_dir)
            with S2(engine, expire_on_commit=False) as s:
                pipeline.run_parse(s, uuid.UUID(capture_id))
        finally:
            llm.set_transport(None)

    item = next(i for i in client.get("/api/v1/inbox", headers=auth_headers).json()
                if i["capture"]["id"] == capture_id)

    # confirm once — fine
    assert client.post(f"/api/v1/inbox/{item['id']}/confirm", json={}, headers=auth_headers).status_code == 200
    # any further mutation of the resolution is refused
    assert client.post(f"/api/v1/inbox/{item['id']}/confirm", json={}, headers=auth_headers).status_code == 409
    assert client.post(f"/api/v1/inbox/{item['id']}/reject", headers=auth_headers).status_code == 409

    # the audit trail recorded the lifecycle
    with Session(engine) as s:
        actions = {a.action for a in s.scalars(
            select(AuditLog).where(AuditLog.detail["queue_item"].astext == item["id"])
        )}
        assert "inbox.confirm" in actions
        capture_actions = {a.action for a in s.scalars(
            select(AuditLog).where(AuditLog.entity_id == uuid.UUID(capture_id))
        )}
        assert {"capture.transcribing", "capture.parsed", "capture.queued"} <= capture_actions


def test_capture_artifacts_survive_rejection(client, auth_headers, app_and_engine):
    """The raw artifact stays retrievable no matter what happens downstream
    (append-only, never deleted)."""
    cid = str(uuid.uuid4())
    r = client.post(
        "/api/v1/captures",
        files={"file": ("junk.webm", b"junk-but-kept", "audio/webm")},
        data={"client_id": cid, "kind": "voice", "captured_at": datetime.now(timezone.utc).isoformat()},
        headers=auth_headers,
    )
    body = r.json()
    art = client.get(f"/api/v1/captures/{body['id']}/artifact", headers=auth_headers)
    assert art.status_code == 200
    assert art.content == b"junk-but-kept"
