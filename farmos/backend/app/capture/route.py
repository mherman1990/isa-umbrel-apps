"""Photo/file routing — the second half of the capture layer.

A photo is either a FIELD PHOTO (scouting, stand, damage, equipment) or a
DOCUMENT (the applicator record is a carbon-copy sheet on the truck seat
and the phone camera is the scanner). When the classifier says document,
the photo IS a document drop: it lands in the vault immediately (retention
never depends on confirmation) and its extracted fields go to the inbox.

Field photos attach to the nearest field by GPS — never ask the farmer to
pick from 40 fields when the phone already knows where he's standing.
"""
from __future__ import annotations

import base64
import hashlib
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import llm
from ..config import settings
from ..models import CaptureEvent, Document, Field, ParseResult

CLASSIFY_PROMPT_VERSION = "photo_route_v1"

# Anthropic vision-supported image types; HEIC needs client-side conversion
# (the PWA re-encodes camera captures to JPEG; a raw HEIC roll import fails
# with an honest status_detail rather than a silent drop).
IMAGE_MEDIA_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

CLASSIFY_SYSTEM = """You classify a single photo or PDF captured on a corn/soybean farm.

Categories:
- document: any paper/screen with information — receipts, scale tickets,
  seed tags, custom applicator records, leases, FSA letters, insurance
  papers, soil test reports, cash grain contracts.
- scouting: crops/weeds/insects/disease/stand in a field.
- equipment: machinery, a broken part, a leak, a monitor screen showing a fault.
- field_photo: anything else taken outdoors on the farm (field conditions,
  drainage, damage documentation).

Return ONLY JSON:
{"kind": "document|scouting|equipment|field_photo",
 "doc_type": "receipt|scale_ticket|seed_tag|applicator_record|lease|fsa_form|insurance|soil_test|contract|other",  // documents only
 "title": "<short human title>",
 "summary": "<one sentence: what is visible>"}
"""

EXTRACT_SYSTEM = """You extract structured data from a farm document image/PDF.
Document type: {doc_type}

NEVER invent a value — omit keys the document doesn't show. Flag anything
unreadable in "ambiguities" (list of {"key","question"}). Return ONLY JSON:
{"payload": { ...fields you can read... },
 "confidence": 0.0-1.0,
 "ambiguities": [...]}

Field guides by type:
- receipt/invoice: vendor, date, total, items[{description, quantity, unit_price, amount}]
- scale_ticket: elevator, date, commodity, gross_bushels, net_bushels, moisture_pct, test_weight, ticket_number
- seed_tag: brand, variety, lot_number, germination_pct, seed_count, treatment
- applicator_record: applicator, date, field_description, products[{name, rate, epa_reg_number}], wind, temperature
- soil_test: lab, date, samples[{zone, ph, om_pct, p_ppm, k_ppm, cec}]
- other/lease/fsa_form/insurance/contract: issuer, date, subject, key_terms
"""


def _content_block(capture: CaptureEvent) -> dict:
    raw = (settings.data_dir / capture.artifact_path).read_bytes()
    b64 = base64.standard_b64encode(raw).decode()
    if capture.mime_type == "application/pdf":
        return {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": b64}}
    if capture.mime_type in IMAGE_MEDIA_TYPES:
        return {"type": "image", "source": {"type": "base64", "media_type": capture.mime_type, "data": b64}}
    raise ValueError(f"unsupported media type for routing: {capture.mime_type}")


def nearest_field(session: Session, capture: CaptureEvent) -> Field | None:
    if capture.device_gps is None:
        return None
    from geoalchemy2.functions import ST_Distance

    return session.scalars(
        select(Field)
        .where(Field.archived_at.is_(None))
        .order_by(ST_Distance(Field.boundary, capture.device_gps))
        .limit(1)
    ).first()


def classify(session: Session, capture: CaptureEvent, cap_usd: float) -> dict:
    result = llm.complete(
        session,
        purpose="photo_classify",
        system=CLASSIFY_SYSTEM,
        messages=[{"role": "user", "content": [_content_block(capture), {"type": "text", "text": "Classify this."}]}],
        max_tokens=512,
        cap_usd=cap_usd,
        capture_event_id=capture.id,
    )
    verdict = llm.extract_json(result.text)
    if not isinstance(verdict, dict) or verdict.get("kind") not in ("document", "scouting", "equipment", "field_photo"):
        raise ValueError(f"unusable classification: {result.text[:200]}")
    verdict["_model"] = result.model
    return verdict


def extract_document(session: Session, capture: CaptureEvent, doc_type: str, cap_usd: float) -> dict:
    result = llm.complete(
        session,
        purpose="doc_structure",
        system=EXTRACT_SYSTEM.replace("{doc_type}", doc_type),
        messages=[{"role": "user", "content": [_content_block(capture), {"type": "text", "text": "Extract."}]}],
        max_tokens=2048,
        cap_usd=cap_usd,
        capture_event_id=capture.id,
    )
    data = llm.extract_json(result.text)
    if not isinstance(data, dict) or not isinstance(data.get("payload"), dict):
        raise ValueError(f"unusable extraction: {result.text[:200]}")
    data["_model"] = result.model
    return data


def route_capture(session: Session, capture: CaptureEvent, cap_usd: float) -> list[ParseResult]:
    """Classify, then fan out parse results. Returns the created results."""
    verdict = classify(session, capture, cap_usd)
    field = nearest_field(session, capture)
    results: list[ParseResult] = []

    if verdict["kind"] == "document":
        doc_type = verdict.get("doc_type") or "other"
        if doc_type not in ("receipt", "scale_ticket", "seed_tag", "applicator_record", "lease",
                            "fsa_form", "insurance", "soil_test", "contract", "other"):
            doc_type = "other"
        # The vault row exists regardless of what the farmer later confirms.
        doc = Document(
            capture_event_id=capture.id,
            doc_type=doc_type,
            title=verdict.get("title") or f"{doc_type} {capture.captured_at:%Y-%m-%d}",
            file_path=capture.artifact_path,
            related_field_id=field.id if field else None,
        )
        session.add(doc)
        session.flush()
        extraction = extract_document(session, capture, doc_type, cap_usd)
        results.append(
            ParseResult(
                capture_event_id=capture.id,
                seq=0,
                target_type="document",
                extracted={"document_id": str(doc.id), "doc_type": doc_type,
                           "title": doc.title, **extraction["payload"]},
                confidence=round(float(extraction.get("confidence", 0.5)), 3),
                model_used=extraction["_model"],
                prompt_version=CLASSIFY_PROMPT_VERSION,
                ambiguities=extraction.get("ambiguities") or [],
            )
        )
    else:
        target_type = {"scouting": "field_operation", "equipment": "equipment_issue"}.get(
            verdict["kind"], "note"
        )
        if target_type == "field_operation":
            payload = {"op_type": "scout", "notes": verdict.get("summary") or verdict.get("title"),
                       **({"field_id": str(field.id), "field_name": field.name} if field else {})}
        elif target_type == "equipment_issue":
            payload = {"equipment": verdict.get("title") or "equipment",
                       "issue": verdict.get("summary") or "", "recurring": False}
        else:
            payload = {"text": verdict.get("summary") or verdict.get("title") or "field photo",
                       **({"field_id": str(field.id)} if field else {})}
        ambiguities = []
        if target_type == "field_operation" and field is None:
            ambiguities.append({"key": "field_id", "question": "No GPS on this photo — which field?"})
        results.append(
            ParseResult(
                capture_event_id=capture.id,
                seq=0,
                target_type=target_type,
                extracted=payload,
                confidence=0.7,
                model_used=verdict["_model"],
                prompt_version=CLASSIFY_PROMPT_VERSION,
                ambiguities=ambiguities,
            )
        )

    session.add_all(results)
    return results
