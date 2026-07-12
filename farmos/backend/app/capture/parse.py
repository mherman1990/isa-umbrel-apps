"""Voice-transcript parsing: one transcript → N typed parse results.

This is the part the spec calls out as "the most common way this feature
gets built wrong" — assuming one capture equals one record. The prompt asks
for an array; the post-processing here validates each element, resolves
field nicknames against the registry, and fans out to the confirmation
queue. Nothing here ever writes a farm record directly.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import llm
from ..models import PARSE_TARGET_TYPES, CaptureEvent, Farm, Field, FarmProfile, ParseResult, Product

PROMPT_PATH = Path(__file__).parent / "prompts" / "voice_parse_v1.txt"


def prompt_version() -> str:
    return "voice_parse_v1:" + hashlib.sha256(PROMPT_PATH.read_bytes()).hexdigest()[:12]


def build_context(session: Session) -> str:
    """Compact farm context so 'the home eighty' resolves to a field UUID."""
    lines: list[str] = []
    fields = session.scalars(select(Field).where(Field.archived_at.is_(None))).all()
    if fields:
        lines.append("Fields (id | nickname | tract/field | acres):")
        for f in fields:
            lines.append(
                f"- {f.id} | {f.name or '(unnamed)'} | T{f.tract_number}/F{f.field_number} | "
                f"{f.clu_calculated_acres or f.gis_acres or '?'} ac"
            )
    products = session.scalars(select(Product)).all()
    if products:
        lines.append("Known products:")
        lines.extend(f"- {p.name} ({p.category}, unit {p.default_unit})" for p in products)
    return "\n".join(lines) or "(no fields or products registered yet)"


def _valid(record) -> bool:
    return (
        isinstance(record, dict)
        and record.get("target_type") in PARSE_TARGET_TYPES
        and isinstance(record.get("payload"), dict)
        and isinstance(record.get("confidence"), (int, float))
        and 0 <= record["confidence"] <= 1
    )


def validate_records(raw) -> list[dict]:
    """Pure post-processing shared with the eval harness: coerce a model
    reply into the list of valid record dicts (invalid entries dropped)."""
    if not isinstance(raw, list):
        raw = [raw]
    return [r for r in raw if _valid(r)]


def parse_transcript(session: Session, capture: CaptureEvent, cap_usd: float) -> list[ParseResult]:
    system = PROMPT_PATH.read_text().replace("{context}", build_context(session))
    result = llm.complete(
        session,
        purpose="voice_parse",
        system=system,
        messages=[{"role": "user", "content": capture.transcript or ""}],
        cap_usd=cap_usd,
        capture_event_id=capture.id,
    )
    try:
        records = llm.extract_json(result.text)
    except ValueError:
        # one retry with an explicit correction, then give up
        result = llm.complete(
            session,
            purpose="voice_parse",
            system=system,
            messages=[
                {"role": "user", "content": capture.transcript or ""},
                {"role": "assistant", "content": result.text},
                {"role": "user", "content": "That was not valid JSON. Return ONLY the JSON array."},
            ],
            cap_usd=cap_usd,
            capture_event_id=capture.id,
        )
        records = llm.extract_json(result.text)

    version = prompt_version()
    out: list[ParseResult] = []
    for i, rec in enumerate(validate_records(records)):
        out.append(
            ParseResult(
                capture_event_id=capture.id,
                seq=i,
                target_type=rec["target_type"],
                extracted=rec["payload"],
                confidence=round(float(rec["confidence"]), 3),
                model_used=result.model,
                prompt_version=version,
                ambiguities=rec.get("ambiguities") or [],
            )
        )
    session.add_all(out)
    return out
