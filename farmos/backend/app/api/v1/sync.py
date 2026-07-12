"""Offline sync protocol.

The PWA queues captures/operations/confirmations in IndexedDB while the
truck has no bars, then drains them here. Per-item idempotency via
client-generated UUIDs: replaying the whole queue after a dropped
connection is always safe. The client removes an item from its queue only
on "created" or "duplicate".
"""
from __future__ import annotations

import base64
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ... import auth, llm
from ...db import get_session
from ...models import AppUser, CaptureEvent, ConfirmationQueueItem, FarmProfile
from ...services import backup as backup_svc
from .captures import create_capture

router = APIRouter(prefix="/sync", tags=["sync"])

MAX_INLINE_BYTES = 5 * 1024 * 1024


class SyncItem(BaseModel):
    client_id: uuid.UUID
    type: str  # 'capture' | 'operation' | 'confirmation'
    payload: dict


class SyncBatchIn(BaseModel):
    items: list[SyncItem]


@router.post("/batch")
def sync_batch(body: SyncBatchIn, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    results = []
    for item in body.items:
        try:
            results.append(_apply(session, user, item))
        except Exception as exc:  # noqa: BLE001 — one bad item must not sink the batch
            session.rollback()
            results.append({"client_id": str(item.client_id), "result": "error", "error": str(exc)[:500]})
    return {"results": results}


def _apply(session: Session, user: AppUser, item: SyncItem) -> dict:
    base = {"client_id": str(item.client_id)}
    if item.type == "capture":
        raw = base64.b64decode(item.payload["data_base64"])
        if len(raw) > MAX_INLINE_BYTES:
            return {**base, "result": "error", "error": "inline artifact >5MB — use POST /captures"}
        capture, created = create_capture(
            session,
            user=user,
            client_id=item.client_id,
            kind=item.payload.get("kind", "voice"),
            content=raw,
            mime_type=item.payload.get("mime_type", "application/octet-stream"),
            captured_at=datetime.fromisoformat(item.payload["captured_at"]),
            gps_lat=item.payload.get("gps_lat"),
            gps_lon=item.payload.get("gps_lon"),
            provenance=item.payload.get("provenance", "captured"),
        )
        session.commit()
        return {**base, "result": "created" if created else "duplicate", "server_id": str(capture.id)}

    if item.type == "operation":
        from ...models import FieldOperation
        from .records import OperationIn, create_operation

        existing = session.scalar(select(FieldOperation).where(FieldOperation.client_id == item.client_id))
        if existing is not None:
            return {**base, "result": "duplicate", "server_id": str(existing.id)}
        view = create_operation(OperationIn(client_id=item.client_id, **item.payload), session, user)
        session.commit()
        return {**base, "result": "created", "server_id": view["id"]}

    if item.type == "confirmation":
        from ...services import records as records_svc

        qi = session.get(ConfirmationQueueItem, uuid.UUID(item.payload["queue_item_id"]))
        if qi is None:
            return {**base, "result": "error", "error": "unknown queue item"}
        if qi.state != "pending":
            return {**base, "result": "duplicate", "server_id": str(qi.id)}
        if item.payload.get("action") == "reject":
            records_svc.reject_item(session, qi, user.id)
        else:
            records_svc.confirm_item(session, qi, item.payload.get("final_payload"), user.id)
        session.commit()
        return {**base, "result": "created", "server_id": str(qi.id)}

    return {**base, "result": "error", "error": f"unknown item type {item.type}"}


@router.get("/status")
def sync_status(session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    """App-shell badges: one cheap call after reconnect."""
    pending_captures = session.scalar(
        select(func.count()).select_from(CaptureEvent).where(
            CaptureEvent.status.in_(("recorded", "transcribing", "transcribed", "parsing"))
        )
    )
    inbox_count = session.scalar(
        select(func.count()).select_from(ConfirmationQueueItem).where(ConfirmationQueueItem.state == "pending")
    )
    profile = session.scalars(select(FarmProfile)).first()
    b = backup_svc.status()
    return {
        "pending_captures": pending_captures,
        "inbox_count": inbox_count,
        "backup_age_hours": b["age_hours"],
        "backup_configured": b["configured"],
        "spend_month_usd": round(llm.month_spend_usd(session), 4),
        "spend_cap_usd": float(profile.monthly_spend_cap_usd) if profile else None,
    }
