"""Conservation engine: practice inventory (with evidence), program
enrollments, and the stacking checker."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field as PField
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import auth
from ...db import get_session
from ...models import (
    AppUser,
    AuditLog,
    CaptureEvent,
    Document,
    Field,
    FieldOperation,
    Practice,
    PracticeEvidence,
    ProgramEnrollment,
)
from ...services import stacking

router = APIRouter(tags=["conservation"])


# ------------------------------------------------------------------ practices


class PracticeIn(BaseModel):
    field_id: uuid.UUID
    crop_year: int
    practice_type: str
    acres: float | None = None
    attributes: dict = {}


def _practice_view(p: Practice, session: Session) -> dict:
    evidence = session.scalars(
        select(PracticeEvidence).where(PracticeEvidence.practice_id == p.id)
    ).all()
    ev_views = []
    for e in evidence:
        tamper_evident = False
        if e.capture_event_id:
            cap = session.get(CaptureEvent, e.capture_event_id)
            tamper_evident = bool(cap and cap.timestamp_proof)
        ev_views.append(
            {
                "id": str(e.id),
                "capture_event_id": str(e.capture_event_id) if e.capture_event_id else None,
                "document_id": str(e.document_id) if e.document_id else None,
                "field_operation_id": str(e.field_operation_id) if e.field_operation_id else None,
                "note": e.note,
                "tamper_evident": tamper_evident,
            }
        )
    return {
        "id": str(p.id),
        "field_id": str(p.field_id),
        "crop_year": p.crop_year,
        "practice_type": p.practice_type,
        "acres": float(p.acres) if p.acres is not None else None,
        "attributes": p.attributes,
        "evidence": ev_views,
        "evidence_count": len(ev_views),
    }


@router.get("/practices")
def list_practices(
    crop_year: int | None = None,
    field_id: uuid.UUID | None = None,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    q = select(Practice).order_by(Practice.crop_year.desc())
    if crop_year:
        q = q.where(Practice.crop_year == crop_year)
    if field_id:
        q = q.where(Practice.field_id == field_id)
    return [_practice_view(p, session) for p in session.scalars(q)]


@router.post("/practices", status_code=201)
def create_practice(body: PracticeIn, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    if session.get(Field, body.field_id) is None:
        raise HTTPException(status_code=422, detail="unknown field_id")
    p = Practice(
        field_id=body.field_id,
        crop_year=body.crop_year,
        practice_type=body.practice_type,
        acres=body.acres,
        attributes=body.attributes,
    )
    session.add(p)
    session.flush()
    session.add(AuditLog(user_id=user.id, action="practice.create", entity_type="practice", entity_id=p.id))
    return _practice_view(p, session)


class EvidenceIn(BaseModel):
    capture_event_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    field_operation_id: uuid.UUID | None = None
    note: str | None = None


@router.post("/practices/{practice_id}/evidence", status_code=201)
def add_evidence(
    practice_id: uuid.UUID,
    body: EvidenceIn,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    p = session.get(Practice, practice_id)
    if p is None:
        raise HTTPException(status_code=404, detail="unknown practice")
    if not (body.capture_event_id or body.document_id or body.field_operation_id):
        raise HTTPException(status_code=422, detail="evidence must reference a capture, document, or operation")
    for model, value in ((CaptureEvent, body.capture_event_id), (Document, body.document_id),
                         (FieldOperation, body.field_operation_id)):
        if value is not None and session.get(model, value) is None:
            raise HTTPException(status_code=422, detail=f"unknown {model.__tablename__} id")
    e = PracticeEvidence(
        practice_id=p.id,
        capture_event_id=body.capture_event_id,
        document_id=body.document_id,
        field_operation_id=body.field_operation_id,
        note=body.note,
    )
    session.add(e)
    session.flush()
    session.add(AuditLog(user_id=user.id, action="practice.evidence", entity_type="practice", entity_id=p.id))
    return _practice_view(p, session)


# ------------------------------------------------------------------ enrollments


class EnrollmentIn(BaseModel):
    program_key: str
    crop_year: int
    field_id: uuid.UUID | None = None
    acres: float | None = None
    status: str = PField(default="enrolled", pattern="^(enrolled|considering|declined)$")
    notes: str | None = None


@router.get("/enrollments")
def list_enrollments(
    crop_year: int | None = None,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    q = select(ProgramEnrollment).order_by(ProgramEnrollment.crop_year.desc())
    if crop_year:
        q = q.where(ProgramEnrollment.crop_year == crop_year)
    return [
        {
            "id": str(e.id),
            "program_key": e.program_key,
            "crop_year": e.crop_year,
            "field_id": str(e.field_id) if e.field_id else None,
            "acres": float(e.acres) if e.acres is not None else None,
            "status": e.status,
            "notes": e.notes,
        }
        for e in session.scalars(q)
    ]


@router.post("/enrollments", status_code=201)
def create_enrollment(body: EnrollmentIn, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    e = ProgramEnrollment(
        program_key=body.program_key,
        crop_year=body.crop_year,
        field_id=body.field_id,
        acres=body.acres,
        status=body.status,
        notes=body.notes,
    )
    session.add(e)
    session.flush()
    session.add(AuditLog(user_id=user.id, action="enrollment.create", entity_type="program_enrollment", entity_id=e.id))
    return {"id": str(e.id)}


# ------------------------------------------------------------------ compliance


@router.get("/compliance/rup")
def rup_compliance(
    year: int,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    """Restricted-use pesticide records for the year, graded against the
    region pack's legal required-field list — with citation."""
    from ...services import compliance

    return compliance.rup_records(session, year)


# ------------------------------------------------------------------ stacking


@router.get("/programs/{program_key}/readiness")
def mrv_readiness(
    program_key: str,
    crop_year: int,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    from ...services import mrv

    try:
        return mrv.readiness(session, program_key, crop_year)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/programs/stacking")
def stacking_check(
    programs: str = Query(..., description="comma-separated program keys"),
    acres: float = Query(..., gt=0),
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    keys = [k.strip() for k in programs.split(",") if k.strip()]
    if len(keys) < 2:
        raise HTTPException(status_code=422, detail="pass at least two program keys")
    try:
        return stacking.check(session, keys, acres)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
