"""Grain position ledger — the single most important marketing screen,
and it must always be CORRECT, which here means: derived from actual
records (harvest operations, confirmed scale tickets, entered contracts),
with every number's source stated and gaps flagged rather than papered
over. This is Phase 4's records slice — no advice, no recommendations
(store-vs-sell analysis is deferred pending the education/advice framing
decision).

Storage capacity comes from the farm profile's per-crop config and drives
the posture readout: unstored bushels must move at harvest or be
contracted ahead; stored bushels can wait.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import CropYear, Document, FarmProfile, Field, FieldOperation, GrainContract

CROP_ALIASES = {"soybean": "soybeans", "beans": "soybeans"}


def _norm(crop: str | None) -> str:
    c = (crop or "").strip().lower()
    return CROP_ALIASES.get(c, c)


def position(session: Session, year: int) -> dict:
    profile = session.scalars(select(FarmProfile)).first()
    storage_by_crop = {}
    for crop, cfg in ((profile.crops or {}) if profile else {}).items():
        storage_by_crop[_norm(crop)] = (cfg or {}).get("storage_bu")

    fields = {f.id: f for f in session.scalars(select(Field))}
    crop_by_field: dict = {}
    for cy in session.scalars(select(CropYear).where(CropYear.crop_year == year)):
        crop_by_field[cy.field_id] = _norm(cy.crop_name)

    # produced: harvest operations with yields
    produced: dict[str, float] = defaultdict(float)
    produced_sources: dict[str, int] = defaultdict(int)
    harvests = session.scalars(
        select(FieldOperation).where(
            FieldOperation.op_type == "harvest",
            FieldOperation.occurred_at >= date(year, 1, 1),
            FieldOperation.occurred_at <= date(year, 12, 31),
        )
    ).all()
    for op in harvests:
        ypa = (op.details or {}).get("yield_bu_per_ac")
        if ypa is None:
            continue
        acres = op.acres_covered
        if acres is None:
            f = fields.get(op.field_id)
            acres = float(f.clu_calculated_acres or f.gis_acres or 0) if f else 0
        crop = _norm((op.details or {}).get("crop")) or crop_by_field.get(op.field_id, "")
        if not crop:
            crop = "unknown"
        produced[crop] += float(ypa) * float(acres)
        produced_sources[crop] += 1

    # delivered: confirmed scale tickets with net bushels
    delivered: dict[str, float] = defaultdict(float)
    ticket_count: dict[str, int] = defaultdict(int)
    tickets = session.scalars(
        select(Document).where(Document.doc_type == "scale_ticket", Document.extracted.isnot(None))
    ).all()
    for t in tickets:
        ex = t.extracted or {}
        net = ex.get("net_bushels")
        t_year = str(ex.get("date") or "")[:4]
        if net is None or (t_year and t_year != str(year)):
            continue
        crop = _norm(ex.get("commodity")) or "unknown"
        try:
            delivered[crop] += float(net)
            ticket_count[crop] += 1
        except (TypeError, ValueError):
            continue

    # contracted / priced: contracts
    contracted: dict[str, float] = defaultdict(float)
    priced: dict[str, float] = defaultdict(float)
    for c in session.scalars(select(GrainContract).where(GrainContract.crop_year == year)):
        crop = _norm(c.crop)
        contracted[crop] += float(c.bushels)
        if c.price_per_bu is not None:
            priced[crop] += float(c.bushels)

    crops = sorted(set(produced) | set(delivered) | set(contracted) | set(storage_by_crop) - {""})
    out = []
    for crop in crops:
        p = round(produced.get(crop, 0.0), 1)
        d = round(delivered.get(crop, 0.0), 1)
        k = round(contracted.get(crop, 0.0), 1)
        pr = round(priced.get(crop, 0.0), 1)
        storage = storage_by_crop.get(crop)
        gaps = []
        if p == 0:
            gaps.append("no harvest records with yields — produced is unknown, not zero")
        if storage is None:
            gaps.append("storage capacity not set in farm profile")
        out.append(
            {
                "crop": crop,
                "produced_bu": p or None,
                "in_bin_bu": round(max(p - d, 0.0), 1) if p else None,
                "delivered_bu": d,
                "contracted_bu": k,
                "priced_bu": pr,
                "unpriced_bu": round(max(p - pr, 0.0), 1) if p else None,
                "storage_capacity_bu": storage,
                "posture": (
                    "stored grain can wait for carry/basis"
                    if storage and p and p - d <= storage
                    else "bushels beyond storage must be contracted ahead or moved at harvest"
                    if p and storage is not None
                    else None
                ),
                "sources": {
                    "harvest_records": produced_sources.get(crop, 0),
                    "scale_tickets": ticket_count.get(crop, 0),
                },
                "gaps": gaps or None,
            }
        )
    return {"year": year, "crops": out,
            "note": "Every number derives from records on this box; gaps are named, never estimated."}
