from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import auth
from ...db import get_session
from ...models import AppUser, FarmProfile
from ...services import program_finder

router = APIRouter(prefix="/programs", tags=["programs"])


@router.get("/matches")
def matches(session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    profile = session.scalars(select(FarmProfile)).first()
    if profile is None:
        raise HTTPException(status_code=409, detail="complete onboarding first")
    return {
        "disclaimer": (
            "Programs worth a look — not eligibility determinations. Every line "
            "cites its source and shows when it was last verified. Confirm terms "
            "with the administering agency before acting."
        ),
        "pack_health": program_finder.pack_health(session),
        "programs": program_finder.find_programs(session, profile),
    }
