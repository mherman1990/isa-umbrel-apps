"""Workbook import: upload → model-proposed mapping → farmer confirms →
import. Mappings persist by content hash, so next month's copy of the same
book re-imports in one tap."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import auth, llm
from ...capture.pipeline import spend_cap
from ...config import settings
from ...db import get_session
from ...models import AppUser, AuditLog, WorkbookMapping
from ...services import workbook_import

router = APIRouter(prefix="/workbooks", tags=["workbooks"])

MAX_WORKBOOK_BYTES = 20 * 1024 * 1024


def _view(w: WorkbookMapping) -> dict:
    return {
        "id": str(w.id),
        "filename": w.filename,
        "content_sha256": w.content_sha256,
        "proposal": w.proposal,
        "mapping": w.mapping,
        "confirmed": w.confirmed_at is not None,
        "imported_at": w.imported_at.isoformat() if w.imported_at else None,
        "import_result": w.import_result,
    }


@router.post("", status_code=201)
async def upload_workbook(
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    content = await file.read()
    if not content:
        raise HTTPException(status_code=422, detail="empty upload")
    if len(content) > MAX_WORKBOOK_BYTES:
        raise HTTPException(status_code=413, detail="workbook too large")
    if not (file.filename or "").lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=422, detail="expected an .xlsx workbook")

    sha = workbook_import.sha256_bytes(content)
    existing = session.scalar(select(WorkbookMapping).where(WorkbookMapping.content_sha256 == sha))
    if existing is not None:
        return _view(existing)  # same bytes → same mapping; re-import is one tap

    rel = f"workbooks/{sha[:16]}-{file.filename}"
    path = settings.data_dir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)

    row = WorkbookMapping(filename=file.filename, content_sha256=sha, file_path=rel)
    session.add(row)
    session.flush()

    # If a confirmed mapping exists for an earlier version of this book
    # (same filename, different bytes), offer it as the proposal first —
    # cheaper and usually right.
    prior = session.scalars(
        select(WorkbookMapping)
        .where(WorkbookMapping.filename == row.filename, WorkbookMapping.mapping.isnot(None),
               WorkbookMapping.id != row.id)
        .order_by(WorkbookMapping.created_at.desc())
    ).first()
    if prior is not None:
        row.proposal = prior.mapping
    else:
        try:
            row.proposal = workbook_import.propose_mapping(session, content, cap_usd=spend_cap(session))
        except llm.SpendCapExceeded:
            raise HTTPException(status_code=402, detail="monthly AI spend cap reached — raise it in Settings or map manually")
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"could not read workbook: {exc}") from exc

    session.add(AuditLog(user_id=user.id, action="workbook.upload", entity_type="workbook_mapping", entity_id=row.id))
    return _view(row)


class ConfirmIn(BaseModel):
    mapping: dict  # the (possibly farmer-edited) mapping to run


@router.post("/{workbook_id}/confirm")
def confirm_and_import(
    workbook_id: uuid.UUID,
    body: ConfirmIn,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    row = session.get(WorkbookMapping, workbook_id)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown workbook")
    if not isinstance(body.mapping.get("tabs"), list):
        raise HTTPException(status_code=422, detail="mapping must contain a tabs list")
    row.mapping = body.mapping
    row.confirmed_at = datetime.now(timezone.utc)
    content = (settings.data_dir / row.file_path).read_bytes()
    result = workbook_import.run_import(session, row, content)
    session.add(AuditLog(user_id=user.id, action="workbook.import", entity_type="workbook_mapping",
                         entity_id=row.id, detail=result["created"]))
    return _view(row)


@router.get("")
def list_workbooks(session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    rows = session.scalars(select(WorkbookMapping).order_by(WorkbookMapping.created_at.desc()).limit(50)).all()
    return [_view(w) for w in rows]


@router.get("/{workbook_id}")
def get_workbook(workbook_id: uuid.UUID, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    row = session.get(WorkbookMapping, workbook_id)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown workbook")
    return _view(row)
