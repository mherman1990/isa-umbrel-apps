"""Tamper-evident records via OpenTimestamps (spec §2 — core, not optional).

Nightly, every capture without a proof gets its artifact hash committed
into one Merkle tree whose root goes to public OTS calendar servers —
effectively free, no wallet, no node of the farmer's own, and only a HASH
leaves the box (listed in the privacy disclosure). Proofs use the standard
OTS format so any third party can verify with the stock `ots` client; we
deliberately build no proprietary verifier.

Calendars attest asynchronously (a Bitcoin block every few hours), so a
proof is 'pending' first and a later job upgrades it to 'attested'. If the
network is down, tonight's batch simply runs tomorrow — capture never
depends on this.

UI language: "tamper-evident record", never "Bitcoin" (spec: invisible
plumbing).
"""
from __future__ import annotations

import base64
import binascii
import os
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AuditLog, CaptureEvent

CALENDARS = [
    "https://a.pool.opentimestamps.org",
    "https://b.pool.opentimestamps.org",
    "https://a.pool.eternitywall.com",
]

# proofs younger than this aren't worth polling for an upgrade yet
MIN_UPGRADE_AGE_HOURS = 4


def _detached_for(capture: CaptureEvent):
    from opentimestamps.core.timestamp import DetachedTimestampFile, OpSHA256, Timestamp

    digest = binascii.unhexlify(capture.artifact_sha256)
    return DetachedTimestampFile(OpSHA256(), Timestamp(digest))


def _serialize(detached) -> str:
    from opentimestamps.core.serialize import BytesSerializationContext

    ctx = BytesSerializationContext()
    detached.serialize(ctx)
    return base64.b64encode(ctx.getbytes()).decode()


def _deserialize(b64: str):
    from opentimestamps.core.serialize import BytesDeserializationContext
    from opentimestamps.core.timestamp import DetachedTimestampFile

    return DetachedTimestampFile.deserialize(BytesDeserializationContext(base64.b64decode(b64)))


def _walk(timestamp):
    """Yield a timestamp and all its descendants (lib 0.4.5 has no .walk)."""
    yield timestamp
    for child in timestamp.ops.values():
        yield from _walk(child)


def _submit_to_calendars(digest: bytes) -> list:
    """Submit a merkle root to the public calendars; ≥1 success required."""
    from opentimestamps.calendar import RemoteCalendar

    results = []
    for url in CALENDARS:
        try:
            results.append(RemoteCalendar(url).submit(digest))
        except Exception:  # noqa: BLE001 — a down calendar is routine
            continue
    return results


def stamp_pending_captures(session: Session, batch_limit: int = 500) -> dict:
    """One Merkle tree per nightly run; per-capture detached proofs stored
    on `timestamp_proof` as standard OTS bytes (base64)."""
    from opentimestamps.core.timestamp import OpAppend, OpSHA256, make_merkle_tree

    captures = session.scalars(
        select(CaptureEvent)
        .where(CaptureEvent.timestamp_proof.is_(None))
        .order_by(CaptureEvent.uploaded_at)
        .limit(batch_limit)
    ).all()
    if not captures:
        return {"stamped": 0}

    detached = [_detached_for(c) for c in captures]
    # nonce each leaf so the calendar learns nothing about our digests
    leaves = [d.timestamp.ops.add(OpAppend(os.urandom(16))).ops.add(OpSHA256()) for d in detached]
    tip = make_merkle_tree(leaves)

    calendar_stamps = _submit_to_calendars(tip.msg)
    if not calendar_stamps:
        return {"stamped": 0, "error": "no calendar reachable; will retry next run"}
    for stamp in calendar_stamps:
        tip.merge(stamp)

    now = datetime.now(timezone.utc).isoformat()
    for capture, d in zip(captures, detached):
        capture.timestamp_proof = {"ots_b64": _serialize(d), "status": "pending", "stamped_at": now}
    session.add(AuditLog(action="timestamp.stamp", detail={"count": len(captures)}))
    return {"stamped": len(captures)}


def upgrade_pending_proofs(session: Session, batch_limit: int = 200) -> dict:
    """Poll calendars for Bitcoin attestations on pending proofs."""
    from opentimestamps.calendar import CommitmentNotFoundError, RemoteCalendar
    from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation

    rows = session.scalars(
        select(CaptureEvent)
        .where(CaptureEvent.timestamp_proof.isnot(None))
        .order_by(CaptureEvent.uploaded_at)
        .limit(batch_limit * 4)
    ).all()
    pending = [c for c in rows if (c.timestamp_proof or {}).get("status") == "pending"][:batch_limit]

    upgraded = 0
    for capture in pending:
        try:
            detached = _deserialize(capture.timestamp_proof["ots_b64"])
        except Exception:  # noqa: BLE001 — a corrupt proof is loud, not fatal
            capture.timestamp_proof = {**capture.timestamp_proof, "status": "invalid"}
            continue

        changed = False
        for msg, attestation in list(detached.timestamp.all_attestations()):
            if not isinstance(attestation, PendingAttestation):
                continue
            try:
                upgrade = RemoteCalendar(attestation.uri).get_timestamp(msg)
            except CommitmentNotFoundError:
                continue
            except Exception:  # noqa: BLE001
                continue
            for target in _walk(detached.timestamp):
                if target.msg == msg:
                    target.merge(upgrade)
                    changed = True

        attested = any(
            isinstance(a, BitcoinBlockHeaderAttestation) for _, a in detached.timestamp.all_attestations()
        )
        if changed or attested:
            capture.timestamp_proof = {
                **capture.timestamp_proof,
                "ots_b64": _serialize(detached),
                "status": "attested" if attested else "pending",
                **({"attested_at": datetime.now(timezone.utc).isoformat()} if attested else {}),
            }
            if attested:
                upgraded += 1
    if upgraded:
        session.add(AuditLog(action="timestamp.attested", detail={"count": upgraded}))
    return {"checked": len(pending), "attested": upgraded}


def proof_bytes(capture: CaptureEvent) -> bytes | None:
    """The standard .ots file a verifier downloads."""
    proof = capture.timestamp_proof or {}
    if not proof.get("ots_b64"):
        return None
    return base64.b64decode(proof["ots_b64"])
