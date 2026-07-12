"""MRV readiness (spec §8): per program, "here are the records this
program will demand; here's what you have; here's what's missing; here's
what's tamper-evident" — a to-do list BEFORE the deadline, not a surprise
at verification.

Evaluation is per (requirement × practice): a requirement is satisfied by
evidence of the right artifact kind attached to a matching practice, whose
capture falls inside the requirement's window (MM-DD relative to the crop
year + offset). Verifier-grade means captured-in-app provenance AND a
timestamp proof.
"""
from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    CaptureEvent,
    Document,
    EvidenceRequirement,
    Field,
    FieldOperation,
    Practice,
    PracticeEvidence,
    Program,
)


def _window(req: EvidenceRequirement, crop_year: int) -> tuple[date | None, date | None]:
    year = crop_year + req.year_offset
    start = date.fromisoformat(f"{year}-{req.window_start_md}") if req.window_start_md else None
    end = date.fromisoformat(f"{year}-{req.window_end_md}") if req.window_end_md else None
    return start, end


def _evidence_matches(session: Session, ev: PracticeEvidence, req: EvidenceRequirement,
                      window: tuple[date | None, date | None]) -> dict | None:
    """Returns a match descriptor or None."""
    start, end = window
    if req.artifact_kind in ("photo", "any") and ev.capture_event_id:
        cap = session.get(CaptureEvent, ev.capture_event_id)
        if cap and (req.artifact_kind == "any" or cap.kind == "photo"):
            captured = cap.captured_at.date()
            if (start is None or captured >= start) and (end is None or captured <= end):
                verifier_grade = cap.provenance == "captured" and cap.timestamp_proof is not None
                if req.verifier_grade_required and not verifier_grade:
                    return {"partial": True, "reason": "photo exists but is not verifier-grade "
                            "(needs in-app capture + anchoring)", "captured_at": captured.isoformat()}
                return {"partial": False, "captured_at": captured.isoformat(),
                        "tamper_evident": cap.timestamp_proof is not None}
    if req.artifact_kind in ("document", "any") and ev.document_id:
        doc = session.get(Document, ev.document_id)
        if doc:
            return {"partial": False, "document": doc.title}
    if req.artifact_kind in ("operation", "any") and ev.field_operation_id:
        op = session.get(FieldOperation, ev.field_operation_id)
        if op:
            occurred = op.occurred_at.date()
            if (start is None or occurred >= start) and (end is None or occurred <= end):
                return {"partial": False, "occurred_at": occurred.isoformat()}
    return None


def readiness(session: Session, program_key: str, crop_year: int, today: date | None = None) -> dict:
    today = today or date.today()
    program = session.scalar(select(Program).where(Program.program_key == program_key))
    if program is None:
        raise ValueError(f"unknown program {program_key}")
    requirements = session.scalars(
        select(EvidenceRequirement).where(EvidenceRequirement.program_id == program.id)
    ).all()

    req_views = []
    for req in requirements:
        window = _window(req, crop_year)
        practices = session.scalars(
            select(Practice).where(Practice.practice_type == req.practice_type, Practice.crop_year == crop_year)
        ).all()
        per_practice = []
        for practice in practices:
            field = session.get(Field, practice.field_id)
            evidence = session.scalars(
                select(PracticeEvidence).where(PracticeEvidence.practice_id == practice.id)
            ).all()
            match, partial = None, None
            for ev in evidence:
                m = _evidence_matches(session, ev, req, window)
                if m and not m.get("partial"):
                    match = m
                    break
                if m:
                    partial = m
            start, end = window
            days_left = (end - today).days if end and match is None else None
            per_practice.append({
                "practice_id": str(practice.id),
                "field_name": (field.name or f"T{field.tract_number}/F{field.field_number}") if field else "?",
                "status": "met" if match else ("partial" if partial else "missing"),
                "detail": match or partial,
                "window": [start.isoformat() if start else None, end.isoformat() if end else None],
                "days_left": days_left if days_left is not None and days_left >= 0 else None,
                "window_closed": bool(end and today > end and match is None),
            })
        req_views.append({
            "req_key": req.req_key,
            "subject": req.subject,
            "artifact_kind": req.artifact_kind,
            "practice_type": req.practice_type,
            "verifier_grade_required": req.verifier_grade_required,
            "description": req.description,
            "citation": req.citation,
            "source_url": req.source_url,
            "last_verified": req.last_verified.isoformat(),
            "stale": req.verify_by < today,
            "no_matching_practices": not per_practice,
            "practices": per_practice,
        })

    met = sum(1 for r in req_views for p in r["practices"] if p["status"] == "met")
    total = sum(len(r["practices"]) for r in req_views) or 0
    return {
        "program_key": program_key,
        "program_name": program.name,
        "crop_year": crop_year,
        "requirements": req_views,
        "summary": {
            "requirements_defined": len(req_views),
            "checks_met": met,
            "checks_total": total,
        },
        "note": (
            "Evaluated against this pack's evidence spec. Programs can ask for "
            "more — this is readiness, not a guarantee."
        ) if req_views else "This program has no evidence spec in the loaded region pack yet.",
    }
