"""Capture state machine.

recorded ─▶ transcribing ─▶ transcribed ─▶ parsing ─▶ parsed ─▶ queued ─▶ confirmed/rejected
   │  (voice only; photo/file skip to parsing via route)         each parse_result gets a
   └────────────────────────▶ failed (status_detail says why)    confirmation_queue_item

Phase 1 rule: NOTHING writes a farm record without human confirmation.
Confidence and ambiguities only shape how the inbox renders an item.
A spend-cap hit parks the capture (status_detail='spend_cap') — the raw
capture is safe and parsing resumes when budget returns.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import llm
from ..models import AuditLog, CaptureEvent, ConfirmationQueueItem, FarmProfile, ParseResult
from . import parse as parse_mod
from . import transcribe as transcribe_mod


def _set_status(session: Session, capture: CaptureEvent, status: str, detail: str | None = None) -> None:
    capture.status = status
    capture.status_detail = detail
    session.add(AuditLog(action=f"capture.{status}", entity_type="capture_event", entity_id=capture.id,
                         detail={"status_detail": detail} if detail else {}))


def spend_cap(session: Session) -> float:
    profile = session.scalars(select(FarmProfile)).first()
    return float(profile.monthly_spend_cap_usd) if profile else 20.0


def run_transcription(session: Session, capture_id: uuid.UUID, data_dir) -> None:
    capture = session.get(CaptureEvent, capture_id)
    if capture is None or capture.status not in ("recorded", "failed"):
        return
    _set_status(session, capture, "transcribing")
    session.commit()
    try:
        capture.transcript = transcribe_mod.transcribe(data_dir / capture.artifact_path)
        _set_status(session, capture, "transcribed")
    except Exception as exc:  # noqa: BLE001 — surface, never swallow silently
        _set_status(session, capture, "failed", f"transcription: {exc}")
    session.commit()


def run_parse(session: Session, capture_id: uuid.UUID) -> list[ParseResult]:
    capture = session.get(CaptureEvent, capture_id)
    if capture is None or capture.status not in ("transcribed", "parsing"):
        return []
    _set_status(session, capture, "parsing")
    session.commit()
    try:
        results = parse_mod.parse_transcript(session, capture, cap_usd=spend_cap(session))
    except llm.SpendCapExceeded:
        _set_status(session, capture, "transcribed", "spend_cap")
        session.commit()
        return []
    except Exception as exc:  # noqa: BLE001
        _set_status(session, capture, "failed", f"parse: {exc}")
        session.commit()
        return []

    _set_status(session, capture, "parsed")
    session.flush()
    for r in results:
        session.add(ConfirmationQueueItem(parse_result_id=r.id))
    _set_status(session, capture, "queued" if results else "confirmed",
                None if results else "nothing actionable in capture")
    session.commit()
    return results


def maybe_finalize_capture(session: Session, capture: CaptureEvent) -> None:
    """Flip a capture to confirmed/rejected once every queue item is resolved."""
    rows = session.scalars(
        select(ConfirmationQueueItem)
        .join(ParseResult, ConfirmationQueueItem.parse_result_id == ParseResult.id)
        .where(ParseResult.capture_event_id == capture.id)
    ).all()
    if rows and all(r.state != "pending" for r in rows):
        confirmed_any = any(r.state in ("confirmed", "edited") for r in rows)
        _set_status(session, capture, "confirmed" if confirmed_any else "rejected")
