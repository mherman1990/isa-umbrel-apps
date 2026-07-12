"""Daily brief (Phase 5 slice): what needs doing, deadlines, position,
missing records — composed from ACTUAL state, written by the reasoning
model in plain language. The model gets structured facts and is told to
add nothing; the inputs are stored beside the output so any line can be
traced to its source.

Marketing questions get data, not recommendations (the education/advice
framing decision is still open) — the prompt forbids advice.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import llm
from ..models import CaptureEvent, ConfirmationQueueItem, DailyBrief, FarmProfile, FieldOperation

BRIEF_SYSTEM = """You write a short morning brief for a corn/soybean farmer from
the structured facts below — his own records, from his own self-hosted system.

Rules:
- Use ONLY the facts given. Never invent a number, a deadline, or a record.
- If a section has no facts, skip it entirely — no filler.
- NO marketing advice. You may state his grain position; never suggest
  whether to sell, store, or contract.
- Plain language, farmer-voiced, under 250 words. Markdown with short
  headers. Lead with whatever is most actionable today."""


def gather_inputs(session: Session, today: date) -> dict:
    from ..services import grain as grain_svc

    profile = session.scalars(select(FarmProfile)).first()
    year = today.year

    inbox_count = session.scalar(
        select(func.count()).select_from(ConfirmationQueueItem).where(ConfirmationQueueItem.state == "pending")
    )
    failed = session.scalar(
        select(func.count()).select_from(CaptureEvent).where(CaptureEvent.status == "failed")
    )
    recent_ops = session.scalars(
        select(FieldOperation).order_by(FieldOperation.occurred_at.desc()).limit(5)
    ).all()

    # reuse the nudge computation for deadlines/backup/spend states
    from ..api.v1.nudges import DEADLINE_WINDOW_DAYS  # noqa: F401 — same window
    from ..models import Program
    from datetime import timedelta

    deadlines = [
        {"program": p.name, "deadline": p.signup_deadline_date.isoformat(),
         "days_left": (p.signup_deadline_date - today).days}
        for p in session.scalars(
            select(Program).where(
                Program.signup_deadline_date.isnot(None),
                Program.signup_deadline_date >= today,
                Program.signup_deadline_date <= today + timedelta(days=45),
            )
        )
    ]

    position = grain_svc.position(session, year)
    spend = llm.month_spend_usd(session)

    return {
        "date": today.isoformat(),
        "operation": profile.operation_name if profile else None,
        "inbox_pending": inbox_count,
        "captures_failed": failed,
        "recent_operations": [
            {"type": op.op_type, "date": op.occurred_at.date().isoformat(), "notes": op.notes}
            for op in recent_ops
        ],
        "program_deadlines": deadlines,
        "grain_position": position["crops"],
        "llm_spend_month_usd": round(spend, 2),
    }


def generate(session: Session, today: date | None = None) -> DailyBrief:
    today = today or date.today()
    existing = session.scalar(select(DailyBrief).where(DailyBrief.brief_date == today))
    if existing is not None:
        return existing

    inputs = gather_inputs(session, today)
    profile = session.scalars(select(FarmProfile)).first()
    cap = float(profile.monthly_spend_cap_usd) if profile else 20.0
    result = llm.complete(
        session,
        purpose="program_reasoning",  # reasoning tier; brief synthesizes across domains
        system=BRIEF_SYSTEM,
        messages=[{"role": "user", "content": json.dumps(inputs)}],
        max_tokens=1024,
        cap_usd=cap,
    )
    brief = DailyBrief(brief_date=today, body_md=result.text.strip(), inputs=inputs, model_used=result.model)
    session.add(brief)
    return brief
