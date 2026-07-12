from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ... import auth
from ...db import get_session
from ...models import AppUser, AuditLog, DeviceToken

router = APIRouter(prefix="/auth", tags=["auth"])


class BootstrapIn(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)
    device_name: str = Field(default="Owner device", max_length=120)


@router.post("/bootstrap")
def bootstrap(body: BootstrapIn, session: Session = Depends(get_session)):
    """Create the owner + first device token. Only works while no users
    exist — Umbrel's app_proxy gates who can reach this on first run."""
    if session.scalar(select(func.count()).select_from(AppUser)):
        raise HTTPException(status_code=409, detail="already set up — pair a device instead")
    user = AppUser(id=uuid.uuid4(), display_name=body.display_name, role="owner")
    session.add(user)
    session.flush()
    token = auth.mint_token(session, user, body.device_name)
    session.add(AuditLog(user_id=user.id, action="auth.bootstrap"))
    return {"token": token, "user": {"id": str(user.id), "display_name": user.display_name, "role": user.role}}


class PairingCodeIn(BaseModel):
    role: str = Field(default="operator", pattern="^(owner|operator|advisor|readonly)$")


@router.post("/pairing-codes")
def create_pairing_code(
    body: PairingCodeIn,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.require_owner),
):
    code = auth.mint_pairing_code(session, user, role=body.role)
    return {"code": code.code, "expires_at": code.expires_at.isoformat(), "role": code.role}


class PairIn(BaseModel):
    code: str = Field(min_length=6, max_length=6)
    device_name: str = Field(min_length=1, max_length=120)


@router.post("/pair")
def pair(body: PairIn, session: Session = Depends(get_session)):
    token, user = auth.redeem_pairing_code(session, body.code, body.device_name)
    session.add(AuditLog(user_id=user.id, action="auth.pair", detail={"device": body.device_name}))
    return {"token": token, "user": {"id": str(user.id), "display_name": user.display_name, "role": user.role}}


@router.get("/devices")
def list_devices(session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    rows = session.scalars(select(DeviceToken).order_by(DeviceToken.created_at)).all()
    return [
        {
            "id": str(r.id),
            "device_name": r.device_name,
            "last_seen_at": r.last_seen_at.isoformat() if r.last_seen_at else None,
            "revoked": r.revoked_at is not None,
        }
        for r in rows
    ]


@router.delete("/devices/{device_id}")
def revoke_device(
    device_id: uuid.UUID,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.require_owner),
):
    row = session.get(DeviceToken, device_id)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown device")
    row.revoked_at = datetime.now(timezone.utc)
    session.add(AuditLog(user_id=user.id, action="auth.revoke_device", detail={"device": row.device_name}))
    return {"ok": True}


@router.get("/me")
def me(user: AppUser = Depends(auth.current_user)):
    return {"id": str(user.id), "display_name": user.display_name, "role": user.role}
