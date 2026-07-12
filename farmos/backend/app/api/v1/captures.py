"""Capture ingest. Fast path: write artifact, hash, insert, enqueue.

Never blocks on transcription or the LLM; never loses an input (the raw
artifact is retained even when parsing fails)."""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import auth
from ...config import settings
from ...db import get_session
from ...models import AppUser, CaptureEvent, ConfirmationQueueItem, ParseResult

router = APIRouter(tags=["captures"])

MAX_ARTIFACT_BYTES = 100 * 1024 * 1024

EXT_BY_MIME = {
    "audio/webm": "webm", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav",
    "audio/ogg": "ogg", "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic",
    "application/pdf": "pdf",
}


def store_artifact(content: bytes, mime_type: str, capture_id: uuid.UUID, captured_at: datetime) -> tuple[str, str]:
    ext = EXT_BY_MIME.get(mime_type, "bin")
    rel = f"artifacts/{captured_at:%Y/%m}/{capture_id}.{ext}"
    path = settings.data_dir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return rel, hashlib.sha256(content).hexdigest()


def create_capture(
    session: Session,
    *,
    user: AppUser,
    client_id: uuid.UUID,
    kind: str,
    content: bytes,
    mime_type: str,
    captured_at: datetime,
    gps_lat: float | None = None,
    gps_lon: float | None = None,
    provenance: str = "captured",
) -> tuple[CaptureEvent, bool]:
    """Returns (capture, created). Idempotent on client_id."""
    existing = session.scalar(select(CaptureEvent).where(CaptureEvent.client_id == client_id))
    if existing is not None:
        return existing, False
    capture_id = uuid.uuid4()
    rel, sha = store_artifact(content, mime_type, capture_id, captured_at)
    capture = CaptureEvent(
        id=capture_id,
        client_id=client_id,
        user_id=user.id,
        kind=kind,
        artifact_path=rel,
        artifact_sha256=sha,
        mime_type=mime_type,
        captured_at=captured_at,
        provenance=provenance,
        device_gps=f"SRID=4326;POINT({gps_lon} {gps_lat})" if gps_lat is not None and gps_lon is not None else None,
    )
    session.add(capture)
    session.flush()
    _enqueue(capture)
    return capture, True


def _enqueue(capture: CaptureEvent) -> None:
    from ...jobs.tasks import route_capture, transcribe_capture

    try:
        if capture.kind == "voice":
            transcribe_capture.defer(capture_id=str(capture.id))
        else:
            route_capture.defer(capture_id=str(capture.id))
    except Exception:  # noqa: BLE001 — queue down must never lose the capture
        capture.status_detail = "enqueue failed; retry job pending"


@router.post("/captures", status_code=201)
async def upload_capture(
    file: UploadFile = File(...),
    client_id: uuid.UUID = Form(...),
    kind: str = Form(...),
    captured_at: datetime = Form(...),
    gps_lat: float | None = Form(default=None),
    gps_lon: float | None = Form(default=None),
    provenance: str = Form(default="captured"),
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    if kind not in ("voice", "photo", "file"):
        raise HTTPException(status_code=422, detail="kind must be voice|photo|file")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=422, detail="empty upload")
    if len(content) > MAX_ARTIFACT_BYTES:
        raise HTTPException(status_code=413, detail="artifact too large")
    capture, created = create_capture(
        session,
        user=user,
        client_id=client_id,
        kind=kind,
        content=content,
        mime_type=file.content_type or "application/octet-stream",
        captured_at=captured_at,
        gps_lat=gps_lat,
        gps_lon=gps_lon,
        provenance=provenance if provenance in ("captured", "imported") else "captured",
    )
    return _capture_view(capture, session)


def _capture_view(c: CaptureEvent, session: Session) -> dict:
    results = session.scalars(
        select(ParseResult).where(ParseResult.capture_event_id == c.id).order_by(ParseResult.seq)
    ).all()
    return {
        "id": str(c.id),
        "client_id": str(c.client_id),
        "kind": c.kind,
        "status": c.status,
        "status_detail": c.status_detail,
        "captured_at": c.captured_at.isoformat(),
        "transcript": c.transcript,
        "provenance": c.provenance,
        "tamper_evident": c.timestamp_proof is not None,
        "parse_results": [
            {"seq": r.seq, "target_type": r.target_type, "confidence": float(r.confidence),
             "extracted": r.extracted, "ambiguities": r.ambiguities}
            for r in results
        ],
    }


@router.get("/captures")
def list_captures(
    status: str | None = None,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    q = select(CaptureEvent).order_by(CaptureEvent.uploaded_at.desc()).limit(100)
    if status:
        q = q.where(CaptureEvent.status == status)
    return [_capture_view(c, session) for c in session.scalars(q)]


@router.get("/captures/{capture_id}")
def get_capture(capture_id: uuid.UUID, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    c = session.get(CaptureEvent, capture_id)
    if c is None:
        raise HTTPException(status_code=404, detail="unknown capture")
    return _capture_view(c, session)


@router.get("/captures/{capture_id}/artifact")
def get_artifact(capture_id: uuid.UUID, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    c = session.get(CaptureEvent, capture_id)
    if c is None:
        raise HTTPException(status_code=404, detail="unknown capture")
    return FileResponse(settings.data_dir / c.artifact_path, media_type=c.mime_type)
