"""Assistant chat over the farm's own data (Phase 5).

Architecture: no agent runtime (Hard Requirement #13) — one metered call
per question. The server assembles a structured snapshot of the farm's
actual records; the model answers ONLY from it, citing record ids, and
says "I don't have that recorded" when the answer isn't in the data.
Marketing questions get data and frameworks, never recommendations (the
education/advice framing decision is still open).

The client keeps conversation history and sends it back — stateless
server, same API a native client will use.
"""
from __future__ import annotations

import json
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import llm
from ..models import (
    ConfirmationQueueItem,
    Document,
    FarmProfile,
    Field,
    FieldOperation,
    InputInventory,
    OperationProduct,
    Practice,
    Product,
    ProgramEnrollment,
)

CHAT_SYSTEM = """You are the assistant inside a farmer's self-hosted record system.
You answer questions about HIS farm from the snapshot of HIS records below.

Hard rules:
- Answer ONLY from the snapshot. If the answer isn't in it, say plainly
  "I don't have that recorded" and name what record would answer it.
  NEVER fabricate a farm record, a number, a date, or a program term.
- When you state a fact, name its source in brackets, e.g. [operation
  9f2c...] or [grain position] — use the ids/section names given.
- Marketing questions (sell/store/contract timing): present his own data
  and general frameworks only. NO recommendations on what he should do
  with his bushels.
- Program/eligibility questions: only repeat what the snapshot's program
  data says, with its citation; tell him to confirm with the agency.
- Be brief and concrete. Farmer-voiced, no filler.

FARM RECORD SNAPSHOT (JSON):
{snapshot}"""

MAX_HISTORY = 12


def _iso(v):
    return v.isoformat() if v is not None else None


def build_snapshot(session: Session, year: int | None = None) -> dict:
    from ..services import financials, grain

    year = year or date.today().year
    profile = session.scalars(select(FarmProfile)).first()

    fields = [
        {"id": str(f.id)[:8], "name": f.name, "tract": f.tract_number, "field": f.field_number,
         "acres": float(f.clu_calculated_acres or f.gis_acres or 0) or None}
        for f in session.scalars(select(Field).where(Field.archived_at.is_(None)))
    ]

    ops = []
    for op in session.scalars(select(FieldOperation).order_by(FieldOperation.occurred_at.desc()).limit(40)):
        products = session.execute(
            select(Product.name, OperationProduct.rate, OperationProduct.rate_unit)
            .join(OperationProduct, OperationProduct.product_id == Product.id)
            .where(OperationProduct.operation_id == op.id)
        ).all()
        ops.append({
            "id": str(op.id)[:8],
            "type": op.op_type,
            "date": op.occurred_at.date().isoformat(),
            "field_id": str(op.field_id)[:8],
            "products": [f"{n} {r or ''} {u or ''}".strip() for n, r, u in products],
            "details": op.details,
            "notes": op.notes,
            "weather": op.weather,
        })

    inventory = [
        {"product": p.name, "on_hand": float(i.quantity), "unit": i.unit}
        for i, p in session.execute(
            select(InputInventory, Product).join(Product, InputInventory.product_id == Product.id)
        )
    ]

    docs = [
        {"id": str(d.id)[:8], "type": d.doc_type, "title": d.title, "extracted": d.extracted}
        for d in session.scalars(select(Document).order_by(Document.created_at.desc()).limit(30))
    ]

    practices = [
        {"id": str(p.id)[:8], "type": p.practice_type, "field_id": str(p.field_id)[:8],
         "crop_year": p.crop_year, "attributes": p.attributes}
        for p in session.scalars(select(Practice).order_by(Practice.crop_year.desc()).limit(30))
    ]

    enrollments = [
        {"program": e.program_key, "crop_year": e.crop_year, "status": e.status,
         "acres": float(e.acres) if e.acres is not None else None}
        for e in session.scalars(select(ProgramEnrollment))
    ]

    inbox_pending = session.scalar(
        select(func.count()).select_from(ConfirmationQueueItem).where(ConfirmationQueueItem.state == "pending")
    )

    return {
        "as_of": date.today().isoformat(),
        "operation_name": profile.operation_name if profile else None,
        "crop_year": year,
        "fields": fields,
        "recent_operations": ops,
        "input_inventory": inventory,
        "documents": docs,
        "practices": practices,
        "program_enrollments": enrollments,
        "grain_position": grain.position(session, year)["crops"],
        "financials": financials.crop_summary(session, year),
        "inbox_pending_count": inbox_pending,
        "note_to_model": "This is the complete snapshot. Anything not here is NOT RECORDED.",
    }


def chat(session: Session, question: str, history: list[dict] | None = None,
         cap_usd: float = 20.0) -> dict:
    snapshot = build_snapshot(session)
    system = CHAT_SYSTEM.replace("{snapshot}", json.dumps(snapshot, default=str))

    messages = []
    for turn in (history or [])[-MAX_HISTORY:]:
        if turn.get("role") in ("user", "assistant") and isinstance(turn.get("content"), str):
            messages.append({"role": turn["role"], "content": turn["content"]})
    messages.append({"role": "user", "content": question})

    result = llm.complete(
        session,
        purpose="chat",
        system=system,
        messages=messages,
        max_tokens=1024,
        cap_usd=cap_usd,
    )
    return {
        "answer": result.text.strip(),
        "model": result.model,
        "cost_usd": result.cost_usd,
        "snapshot_sections": [k for k, v in snapshot.items() if v],
    }
