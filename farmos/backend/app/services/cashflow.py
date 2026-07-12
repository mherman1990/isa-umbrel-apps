"""Cash-flow projection + operating-line status.

Projection philosophy (honest by construction):
- OUTFLOW is the farmer's OWN budget total ($/ac x planted acres), spread
  across the year by a cited typical-timing pack — the total is a record,
  the month-distribution is a labeled estimate.
- INFLOW counts ONLY priced grain contracts, placed in their delivery
  window. Unpriced contracts and uncontracted production are NOT projected —
  they are surfaced as gaps.
- The operating-line balance is DERIVED from the draw/paydown ledger, never
  entered. The deepest cumulative cash deficit is the peak operating need.
"""
from __future__ import annotations

from calendar import month_abbr
from collections import defaultdict
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..cashflow_packs.loader import load_cashflow_timing
from ..models import BudgetLine, CropYear, GrainContract, MoneyTransaction, OperatingLoan, OperatingLoanEvent
from . import grain


def _months_between(start: date | None, end: date | None, year: int) -> list[int]:
    """Calendar months (1-12) of a delivery window, clamped to `year`."""
    s = start or end
    e = end or start
    if s is None:
        return []
    lo = max(s, date(year, 1, 1))
    hi = min(e, date(year, 12, 31))
    if lo > hi:
        return []
    months = []
    y, m = lo.year, lo.month
    while (y, m) <= (hi.year, hi.month):
        months.append(m)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return months


def operating_line(session: Session, year: int) -> dict:
    """Per-loan outstanding balance, available credit, and the ledger.
    Includes loans tied to this crop_year and untied (crop_year NULL) lines."""
    loans = session.scalars(
        select(OperatingLoan)
        .where((OperatingLoan.crop_year == year) | (OperatingLoan.crop_year.is_(None)))
        .order_by(OperatingLoan.created_at)
    ).all()
    out = []
    for loan in loans:
        events = session.scalars(
            select(OperatingLoanEvent)
            .where(OperatingLoanEvent.loan_id == loan.id)
            .order_by(OperatingLoanEvent.occurred_on, OperatingLoanEvent.created_at)
        ).all()
        drawn = sum(float(e.amount) for e in events if e.event_type in ("draw", "interest"))
        paid = sum(float(e.amount) for e in events if e.event_type == "paydown")
        balance = round(drawn - paid, 2)
        limit = float(loan.credit_limit_usd)
        out.append(
            {
                "id": str(loan.id),
                "name": loan.name,
                "lender": loan.lender,
                "crop_year": loan.crop_year,
                "credit_limit_usd": limit,
                "interest_rate_pct": float(loan.interest_rate_pct) if loan.interest_rate_pct is not None else None,
                "outstanding_balance_usd": balance,
                "available_usd": round(limit - balance, 2),
                "over_limit": balance > limit,
                "event_count": len(events),
                "ledger": [
                    {
                        "id": str(e.id),
                        "occurred_on": e.occurred_on.isoformat(),
                        "event_type": e.event_type,
                        "amount": float(e.amount),
                        "description": e.description,
                    }
                    for e in events
                ],
            }
        )
    return {
        "year": year,
        "loans": out,
        "note": "Balances are derived from the draw/paydown ledger, never entered directly.",
    }


def cash_flow(session: Session, year: int) -> dict:
    timing = load_cashflow_timing()

    acres_by_crop: dict[str, float] = defaultdict(float)
    for cy in session.scalars(select(CropYear).where(CropYear.crop_year == year)):
        acres_by_crop[cy.crop_name.lower()] += float(cy.reported_acres)

    planned_out: dict[int, float] = defaultdict(float)
    planned_out_total = 0.0
    even_categories: set[str] = set()
    no_acre_crops: set[str] = set()
    budget = session.scalars(select(BudgetLine).where(BudgetLine.crop_year == year)).all()
    for b in budget:
        acres = acres_by_crop.get(b.crop.lower(), 0.0)
        if acres == 0:
            no_acre_crops.add(b.crop.lower())
            continue
        planned = float(b.amount_per_acre) * acres
        planned_out_total += planned
        weights, is_even = timing.weights(b.category)
        if is_even:
            even_categories.add(b.category)
        for m, w in weights.items():
            planned_out[m] += planned * w

    planned_in: dict[int, float] = defaultdict(float)
    planned_in_total = 0.0
    inflow_gaps: list[str] = []
    for c in session.scalars(select(GrainContract).where(GrainContract.crop_year == year)):
        if c.price_per_bu is None:
            inflow_gaps.append(f"{c.crop}: {float(c.bushels):,.0f} bu contracted but unpriced — inflow not projected")
            continue
        value = float(c.bushels) * float(c.price_per_bu)
        months = _months_between(c.delivery_start, c.delivery_end, year)
        if not months:
            inflow_gaps.append(f"{c.crop}: ${value:,.0f} priced but delivery window is missing/outside {year} — inflow not placed")
            continue
        per = value / len(months)
        for m in months:
            planned_in[m] += per
        planned_in_total += value

    # uncontracted production has no price or timing — surface, do not project
    for cr in grain.position(session, year)["crops"]:
        produced = cr.get("produced_bu")
        contracted = cr.get("contracted_bu") or 0
        if produced and produced - contracted > 0.5:
            inflow_gaps.append(
                f"{cr['crop']}: {produced - contracted:,.0f} bu produced but not contracted — sale timing/price unknown"
            )

    actual_in: dict[int, float] = defaultdict(float)
    actual_out: dict[int, float] = defaultdict(float)
    for t in session.scalars(
        select(MoneyTransaction).where(
            MoneyTransaction.occurred_on >= date(year, 1, 1),
            MoneyTransaction.occurred_on <= date(year, 12, 31),
        )
    ):
        bucket = actual_in if t.kind == "income" else actual_out
        bucket[t.occurred_on.month] += float(t.amount)

    months = []
    cumulative = 0.0
    trough = 0.0
    for m in range(1, 13):
        p_net = round(planned_in[m] - planned_out[m], 2)
        cumulative = round(cumulative + p_net, 2)
        trough = min(trough, cumulative)
        months.append(
            {
                "month": m,
                "label": month_abbr[m],
                "planned_in": round(planned_in[m], 2),
                "planned_out": round(planned_out[m], 2),
                "planned_net": p_net,
                "cumulative_planned_net": cumulative,
                "actual_in": round(actual_in[m], 2),
                "actual_out": round(actual_out[m], 2),
                "actual_net": round(actual_in[m] - actual_out[m], 2),
            }
        )

    op = operating_line(session, year)
    gaps = list(inflow_gaps)
    for crop in sorted(no_acre_crops):
        gaps.append(f"budget for '{crop}' has no planted acres in {year} — its cost is not projected")
    if not budget:
        gaps.append("no budget on record — planned outflow cannot be projected")

    return {
        "year": year,
        "months": months,
        "planned_outflow_total": round(planned_out_total, 2),
        "planned_inflow_total": round(planned_in_total, 2),
        "peak_operating_need_usd": round(-trough, 2),  # deepest cumulative cash deficit
        "operating_line": {
            "outstanding_balance_usd": round(sum(l["outstanding_balance_usd"] for l in op["loans"]), 2),
            "credit_limit_usd": round(sum(l["credit_limit_usd"] for l in op["loans"]), 2),
            "loans": op["loans"],
        },
        "timing_pack": {
            "region_code": timing.pack.region_code,
            "version": timing.pack.version,
            "source_url": timing.pack.source_url,
            "verify_by": timing.pack.verify_by.isoformat(),
            "stale": timing.pack.verify_by < date.today(),
        },
        "even_spread_categories": sorted(even_categories),
        "gaps": gaps or None,
        "note": (
            "Outflow spreads YOUR budget total across the year using typical Iowa timing "
            "(cited, not a record); inflow counts only priced contracts. Everything "
            "unprojectable is listed under gaps, never estimated."
        ),
    }
