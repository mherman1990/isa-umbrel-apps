"""Agronomic decision support (N rate / MRTN, fungicide ROI, practice
economics). Recommendations grounded in cited region-pack data + the farm's
own records; gaps surfaced, never fabricated."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
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
