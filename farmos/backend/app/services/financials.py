"""Budget vs actual and breakeven — honest numbers only.

Breakeven $/bu per field = allocated costs / harvested bushels. Costs are
(a) transactions tied directly to the field, plus (b) crop-level
transactions prorated by the field's share of that crop's acres. When a
piece is missing (no harvest record, no costs, no acres) the answer is
"insufficient data" with the reasons listed — never a fabricated number
(Hard Requirement #5's financial cousin).
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import BudgetLine, CropYear, Field, FieldOperation, MoneyTransaction


def crop_summary(session: Session, year: int) -> list[dict]:
    """Per-crop: planted acres, budget total, actual spend, income."""
    crop_years = session.scalars(select(CropYear).where(CropYear.crop_year == year)).all()
    acres_by_crop: dict[str, float] = defaultdict(float)
    for cy in crop_years:
        acres_by_crop[cy.crop_name.lower()] += float(cy.reported_acres)

    budget = session.scalars(select(BudgetLine).where(BudgetLine.crop_year == year)).all()
    budget_by_crop: dict[str, float] = defaultdict(float)
    for b in budget:
        budget_by_crop[b.crop.lower()] += float(b.amount_per_acre)

    txns = session.scalars(
        select(MoneyTransaction).where(
            MoneyTransaction.occurred_on >= date(year, 1, 1),
            MoneyTransaction.occurred_on <= date(year, 12, 31),
        )
    ).all()
    spend_by_crop: dict[str, float] = defaultdict(float)
    income_by_crop: dict[str, float] = defaultdict(float)
    unallocated_spend = 0.0
    for t in txns:
        crop = (t.crop or "").lower()
        amount = float(t.amount)
        if t.kind == "income":
            income_by_crop[crop or "unallocated"] += amount
        elif crop:
            spend_by_crop[crop] += amount
        else:
            unallocated_spend += amount

    crops = sorted(set(acres_by_crop) | set(budget_by_crop) | set(spend_by_crop))
    out = []
    for crop in crops:
        acres = acres_by_crop.get(crop, 0.0)
        per_ac_budget = budget_by_crop.get(crop)
        out.append(
            {
                "crop": crop,
                "acres": round(acres, 1),
                "budget_per_acre": per_ac_budget,
                "budget_total": round(per_ac_budget * acres, 2) if per_ac_budget and acres else None,
                "actual_spend": round(spend_by_crop.get(crop, 0.0), 2),
                "income": round(income_by_crop.get(crop, 0.0), 2),
            }
        )
    return out + ([{"crop": "unallocated", "acres": 0, "budget_per_acre": None, "budget_total": None,
                    "actual_spend": round(unallocated_spend, 2), "income": round(income_by_crop.get("unallocated", 0.0), 2)}]
                  if unallocated_spend or income_by_crop.get("unallocated") else [])


def field_breakeven(session: Session, year: int) -> list[dict]:
    crop_years = session.scalars(select(CropYear).where(CropYear.crop_year == year)).all()
    fields = {f.id: f for f in session.scalars(select(Field).where(Field.archived_at.is_(None)))}

    # crop acreage shares for prorating crop-level transactions
    crop_total_acres: dict[str, float] = defaultdict(float)
    for cy in crop_years:
        crop_total_acres[cy.crop_name.lower()] += float(cy.reported_acres)

    txns = session.scalars(
        select(MoneyTransaction).where(
            MoneyTransaction.kind == "expense",
            MoneyTransaction.occurred_on >= date(year, 1, 1),
            MoneyTransaction.occurred_on <= date(year, 12, 31),
        )
    ).all()
    direct_by_field: dict = defaultdict(float)
    crop_level_spend: dict[str, float] = defaultdict(float)
    for t in txns:
        if t.field_id is not None:
            direct_by_field[t.field_id] += float(t.amount)
        elif t.crop:
            crop_level_spend[t.crop.lower()] += float(t.amount)

    harvests = session.scalars(
        select(FieldOperation).where(
            FieldOperation.op_type == "harvest",
            FieldOperation.occurred_at >= date(year, 1, 1),
            FieldOperation.occurred_at <= date(year, 12, 31),
        )
    ).all()
    bushels_by_field: dict = defaultdict(float)
    for op in harvests:
        ypa = (op.details or {}).get("yield_bu_per_ac")
        acres = op.acres_covered
        if ypa is None:
            continue
        if acres is None:
            f = fields.get(op.field_id)
            acres = float(f.clu_calculated_acres or f.gis_acres or 0) if f else 0
        bushels_by_field[op.field_id] += float(ypa) * float(acres)

    out = []
    for cy in crop_years:
        field = fields.get(cy.field_id)
        if field is None:
            continue
        crop = cy.crop_name.lower()
        acres = float(cy.reported_acres)
        share = acres / crop_total_acres[crop] if crop_total_acres.get(crop) else 0
        allocated = direct_by_field.get(cy.field_id, 0.0) + crop_level_spend.get(crop, 0.0) * share
        bushels = bushels_by_field.get(cy.field_id, 0.0)

        missing = []
        if allocated == 0:
            missing.append("no costs recorded for this field or crop")
        if bushels == 0:
            missing.append("no harvest record with yield")
        out.append(
            {
                "field_id": str(cy.field_id),
                "field_name": field.name or f"T{field.tract_number}/F{field.field_number}",
                "crop": crop,
                "crop_year": year,
                "acres": acres,
                "allocated_costs": round(allocated, 2) if allocated else None,
                "harvested_bushels": round(bushels, 1) if bushels else None,
                "breakeven_per_bu": round(allocated / bushels, 2) if allocated and bushels else None,
                "cost_per_acre": round(allocated / acres, 2) if allocated and acres else None,
                "insufficient_data": missing or None,
            }
        )
    return out
