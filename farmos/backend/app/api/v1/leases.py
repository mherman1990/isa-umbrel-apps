"""Field tenure records (the Lease entity, previously unwired).

A lease records how a field is held — owned, cash rent, crop share, or flex —
with the landlord, producer share, and rent. These feed operating-mode
comparisons and per-field economics; the scenario tool can pre-fill from a
field's recorded lease.
"""
from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field as PField
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import auth
from ...db import get_session
from ...models import AppUser, AuditLog, Field, Lease

router = APIRouter(tags=["leases"])

_LEASE_TYPES = "^(owned|cash_rent|crop_share|flex)$"


def _lease_view(lease: Lease) -> dict:
    return {
        "id": str(lease.id),
        "field_id": str(lease.field_id),
        "lease_type": lease.lease_type,
        "landlord_name": lease.landlord_name,
        "producer_share": float(lease.producer_share) if lease.producer_share is not None else None,
        "rent_per_acre": float(lease.rent_per_acre) if lease.rent_per_acre is not None else None,
        "start_date": lease.start_date.isoformat(),
        "end_date": lease.end_date.isoformat() if lease.end_date else None,
    }


class LeaseIn(BaseModel):
    client_id: uuid.UUID | None = None
    field_id: uuid.UUID
    lease_type: str = PField(pattern=_LEASE_TYPES)
    landlord_name: str | None = None
    producer_share: float | None = PField(default=None, ge=0, le=1)
    rent_per_acre: float | None = PField(default=None, ge=0)
    start_date: date
    end_date: date | None = None


class LeasePatch(BaseModel):
    lease_type: str | None = PField(default=None, pattern=_LEASE_TYPES)
    landlord_name: str | None = None
    producer_share: float | None = PField(default=None, ge=0, le=1)
    rent_per_acre: float | None = PField(default=None, ge=0)
    start_date: date | None = None
    end_date: date | None = None


@router.get("/leases")
def list_leases(
    field_id: uuid.UUID | None = None,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    q = select(Lease).order_by(Lease.start_date.desc())
    if field_id is not None:
        q = q.where(Lease.field_id == field_id)
    return [_lease_view(x) for x in session.scalars(q)]


@router.post("/leases", status_code=201)
def create_lease(
    body: LeaseIn,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    if body.client_id is not None:
        existing = session.scalar(select(Lease).where(Lease.client_id == body.client_id))
        if existing is not None:
            return _lease_view(existing)
    if session.get(Field, body.field_id) is None:
        raise HTTPException(status_code=422, detail="unknown field_id")
    lease = Lease(
        client_id=body.client_id,
        field_id=body.field_id,
        lease_type=body.lease_type,
        landlord_name=body.landlord_name,
        producer_share=body.producer_share,
        rent_per_acre=body.rent_per_acre,
        start_date=body.start_date,
        end_date=body.end_date,
    )
    session.add(lease)
    session.flush()
    session.add(AuditLog(user_id=user.id, action="lease.create", entity_type="lease", entity_id=lease.id))
    return _lease_view(lease)


@router.patch("/leases/{lease_id}")
def update_lease(
    lease_id: uuid.UUID,
    body: LeasePatch,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    lease = session.get(Lease, lease_id)
    if lease is None:
        raise HTTPException(status_code=404, detail="unknown lease")
    provided = body.model_fields_set
    for attr in ("lease_type", "landlord_name", "producer_share", "rent_per_acre", "start_date", "end_date"):
        if attr in provided:
            setattr(lease, attr, getattr(body, attr))
    if provided:
        session.add(AuditLog(user_id=user.id, action="lease.update", entity_type="lease", entity_id=lease.id,
                             detail={"changed": sorted(provided)}))
    return _lease_view(lease)


@router.delete("/leases/{lease_id}", status_code=204)
def delete_lease(
    lease_id: uuid.UUID,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    lease = session.get(Lease, lease_id)
    if lease is None:
        raise HTTPException(status_code=404, detail="unknown lease")
    session.add(AuditLog(user_id=user.id, action="lease.delete", entity_type="lease", entity_id=lease.id))
    session.delete(lease)
    return Response(status_code=204)
