"""Document vault — every routed paper record, searchable and linked back
to its raw capture. Full-text/semantic search arrives with pgvector
embeddings later in Phase 2; this is the list/detail surface."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import auth
from ...config import settings
from ...db import get_session
from ...models import AppUser, Document

router = APIRouter(prefix="/documents", tags=["documents"])


def _view(d: Document) -> dict:
    return {
        "id": str(d.id),
        "doc_type": d.doc_type,
        "title": d.title,
        "extracted": d.extracted,
        "capture_event_id": str(d.capture_event_id) if d.capture_event_id else None,
        "related_field_id": str(d.related_field_id) if d.related_field_id else None,
        "created_at": d.created_at.isoformat(),
    }


@router.get("")
def list_documents(
    doc_type: str | None = None,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    q = select(Document).order_by(Document.created_at.desc()).limit(200)
    if doc_type:
        q = q.where(Document.doc_type == doc_type)
    return [_view(d) for d in session.scalars(q)]


@router.get("/{document_id}")
def get_document(document_id: uuid.UUID, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    d = session.get(Document, document_id)
    if d is None:
        raise HTTPException(status_code=404, detail="unknown document")
    return _view(d)


@router.get("/{document_id}/file")
def get_file(document_id: uuid.UUID, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    d = session.get(Document, document_id)
    if d is None:
        raise HTTPException(status_code=404, detail="unknown document")
    return FileResponse(settings.data_dir / d.file_path)
