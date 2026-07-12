"""Budget vs actual + per-field breakeven: allocation math, proration,
and the insufficient-data honesty rule."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

pytestmark = pytest.mark.db

YEAR = 2031  # isolated test year so other tests' data can't skew the math


def _setup(app_and_engine):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import BudgetLine, CropYear, Farm, FarmProfile, Field, FieldOperation, MoneyTransaction

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        profile = s.query(FarmProfile).first()
        if profile is None:
            profile = FarmProfile(operation_name="Fin Test Farm")
            s.add(profile)
            s.flush()
        farm = s.scalar(select(Farm).where(Farm.farm_number == "7700"))
        if farm is None:
            farm = Farm(farm_profile_id=profile.id, farm_number="7700",
                        state_ansi_code="19", county_ansi_code="153")
            s.add(farm)
            s.flush()

        fields = {}
        for i, (name, acres) in enumerate([("Fin 100", 100.0), ("Fin 50", 50.0)]):
            f = s.scalar(select(Field).where(Field.name == name))
            if f is None:
                f = Field(
                    farm_id=farm.id, tract_number="7701", field_number=str(i + 1), name=name,
                    boundary="SRID=4326;MULTIPOLYGON(((-93.7 42.3,-93.69 42.3,-93.69 42.31,-93.7 42.31,-93.7 42.3)))",
                    gis_acres=acres, clu_calculated_acres=acres, source="manual",
                )
                s.add(f)
                s.flush()
            fields[name] = f

        # both fields corn in YEAR: 100 + 50 acres
        for name, acres in [("Fin 100", 100), ("Fin 50", 50)]:
            if not s.scalar(select(CropYear).where(CropYear.field_id == fields[name].id, CropYear.crop_year == YEAR)):
                s.add(CropYear(field_id=fields[name].id, crop_year=YEAR, crop_code="0041",
                               crop_name="corn", reported_acres=acres))

        # budget: corn $400/ac
        if not s.scalar(select(BudgetLine).where(BudgetLine.crop_year == YEAR)):
            s.add(BudgetLine(crop_year=YEAR, crop="corn", category="all-in", amount_per_acre=400))

        # costs: $9,000 crop-level corn + $1,500 direct to Fin 100
        s.add(MoneyTransaction(occurred_on=datetime(YEAR, 4, 1).date(), description="seed corn",
                               kind="expense", category="seed", amount=9000, crop="corn"))
        s.add(MoneyTransaction(occurred_on=datetime(YEAR, 6, 1).date(), description="Fin 100 custom spray",
                               kind="expense", category="custom_hire", amount=1500,
                               field_id=fields["Fin 100"].id))
        s.add(MoneyTransaction(occurred_on=datetime(YEAR, 11, 1).date(), description="corn sale",
                               kind="income", category="grain", amount=30000, crop="corn"))

        # harvest ONLY on Fin 100: 200 bu/ac on 100 ac = 20,000 bu
        s.add(FieldOperation(field_id=fields["Fin 100"].id, op_type="harvest",
                             occurred_at=datetime(YEAR, 10, 20, tzinfo=timezone.utc),
                             acres_covered=100, details={"yield_bu_per_ac": 200}))
        s.commit()


def test_summary_and_breakeven(client, auth_headers, app_and_engine):
    _setup(app_and_engine)
    r = client.get(f"/api/v1/financials/summary?year={YEAR}", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()

    corn = next(c for c in body["crops"] if c["crop"] == "corn")
    assert corn["acres"] == 150.0
    assert corn["budget_per_acre"] == 400
    assert corn["budget_total"] == 60000.0
    assert corn["actual_spend"] == 9000.0  # crop-level only; direct-to-field spend isn't crop-tagged
    assert corn["income"] == 30000.0

    fin100 = next(f for f in body["fields"] if f["field_name"] == "Fin 100")
    # allocated = 1500 direct + 9000 * (100/150) = 7500
    assert fin100["allocated_costs"] == 7500.0
    assert fin100["harvested_bushels"] == 20000.0
    assert fin100["breakeven_per_bu"] == round(7500 / 20000, 2)
    assert fin100["insufficient_data"] is None

    fin50 = next(f for f in body["fields"] if f["field_name"] == "Fin 50")
    # allocated = 9000 * (50/150) = 3000, but NO harvest -> no breakeven, honest reasons
    assert fin50["allocated_costs"] == 3000.0
    assert fin50["breakeven_per_bu"] is None
    assert "no harvest record with yield" in fin50["insufficient_data"]


SF_YEAR = 2032  # isolated from the summary/breakeven setup above


def _seed_schedule_f_txns(app_and_engine):
    from datetime import datetime

    from sqlalchemy.orm import Session

    from app.models import MoneyTransaction

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        rows = [
            ("corn sale", "income", "grain", 50000),  # -> line 2
            ("seed corn", "expense", "seed", 10000),  # -> line 26
            ("fall NH3", "expense", "fertilizer", 8000),  # -> line 17
            ("burndown", "expense", "herbicide", 3000),  # -> line 11
            ("misc", "expense", "other", 500),  # -> uncategorized (default 'other')
            ("mystery", "expense", "widgets", 250),  # -> uncategorized (unknown)
        ]
        for desc, kind, cat, amt in rows:
            s.add(MoneyTransaction(occurred_on=datetime(SF_YEAR, 3, 1).date(), description=desc,
                                   kind=kind, category=cat, amount=amt))
        s.commit()


def test_schedule_f_line_mapping_and_uncategorized(client, auth_headers, app_and_engine):
    _seed_schedule_f_txns(app_and_engine)
    r = client.get(f"/api/v1/financials/schedule-f?year={SF_YEAR}", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()

    # cited tax-pack metadata rides along
    assert body["form"]["form"].startswith("Schedule F")
    assert body["form"]["source_url"].startswith("https://")

    income = {ln["line"]: ln["amount"] for ln in body["income_lines"]}
    expense = {ln["line"]: ln["amount"] for ln in body["expense_lines"]}
    assert income["2"] == 50000.0
    assert expense["26"] == 10000.0
    assert expense["17"] == 8000.0
    assert expense["11"] == 3000.0

    # totals cover ONLY categorized money; the $750 uncategorized is excluded
    assert body["totals"]["gross_income"] == 50000.0
    assert body["totals"]["total_expenses"] == 21000.0
    assert body["totals"]["net_farm_profit"] == 29000.0

    uncat = {u["category"]: u["amount"] for u in body["uncategorized"]["expense"]}
    assert uncat == {"other": 500.0, "widgets": 250.0}
    assert body["uncategorized"]["expense_total"] == 750.0
    assert body["complete"] is False
    assert "uncategorized" in body["note"].lower()


def test_transaction_crud_and_idempotency(client, auth_headers):
    cid = str(uuid.uuid4())
    body = {"client_id": cid, "occurred_on": f"{YEAR}-05-05", "description": "twine",
            "kind": "expense", "category": "supplies", "amount": 42.5}
    r = client.post("/api/v1/transactions", json=body, headers=auth_headers)
    assert r.status_code == 201
    tid = r.json()["id"]
    r2 = client.post("/api/v1/transactions", json=body, headers=auth_headers)
    assert r2.json()["id"] == tid  # offline replay safe

    txns = client.get(f"/api/v1/transactions?year={YEAR}", headers=auth_headers).json()
    assert any(t["id"] == tid for t in txns)
