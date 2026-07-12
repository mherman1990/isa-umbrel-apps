"""Device-token auth.

Design constraint (Hard Requirement #14): paired devices, not browser
sessions, so a native client later uses the exact same flow. Umbrel's
app_proxy gates first contact on the LAN; bootstrap only works while the
user table is empty.

Flow:
  1. Owner's first request → POST /auth/bootstrap creates owner + token.
  2. Owner mints a 6-digit pairing code (10-min TTL, single use), shows it
     on screen; the new phone calls POST /auth/pair {code, device_name}
     and receives a long-lived token (shown once, stored hashed).
"""
from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import get_session
from .models import AppUser, DeviceToken, PairingCode

TOKEN_PREFIX = "fos_"
PAIRING_TTL = timedelta(minutes=10)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def mint_token(session: Session, user: AppUser, device_name: str) -> str:
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    session.add(DeviceToken(user_id=user.id, token_hash=_hash(token), device_name=device_name))
    return token


def mint_pairing_code(session: Session, user: AppUser, role: str = "operator") -> PairingCode:
    code = PairingCode(
        code=f"{secrets.randbelow(1_000_000):06d}",
        user_id=user.id,
        role=role,
        expires_at=datetime.now(timezone.utc) + PAIRING_TTL,
    )
    session.add(code)
    return code


def redeem_pairing_code(session: Session, code: str, device_name: str) -> tuple[str, AppUser]:
    row = session.get(PairingCode, code)
    now = datetime.now(timezone.utc)
    if row is None or row.consumed_at is not None or row.expires_at < now:
        raise HTTPException(status_code=400, detail="invalid or expired pairing code")
    row.consumed_at = now
    # A pairing code pairs a NEW device for a (possibly new) user with the code's role.
    user = AppUser(id=uuid.uuid4(), display_name=device_name, role=row.role)
    session.add(user)
    session.flush()
    return mint_token(session, user, device_name), user


def current_user(request: Request, session: Session = Depends(get_session)) -> AppUser:
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = auth.removeprefix("Bearer ").strip()
    row = session.scalar(select(DeviceToken).where(DeviceToken.token_hash == _hash(token)))
    if row is None or row.revoked_at is not None:
        raise HTTPException(status_code=401, detail="invalid token")
    row.last_seen_at = datetime.now(timezone.utc)
    user = session.get(AppUser, row.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="inactive user")
    return user


def require_owner(user: AppUser = Depends(current_user)) -> AppUser:
    if user.role != "owner":
        raise HTTPException(status_code=403, detail="owner role required")
    return user
