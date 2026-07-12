"""OpenTimestamps anchoring: batch stamping with mocked calendars, proof
standard-format round-trip, upgrade to attested, and graceful behavior
when no calendar is reachable."""
from __future__ import annotations

import binascii
import uuid
from datetime import datetime, timezone

import pytest

pytestmark = pytest.mark.db


def _make_captures(app_and_engine, n=3):
    from sqlalchemy.orm import Session

    from app.models import AppUser, CaptureEvent

    _, engine = app_and_engine
    ids = []
    with Session(engine, expire_on_commit=False) as s:
        user = s.query(AppUser).first()
        if user is None:
            user = AppUser(id=uuid.uuid4(), display_name="TS Test", role="owner")
            s.add(user)
            s.flush()
        for i in range(n):
            c = CaptureEvent(
                client_id=uuid.uuid4(),
                user_id=user.id,
                kind="voice",
                artifact_path=f"artifacts/test/ts-{uuid.uuid4()}.webm",
                artifact_sha256=binascii.hexlify(bytes([i]) * 32).decode(),
                mime_type="audio/webm",
                captured_at=datetime.now(timezone.utc),
                status="confirmed",
            )
            s.add(c)
            s.flush()
            ids.append(c.id)
        s.commit()
    return ids


def test_stamp_batch_and_proof_roundtrip(app_and_engine, monkeypatch):
    from sqlalchemy.orm import Session

    from app.models import CaptureEvent
    from app.services import timestamping

    ids = _make_captures(app_and_engine)

    # mock calendar: attests the submitted digest with a pending attestation
    def fake_submit(digest):
        from opentimestamps.core.notary import PendingAttestation
        from opentimestamps.core.timestamp import Timestamp

        t = Timestamp(digest)
        t.attestations.add(PendingAttestation("https://fake.calendar.test"))
        return [t]

    monkeypatch.setattr(timestamping, "_submit_to_calendars", fake_submit)

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        result = timestamping.stamp_pending_captures(s)
        s.commit()
    assert result["stamped"] >= 3

    with Session(engine) as s:
        for cid in ids:
            c = s.get(CaptureEvent, cid)
            assert c.timestamp_proof is not None
            assert c.timestamp_proof["status"] == "pending"
            # proof is STANDARD ots format: deserializes with the stock lib
            # and commits to the artifact digest
            detached = timestamping._deserialize(c.timestamp_proof["ots_b64"])
            assert detached.file_digest == binascii.unhexlify(c.artifact_sha256)
            atts = [a for _, a in detached.timestamp.all_attestations()]
            assert atts, "proof must carry the calendar attestation"


def test_stamp_skips_cleanly_when_no_calendar(app_and_engine, monkeypatch):
    from sqlalchemy.orm import Session

    from app.models import CaptureEvent
    from app.services import timestamping

    ids = _make_captures(app_and_engine, n=1)
    monkeypatch.setattr(timestamping, "_submit_to_calendars", lambda digest: [])

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        result = timestamping.stamp_pending_captures(s)
        s.commit()
    assert result["stamped"] == 0
    assert "retry" in result["error"]
    with Session(engine) as s:
        c = s.get(CaptureEvent, ids[0])
        assert c.timestamp_proof is None  # untouched — next night retries


def test_upgrade_to_attested(app_and_engine, monkeypatch):
    from sqlalchemy.orm import Session

    from app.models import CaptureEvent
    from app.services import timestamping

    ids = _make_captures(app_and_engine, n=1)

    def fake_submit(digest):
        from opentimestamps.core.notary import PendingAttestation
        from opentimestamps.core.timestamp import Timestamp

        t = Timestamp(digest)
        t.attestations.add(PendingAttestation("https://fake.calendar.test"))
        return [t]

    monkeypatch.setattr(timestamping, "_submit_to_calendars", fake_submit)
    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        timestamping.stamp_pending_captures(s)
        s.commit()

    # mock the calendar upgrade: returns a Bitcoin block attestation
    class FakeCalendar:
        def __init__(self, url):
            pass

        def get_timestamp(self, msg):
            from opentimestamps.core.notary import BitcoinBlockHeaderAttestation
            from opentimestamps.core.timestamp import Timestamp

            t = Timestamp(msg)
            t.attestations.add(BitcoinBlockHeaderAttestation(905000))
            return t

    import opentimestamps.calendar as cal_mod

    monkeypatch.setattr(cal_mod, "RemoteCalendar", FakeCalendar)

    with Session(engine, expire_on_commit=False) as s:
        result = timestamping.upgrade_pending_proofs(s)
        s.commit()
    assert result["attested"] >= 1

    with Session(engine) as s:
        c = s.get(CaptureEvent, ids[0])
        assert c.timestamp_proof["status"] == "attested"
        detached = timestamping._deserialize(c.timestamp_proof["ots_b64"])
        from opentimestamps.core.notary import BitcoinBlockHeaderAttestation

        assert any(
            isinstance(a, BitcoinBlockHeaderAttestation) for _, a in detached.timestamp.all_attestations()
        )


def test_proof_download_endpoint(client, auth_headers, app_and_engine, monkeypatch):
    from sqlalchemy.orm import Session

    from app.models import CaptureEvent
    from app.services import timestamping

    ids = _make_captures(app_and_engine, n=1)

    def fake_submit(digest):
        from opentimestamps.core.notary import PendingAttestation
        from opentimestamps.core.timestamp import Timestamp

        t = Timestamp(digest)
        t.attestations.add(PendingAttestation("https://fake.calendar.test"))
        return [t]

    monkeypatch.setattr(timestamping, "_submit_to_calendars", fake_submit)
    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        timestamping.stamp_pending_captures(s)
        s.commit()

    r = client.get(f"/api/v1/captures/{ids[0]}/proof", headers=auth_headers)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.opentimestamps")
    assert len(r.content) > 50  # a real serialized proof, not a stub
