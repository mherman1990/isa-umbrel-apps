"""Profile, crop years (FSA-578 columns), field operations, products, inventory."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field as PField
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import auth
from ...config import settings
from ...db import get_session
from ...models import (
    AppUser,
    AuditLog,
    CropYear,
    FarmProfile,
    Field,
    FieldOperation,
    InputInventory,
    OperationProduct,
    Product,
)

router = APIRouter(tags=["records"])


# ------------------------------------------------------------------ profile


def _profile_view(p: FarmProfile) -> dict:
    return {
        "id": str(p.id),
        "operation_name": p.operation_name,
        "state_code": p.state_code,
        "county_ansi_code": p.county_ansi_code,
        "entity_type": p.entity_type,
        "crops": p.crops,
        "tenure": p.tenure,
        "tillage_system": p.tillage_system,
        "beginning_farmer": p.beginning_farmer,
        "practice_history": p.practice_history,
        "monthly_spend_cap_usd": float(p.monthly_spend_cap_usd),
        "anthropic_key_set": p.anthropic_key_set,
        "onboarding_completed": p.onboarding_completed_at is not None,
    }


class ProfileIn(BaseModel):
    operation_name: str | None = None
    state_code: str | None = PField(default=None, min_length=2, max_length=2)
    county_ansi_code: str | None = PField(default=None, min_length=3, max_length=3)
    entity_type: str | None = None
    crops: dict | None = None
    tenure: dict | None = None
    tillage_system: str | None = None
    beginning_farmer: bool | None = None
    practice_history: dict | None = None
    monthly_spend_cap_usd: float | None = PField(default=None, ge=0)
    anthropic_api_key: str | None = None  # write-only; stored in /data/secrets, never in the DB


@router.get("/profile")
def get_profile(session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    p = session.scalars(select(FarmProfile)).first()
    if p is None:
        return {"onboarding_completed": False, "exists": False}
    return _profile_view(p)


@router.put("/profile")
def put_profile(body: ProfileIn, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    p = session.scalars(select(FarmProfile)).first()
    if p is None:
        if not body.operation_name:
            raise HTTPException(status_code=422, detail="operation_name required on first save")
        p = FarmProfile(operation_name=body.operation_name)
        session.add(p)
        session.flush()
    for attr in ("operation_name", "state_code", "county_ansi_code", "entity_type", "crops",
                 "tenure", "tillage_system", "beginning_farmer", "practice_history",
                 "monthly_spend_cap_usd"):
        value = getattr(body, attr)
        if value is not None:
            setattr(p, attr, value)
    if body.anthropic_api_key:
        settings.set_anthropic_key(body.anthropic_api_key)
        p.anthropic_key_set = True
    session.add(AuditLog(user_id=user.id, action="profile.update"))
    return _profile_view(p)


@router.post("/profile/complete")
def complete_onboarding(session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    p = session.scalars(select(FarmProfile)).first()
    if p is None:
        raise HTTPException(status_code=409, detail="no profile yet")
    p.onboarding_completed_at = datetime.now(timezone.utc)
    session.add(AuditLog(user_id=user.id, action="profile.complete"))
    return _profile_view(p)


# ------------------------------------------------------------------ crop years


class CropYearIn(BaseModel):
    field_id: uuid.UUID
    crop_year: int
    crop_code: str
    crop_name: str
    crop_type_code: str | None = None
    variety: str | None = None
    intended_use_code: str = "GR"
    reported_acres: float
    original_planted_date: str | None = None
    final_planted_date: str | None = None
    planting_pattern: str | None = None
    producer_share: float = 1.0
    irrigation_practice_code: str = PField(default="N", pattern="^[INO]$")
    prevented_planted: bool = False
    failed_acres: float = 0


def _crop_year_view(c: CropYear) -> dict:
    return {
        "id": str(c.id),
        "field_id": str(c.field_id),
        "crop_year": c.crop_year,
        "crop_code": c.crop_code,
        "crop_name": c.crop_name,
        "crop_type_code": c.crop_type_code,
        "variety": c.variety,
        "intended_use_code": c.intended_use_code,
        "reported_acres": float(c.reported_acres),
        "original_planted_date": c.original_planted_date.isoformat() if c.original_planted_date else None,
        "final_planted_date": c.final_planted_date.isoformat() if c.final_planted_date else None,
        "planting_pattern": c.planting_pattern,
        "producer_share": float(c.producer_share),
        "irrigation_practice_code": c.irrigation_practice_code,
        "prevented_planted": c.prevented_planted,
        "failed_acres": float(c.failed_acres),
    }


@router.get("/crop-years")
def list_crop_years(
    year: int | None = None,
    field_id: uuid.UUID | None = None,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    q = select(CropYear)
    if year:
        q = q.where(CropYear.crop_year == year)
    if field_id:
        q = q.where(CropYear.field_id == field_id)
    return [_crop_year_view(c) for c in session.scalars(q.order_by(CropYear.crop_year.desc()))]


@router.post("/crop-years", status_code=201)
def create_crop_year(body: CropYearIn, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    from datetime import date as date_cls

    if session.get(Field, body.field_id) is None:
        raise HTTPException(status_code=422, detail="unknown field_id")
    row = CropYear(
        field_id=body.field_id,
        crop_year=body.crop_year,
        crop_code=body.crop_code,
        crop_name=body.crop_name,
        crop_type_code=body.crop_type_code,
        variety=body.variety,
        intended_use_code=body.intended_use_code,
        reported_acres=body.reported_acres,
        original_planted_date=date_cls.fromisoformat(body.original_planted_date) if body.original_planted_date else None,
        final_planted_date=date_cls.fromisoformat(body.final_planted_date) if body.final_planted_date else None,
        planting_pattern=body.planting_pattern,
        producer_share=body.producer_share,
        irrigation_practice_code=body.irrigation_practice_code,
        prevented_planted=body.prevented_planted,
        failed_acres=body.failed_acres,
    )
    session.add(row)
    session.flush()
    session.add(AuditLog(user_id=user.id, action="crop_year.create", entity_type="crop_year", entity_id=row.id))
    return _crop_year_view(row)


# ------------------------------------------------------------------ operations


class OperationProductIn(BaseModel):
    name: str
    category: str = "other"
    rate: float | None = None
    rate_unit: str | None = None
    total_quantity: float | None = None
    unit: str | None = None


class OperationIn(BaseModel):
    client_id: uuid.UUID | None = None
    field_id: uuid.UUID
    op_type: str
    occurred_at: datetime
    acres_covered: float | None = None
    notes: str | None = None
    details: dict = {}
    products: list[OperationProductIn] = []


def _operation_view(op: FieldOperation, session: Session) -> dict:
    products = session.execute(
        select(OperationProduct, Product)
        .join(Product, OperationProduct.product_id == Product.id)
        .where(OperationProduct.operation_id == op.id)
    ).all()
    return {
        "id": str(op.id),
        "field_id": str(op.field_id),
        "op_type": op.op_type,
        "occurred_at": op.occurred_at.isoformat(),
        "acres_covered": float(op.acres_covered) if op.acres_covered is not None else None,
        "notes": op.notes,
        "details": op.details,
        "source_capture_event_id": str(op.source_capture_event_id) if op.source_capture_event_id else None,
        "products": [
            {
                "name": product.name,
                "rate": float(link.rate) if link.rate is not None else None,
                "rate_unit": link.rate_unit,
                "total_quantity": float(link.total_quantity) if link.total_quantity is not None else None,
                "unit": link.unit,
            }
            for link, product in products
        ],
    }


@router.get("/operations")
def list_operations(
    field_id: uuid.UUID | None = None,
    op_type: str | None = None,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    q = select(FieldOperation).order_by(FieldOperation.occurred_at.desc()).limit(200)
    if field_id:
        q = q.where(FieldOperation.field_id == field_id)
    if op_type:
        q = q.where(FieldOperation.op_type == op_type)
    return [_operation_view(op, session) for op in session.scalars(q)]


@router.post("/operations", status_code=201)
def create_operation(body: OperationIn, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    if body.client_id is not None:
        existing = session.scalar(select(FieldOperation).where(FieldOperation.client_id == body.client_id))
        if existing is not None:
            return _operation_view(existing, session)  # idempotent replay
    if session.get(Field, body.field_id) is None:
        raise HTTPException(status_code=422, detail="unknown field_id")
    op = FieldOperation(
        client_id=body.client_id,
        field_id=body.field_id,
        op_type=body.op_type,
        occurred_at=body.occurred_at,
        acres_covered=body.acres_covered,
        notes=body.notes,
        operator_user_id=user.id,
        details=body.details,
    )
    session.add(op)
    session.flush()
    from ...services.records import _get_or_create_product

    for p in body.products:
        product = _get_or_create_product(session, p.name, p.category)
        session.add(
            OperationProduct(
                operation_id=op.id,
                product_id=product.id,
                rate=p.rate,
                rate_unit=p.rate_unit,
                total_quantity=p.total_quantity,
                unit=p.unit,
            )
        )
    session.add(AuditLog(user_id=user.id, action="operation.create", entity_type="field_operation", entity_id=op.id))
    return _operation_view(op, session)


# ------------------------------------------------------------------ products / inventory


@router.get("/products")
def list_products(session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    return [
        {"id": str(p.id), "name": p.name, "category": p.category, "default_unit": p.default_unit,
         "epa_reg_number": p.epa_reg_number}
        for p in session.scalars(select(Product).order_by(Product.name))
    ]


class ProductIn(BaseModel):
    name: str
    category: str
    default_unit: str = "unit"
    epa_reg_number: str | None = None


@router.post("/products", status_code=201)
def create_product(body: ProductIn, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    p = Product(name=body.name, category=body.category, default_unit=body.default_unit,
                epa_reg_number=body.epa_reg_number)
    session.add(p)
    session.flush()
    return {"id": str(p.id), "name": p.name, "category": p.category}


@router.get("/inventory")
def list_inventory(session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    rows = session.execute(
        select(InputInventory, Product).join(Product, InputInventory.product_id == Product.id)
    ).all()
    return [
        {"id": str(inv.id), "product": p.name, "category": p.category,
         "quantity": float(inv.quantity), "unit": inv.unit,
         "unit_cost": float(inv.unit_cost) if inv.unit_cost is not None else None}
        for inv, p in rows
    ]
