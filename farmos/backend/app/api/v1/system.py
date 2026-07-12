"""Spend meter, backup status, and the "what leaves this box" disclosure."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ... import auth, llm
from ...db import get_session
from ...models import ApiSpend, AppUser, FarmProfile
from ...services import backup as backup_svc

router = APIRouter(tags=["system"])


@router.get("/spend")
def spend(session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    by_purpose = session.execute(
        select(ApiSpend.purpose, ApiSpend.model, func.sum(ApiSpend.cost_usd), func.count())
        .where(func.date_trunc("month", ApiSpend.occurred_at) == func.date_trunc("month", func.now()))
        .group_by(ApiSpend.purpose, ApiSpend.model)
    ).all()
    profile = session.scalars(select(FarmProfile)).first()
    return {
        "month_to_date_usd": round(llm.month_spend_usd(session), 4),
        "cap_usd": float(profile.monthly_spend_cap_usd) if profile else None,
        "by_purpose": [
            {"purpose": p, "model": m, "cost_usd": float(c), "calls": n} for p, m, c, n in by_purpose
        ],
    }


@router.get("/system/backup")
def backup_status(user: AppUser = Depends(auth.current_user)):
    return backup_svc.status()


class BackupConfigIn(BaseModel):
    repos: list[str]
    env: dict[str, str] = {}


@router.post("/system/backup/config")
def backup_config(body: BackupConfigIn, user: AppUser = Depends(auth.require_owner)):
    backup_svc.set_repos(body.repos, body.env)
    phrase, created = backup_svc.ensure_key()
    # The recovery phrase is returned ONCE, on key creation only.
    return {"configured": True, "recovery_phrase": phrase if created else None}


@router.post("/system/backup/run")
def backup_run(user: AppUser = Depends(auth.require_owner)):
    from ...jobs.tasks import run_backup_task

    run_backup_task.defer()
    return {"queued": True}


@router.get("/brief/latest")
def latest_brief(session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    from sqlalchemy import select as sa_select

    from ...models import DailyBrief

    row = session.scalars(sa_select(DailyBrief).order_by(DailyBrief.brief_date.desc()).limit(1)).first()
    if row is None:
        return {"available": False, "note": "The brief generates each morning once an API key is set."}
    return {
        "available": True,
        "brief_date": row.brief_date.isoformat(),
        "body_md": row.body_md,
        "model_used": row.model_used,
    }


@router.get("/system/privacy")
def privacy(user: AppUser = Depends(auth.current_user)):
    """What leaves this box, and where it goes. Stated plainly (Principle 1)."""
    return {
        "outbound": [
            {
                "destination": "Your own LLM provider (Anthropic), under your own API key",
                "payload": "Voice transcript TEXT (never audio), document text, and farm context "
                           "needed to structure your records. Nothing is retained by Farm OS's "
                           "developers — we operate no servers.",
                "when": "Parsing captures; assistant features",
            },
            {
                "destination": "Your own backup destination (USB drive or your own cloud bucket)",
                "payload": "Encrypted backups. The provider stores ciphertext it cannot read.",
                "when": "Nightly, if configured",
            },
            {
                "destination": "Public timestamp calendar servers (OpenTimestamps)",
                "payload": "A single anonymous HASH per night — no farm data, no filenames, "
                           "nothing readable. This is what makes your records tamper-evident "
                           "to an insurance adjuster or program verifier.",
                "when": "Nightly",
            },
            {
                "destination": "Esri aerial imagery tiles — ONLY if you turn on the field-map basemap",
                "payload": "Map-tile requests for the area you're viewing, which reveal your field "
                           "location to the tile server. Off by default; no farm records are sent. "
                           "Turn it off and the boundary editor works fully offline.",
                "when": "Only while the field-map imagery toggle is on",
            },
        ],
        "never": [
            "No telemetry, no analytics, no phoning home.",
            "Raw audio never leaves this box (transcription is local).",
            "No data intermediary: FSA paperwork is generated here and submitted by you.",
        ],
    }
