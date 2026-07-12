"""Agronomic decision support (N rate / MRTN, fungicide ROI, practice
economics). Recommendations grounded in cited region-pack data + the farm's
own records; gaps surfaced, never fabricated."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field as PField
from sqlalchemy.orm import Session

from ... import auth
from ...db import get_session
from ...models import AppUser
from ...services import agronomy

router = APIRouter(prefix="/agronomy", tags=["agronomy"])


@router.get("/n-rate")
def n_rate(
    corn_price: float = Query(gt=0, description="$/bu"),
    n_price_per_lb: float = Query(gt=0, description="$/lb N"),
    rotation: str = Query("corn_after_soybean"),
    applied_n: float | None = Query(default=None, ge=0, description="lb N/ac actually applied (optional)"),
    field_id: uuid.UUID | None = None,
    crop_year: int | None = None,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    """Economically optimal corn N (MRTN) for the entered prices; optionally
    compares to what was applied (passed in, or read from a nutrient_mgmt
    practice for field_id+crop_year)."""
    return agronomy.n_rate(
        session,
        corn_price=corn_price,
        n_price_per_lb=n_price_per_lb,
        rotation=rotation,
        applied_n=applied_n,
        field_id=field_id,
        crop_year=crop_year,
    )


class FungicideRoiIn(BaseModel):
    crop: str = "corn"
    grain_price: float = PField(gt=0)
    product_cost_per_ac: float = PField(ge=0)
    application_cost_per_ac: float = PField(default=0.0, ge=0)
    pressure: str = PField(default="moderate")


@router.post("/fungicide-roi")
def fungicide_roi(
    body: FungicideRoiIn,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    """Expected-value ROI on a fungicide pass from grain price, costs, and cited
    yield-response ranges by disease pressure."""
    return agronomy.fungicide_roi(
        crop=body.crop,
        grain_price=body.grain_price,
        product_cost_per_ac=body.product_cost_per_ac,
        application_cost_per_ac=body.application_cost_per_ac,
        pressure=body.pressure,
    )
