from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field as PField
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import auth
from ...db import get_session
from ...models import AppUser, AuditLog, GrainContract
from ...services import grain

router = APIRouter(prefix="/grain", tags=["grain"])


class ContractIn(BaseModel):
    client_id: uuid.UUID | None = None
    crop: str
    crop_year: int
    contract_type: str = PField(pattern="^(cash|hta|basis|futures|options)$")
    bushels: float = PField(gt=0)
    price_per_bu: float | None = None
    basis: float | None = None
    elevator: str | None = None
    contract_number: str | None = None
    delivery_start: date | None = None
    delivery_end: date | None = None
    notes: str | None = None


def _view(c: GrainContract) -> dict:
    return {
        "id": str(c.id),
        "crop": c.crop,
        "crop_year": c.crop_year,
        "contract_type": c.contract_type,
        "bushels": float(c.bushels),
        "price_per_bu": float(c.price_per_bu) if c.price_per_bu is not None else None,
        "basis": float(c.basis) if c.basis is not None else None,
        "elevator": c.elevator,
        "contract_number": c.contract_number,
        "delivery_start": c.delivery_start.isoformat() if c.delivery_start else None,
        "delivery_end": c.delivery_end.isoformat() if c.delivery_end else None,
        "delivered_bushels": float(c.delivered_bushels),
        "notes": c.notes,
    }


@router.get("/contracts")
def list_contracts(
    year: int | None = None,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    q = select(GrainContract).order_by(GrainContract.crop_year.desc(), GrainContract.created_at)
    if year:
        q = q.where(GrainContract.crop_year == year)
    return [_view(c) for c in session.scalars(q)]


@router.post("/contracts", status_code=201)
def create_contract(body: ContractIn, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    if body.client_id is not None:
        existing = session.scalar(select(GrainContract).where(GrainContract.client_id == body.client_id))
        if existing is not None:
            return _view(existing)
    c = GrainContract(
        client_id=body.client_id,
        crop=body.crop.lower(),
        crop_year=body.crop_year,
        contract_type=body.contract_type,
        bushels=body.bushels,
        price_per_bu=body.price_per_bu,
        basis=body.basis,
        elevator=body.elevator,
        contract_number=body.contract_number,
        delivery_start=body.delivery_start,
        delivery_end=body.delivery_end,
        notes=body.notes,
    )
    session.add(c)
    session.flush()
    session.add(AuditLog(user_id=user.id, action="contract.create", entity_type="grain_contract", entity_id=c.id))
    return _view(c)


class DeliveryIn(BaseModel):
    bushels: float = PField(gt=0)


@router.post("/contracts/{contract_id}/deliver")
def record_delivery(
    contract_id: uuid.UUID,
    body: DeliveryIn,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    c = session.get(GrainContract, contract_id)
    if c is None:
        raise HTTPException(status_code=404, detail="unknown contract")
    c.delivered_bushels = float(c.delivered_bushels) + body.bushels
    session.add(AuditLog(user_id=user.id, action="contract.deliver", entity_type="grain_contract",
                         entity_id=c.id, detail={"bushels": body.bushels}))
    return _view(c)


@router.get("/position")
def grain_position(
    year: int,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    return grain.position(session, year)
