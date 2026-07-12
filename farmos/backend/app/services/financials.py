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
from ..tax_packs.loader import load_schedule_f


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


def operating_mode_scenarios(
    *,
    acres: float,
    yield_bu_per_ac: float,
    price_per_bu: float,
    operating_cost_per_ac: float,
    cash_rent_per_acre: float | None = None,
    producer_share: float | None = None,
    landlord_cost_share: float | None = None,
) -> dict:
    """Compare the producer's net income AND cash outlay under each tenure
    structure (own / cash-rent / crop-share) for a given set of assumptions.

    Every figure derives from the inputs the farmer entered — nothing is
    invented; a structure whose parameter is missing is omitted with a gap.
    (Per the product owner, there is no education-not-advice limit on this
    app, so a plain comparative verdict is included — but it is arithmetic on
    the given numbers, not a fabricated recommendation.)
    """
    gross = acres * yield_bu_per_ac * price_per_bu
    opcost = acres * operating_cost_per_ac

    def row(mode: str, label: str, prod_revenue: float, prod_cost: float, rent: float, share: float) -> dict:
        net = prod_revenue - prod_cost - rent
        cash = prod_cost + rent
        return {
            "mode": mode,
            "label": label,
            "producer_share": round(share, 4),
            "gross_revenue": round(gross, 2),
            "producer_revenue": round(prod_revenue, 2),
            "producer_operating_cost": round(prod_cost, 2),
            "cash_rent": round(rent, 2),
            "net_income": round(net, 2),
            "cash_outlay": round(cash, 2),
            "net_per_acre": round(net / acres, 2) if acres else None,
            "cash_outlay_per_acre": round(cash / acres, 2) if acres else None,
        }

    scenarios = [row("self_farm", "Own the ground", gross, opcost, 0.0, 1.0)]
    gaps: list[str] = []

    if cash_rent_per_acre is not None:
        scenarios.append(
            row("cash_rent", f"Cash rent ${cash_rent_per_acre:,.0f}/ac", gross, opcost, acres * cash_rent_per_acre, 1.0)
        )
    else:
        gaps.append("cash_rent_per_acre not provided — cash-rent scenario omitted")

    if producer_share is not None:
        lc = landlord_cost_share if landlord_cost_share is not None else (1 - producer_share)
        scenarios.append(
            row(
                "crop_share",
                f"Crop share (you keep {producer_share:.0%})",
                producer_share * gross,
                (1 - lc) * opcost,
                0.0,
                producer_share,
            )
        )
    else:
        gaps.append("producer_share not provided — crop-share scenario omitted")

    verdict = None
    if len(scenarios) >= 2:
        best_net = max(scenarios, key=lambda s: s["net_income"])
        least_cash = min(scenarios, key=lambda s: s["cash_outlay"])
        verdict = {
            "highest_net": {"mode": best_net["mode"], "net_income": best_net["net_income"]},
            "lowest_cash_outlay": {"mode": least_cash["mode"], "cash_outlay": least_cash["cash_outlay"]},
            "summary": (
                f"On these numbers, '{best_net['label']}' nets the most "
                f"(${best_net['net_income']:,.0f}); '{least_cash['label']}' needs the least cash up front "
                f"(${least_cash['cash_outlay']:,.0f})."
            ),
        }

    return {
        "inputs": {
            "acres": acres,
            "yield_bu_per_ac": yield_bu_per_ac,
            "price_per_bu": price_per_bu,
            "operating_cost_per_ac": operating_cost_per_ac,
            "cash_rent_per_acre": cash_rent_per_acre,
            "producer_share": producer_share,
            "landlord_cost_share": landlord_cost_share,
        },
        "scenarios": scenarios,
        "verdict": verdict,
        "gaps": gaps or None,
        "note": (
            "Every figure is arithmetic on the assumptions you entered — change an input and re-run. "
            "This compares the mechanics of each tenure structure; it is not a substitute for your own judgment."
        ),
    }


def schedule_f(session: Session, year: int) -> dict:
    """Whole-farm income/expense rolled up to Schedule F (Form 1040) lines.

    The line map is versioned tax-pack DATA (`tax_packs/schedule-f-*.yaml`).
    Only categories the pack recognizes land on a line; anything else is
    surfaced in `uncategorized` and left OUT of the totals — the app never
    guesses a dollar onto a tax line. The farmer closes the gap by giving
    the transaction a recognized category (edit/allocate — WS4).
    """
    sfmap = load_schedule_f(year)
    pack = sfmap.pack

    txns = session.scalars(
        select(MoneyTransaction).where(
            MoneyTransaction.occurred_on >= date(year, 1, 1),
            MoneyTransaction.occurred_on <= date(year, 12, 31),
        )
    ).all()

    income_by_line: dict[str, float] = defaultdict(float)
    expense_by_line: dict[str, float] = defaultdict(float)
    uncat_income: dict[str, float] = defaultdict(float)
    uncat_expense: dict[str, float] = defaultdict(float)

    for t in txns:
        amount = float(t.amount)
        hit = sfmap.classify(t.kind, t.category)
        if t.kind == "income":
            if hit:
                income_by_line[hit.line] += amount
            else:
                uncat_income[(t.category or "other").lower()] += amount
        else:
            if hit:
                expense_by_line[hit.line] += amount
            else:
                uncat_expense[(t.category or "other").lower()] += amount

    income_lines, expense_lines = [], []
    for section, line, name in sfmap.line_order():
        if section == "income" and income_by_line.get(line):
            income_lines.append({"line": line, "name": name, "amount": round(income_by_line[line], 2)})
        elif section == "expense" and expense_by_line.get(line):
            expense_lines.append({"line": line, "name": name, "amount": round(expense_by_line[line], 2)})

    gross_income = round(sum(income_by_line.values()), 2)
    total_expenses = round(sum(expense_by_line.values()), 2)

    uncat_income_list = [{"category": c, "amount": round(a, 2)} for c, a in sorted(uncat_income.items())]
    uncat_expense_list = [{"category": c, "amount": round(a, 2)} for c, a in sorted(uncat_expense.items())]
    uncat_total = round(sum(uncat_income.values()) + sum(uncat_expense.values()), 2)
    complete = bool(txns) and not uncat_income_list and not uncat_expense_list

    if not txns:
        note = "No transactions recorded for this year yet."
    elif complete:
        note = "Every recorded transaction is mapped to a Schedule F line."
    else:
        note = (
            f"${uncat_total:,.2f} is uncategorized and is NOT included in the totals — assign each "
            "transaction a recognized category to roll it onto a line. Nothing is guessed."
        )

    return {
        "year": year,
        "form": {
            "form": pack.form,
            "tax_year": pack.tax_year,
            "version": pack.version,
            "source_url": pack.source_url,
            "last_verified": pack.last_verified.isoformat(),
            "verify_by": pack.verify_by.isoformat(),
            "stale": pack.verify_by < date.today(),
        },
        "income_lines": income_lines,
        "expense_lines": expense_lines,
        "totals": {
            "gross_income": gross_income,  # Schedule F line 9
            "total_expenses": total_expenses,  # line 33
            "net_farm_profit": round(gross_income - total_expenses, 2),  # line 34
        },
        "uncategorized": {
            "income": uncat_income_list,
            "expense": uncat_expense_list,
            "income_total": round(sum(uncat_income.values()), 2),
            "expense_total": round(sum(uncat_expense.values()), 2),
        },
        "complete": complete,
        "note": note,
    }
