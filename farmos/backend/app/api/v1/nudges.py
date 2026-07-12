"""Nudges — computed live, not stored. A reminder that can't act on the
farm's actual state is noise; these derive from it:
  - program signup deadlines inside 45 days (machine-readable pack dates)
  - captures that failed processing (never silently discarded)
  - parsing parked on the spend cap
  - backup missing or stale
"""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ... import auth
from ...db import get_session
from ...models import AppUser, CaptureEvent, Program
from ...services import backup as backup_svc

router = APIRouter(tags=["nudges"])

DEADLINE_WINDOW_DAYS = 45


@router.get("/nudges")
def nudges(session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    today = date.today()
    out: list[dict] = []

    window_end = today + timedelta(days=DEADLINE_WINDOW_DAYS)
    deadline_programs = session.scalars(
        select(Program)
        .where(Program.signup_deadline_date.isnot(None),
               Program.signup_deadline_date >= today,
               Program.signup_deadline_date <= window_end)
        .order_by(Program.signup_deadline_date)
    ).all()
    for p in deadline_programs:
        days = (p.signup_deadline_date - today).days
        out.append({
            "type": "deadline",
            "severity": "high" if days <= 14 else "info",
            "title": f"{p.name} signup closes in {days} days",
            "detail": f"{p.signup_deadline} — verified {p.last_verified.isoformat()}",
            "program_key": p.program_key,
            "source_url": p.source_url,
            "days_left": days,
        })

    failed = session.scalar(
        select(func.count()).select_from(CaptureEvent).where(CaptureEvent.status == "failed")
    )
    if failed:
        out.append({
            "type": "capture_failed",
            "severity": "high",
            "title": f"{failed} capture(s) failed processing",
            "detail": "The raw recordings are safe. Open them to retry or review.",
        })

    parked = session.scalar(
        select(func.count()).select_from(CaptureEvent).where(CaptureEvent.status_detail == "spend_cap")
    )
    if parked:
        out.append({
            "type": "spend_cap",
            "severity": "info",
            "title": f"{parked} capture(s) waiting on the AI spend cap",
            "detail": "They parse automatically next month, or raise the cap in Settings.",
        })

    b = backup_svc.status()
    if not b["configured"]:
        out.append({
            "type": "backup",
            "severity": "high",
            "title": "No backup destination configured",
            "detail": "Your records live on one small computer. Settings → Backups.",
        })
    elif b["age_hours"] is None or b["age_hours"] > 7 * 24:
        out.append({
            "type": "backup",
            "severity": "high",
            "title": "Backups are stale",
            "detail": f"Last backup: {b['last_backup_at'] or 'never'}.",
        })

    return {"nudges": out}
