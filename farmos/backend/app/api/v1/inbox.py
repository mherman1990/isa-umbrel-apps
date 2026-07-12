"""Confirmation inbox — where trust is built.

Anything parsed shows up here with the original artifact one tap away,
pre-filled fields, honest confidence, and the model's own questions when
it wasn't sure. Confirm / Fix / Discard. The system never invents data
silently; unresolved ambiguities block confirmation server-side.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import auth
from ...db import get_session
from ...models import AppUser, CaptureEvent, ConfirmationQueueItem, ParseResult
from ...services import records as records_svc

router = APIRouter(prefix="/inbox", tags=["inbox"])


def _item_view(item: ConfirmationQueueItem, session: Session) -> dict:
    parse = session.get(ParseResult, item.parse_result_id)
    capture = session.get(CaptureEvent, parse.capture_event_id)
    return {
        "id": str(item.id),
        "state": item.state,
        "target_type": parse.target_type,
        "extracted": parse.extracted,
        "confidence": float(parse.confidence),
        "ambiguities": parse.ambiguities,
        "capture": {
            "id": str(capture.id),
            "kind": capture.kind,
            "captured_at": capture.captured_at.isoformat(),
            "transcript": capture.transcript,
        },
        "created_record_type": item.created_record_type,
        "created_record_id": str(item.created_record_id) if item.created_record_id else None,
    }


@router.get("")
def list_inbox(
    state: str = "pending",
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    rows = session.scalars(
        select(ConfirmationQueueItem)
        .where(ConfirmationQueueItem.state == state)
        .order_by(ConfirmationQueueItem.created_at)
        .limit(200)
    ).all()
    return [_item_view(r, session) for r in rows]


class ConfirmIn(BaseModel):
    final_payload: dict | None = None


@router.post("/{item_id}/confirm")
def confirm(
    item_id: uuid.UUID,
    body: ConfirmIn,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    item = session.get(ConfirmationQueueItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="unknown inbox item")
    records_svc.confirm_item(session, item, body.final_payload, user.id)
    return _item_view(item, session)


@router.post("/{item_id}/reject")
def reject(item_id: uuid.UUID, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    item = session.get(ConfirmationQueueItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="unknown inbox item")
    records_svc.reject_item(session, item, user.id)
    return _item_view(item, session)
