"""Cash-flow projection + operating-line ledger (real PostGIS)."""
from __future__ import annotations

import uuid
from datetime import date

import pytest

pytestmark = pytest.mark.db

CF_YEAR = 2040   # projection test's own year (unused elsewhere; engine is session-scoped)
LOAN_YEAR = 2041  # operating-line test's own year (isolated from CF_YEAR)


def _setup_cashflow(app_and_engine):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import BudgetLine, CropYear, Farm, FarmProfile, Field, GrainContract

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        profile = s.query(FarmProfile).first()
        if profile is None:
            profile = FarmProfile(operation_name="CF Farm")
            s.add(profile)
            s.flush()
        farm = s.scalar(select(Farm).where(Farm.farm_number == "8180"))
        if farm is None:
            farm = Farm(farm_profile_id=profile.id, farm_number="8180", state_ansi_code="19", county_ansi_code="169")
            s.add(farm)
            s.flush()
        field = s.scalar(select(Field).where(Field.name == "CF Field 8180"))
        if field is None:
            field = Field(
                farm_id=farm.id, tract_number="8181", field_number="1", name="CF Field 8180",
                boundary="SRID=4326;MULTIPOLYGON(((-93.7 42.3,-93.69 42.3,-93.69 42.31,-93.7 42.31,-93.7 42.3)))",
                gis_acres=100, clu_calculated_acres=100, source="manual",
            )
            s.add(field)
            s.flush()
        if not s.scalar(select(CropYear).where(CropYear.field_id == field.id, CropYear.crop_year == CF_YEAR)):
            s.add(CropYear(field_id=field.id, crop_year=CF_YEAR, crop_code="0041", crop_name="corn", reported_acres=100))
        if not s.scalar(select(BudgetLine).where(BudgetLine.crop_year == CF_YEAR)):
            s.add(BudgetLine(crop_year=CF_YEAR, crop="corn", category="seed", amount_per_acre=100))
            s.add(BudgetLine(crop_year=CF_YEAR, crop="corn", category="fertilizer", amount_per_acre=80))
        if not s.scalar(select(GrainContract).where(GrainContract.crop_year == CF_YEAR)):
            # priced corn contract (delivered Nov) + an unpriced soybean contract (gap)
            s.add(GrainContract(crop="corn", crop_year=CF_YEAR, contract_type="cash", bushels=10000,
                                price_per_bu=4.50, delivery_start=date(CF_YEAR, 11, 1), delivery_end=date(CF_YEAR, 11, 30)))
            s.add(GrainContract(crop="soybeans", crop_year=CF_YEAR, contract_type="hta", bushels=5000, price_per_bu=None))
        s.commit()


def test_cash_flow_projection(client, auth_headers, app_and_engine):
    _setup_cashflow(app_and_engine)
    body = client.get(f"/api/v1/financials/cash-flow?year={CF_YEAR}", headers=auth_headers).json()

    # outflow = (100 seed + 80 fert) * 100 ac; inflow = 10000 bu * $4.50
    assert body["planned_outflow_total"] == 18000.0
    assert body["planned_inflow_total"] == 45000.0

    by_month = {m["month"]: m for m in body["months"]}
    assert by_month[11]["planned_in"] == 45000.0  # single-month delivery window
    assert by_month[4]["planned_out"] == 10700.0  # seed 7500 (0.75) + fert 3200 (0.40)

    # deepest cumulative deficit before grain sells = peak operating need
    assert body["peak_operating_need_usd"] == 16800.0

    # honesty: unpriced contract is surfaced, never projected
    assert any("unpriced" in g for g in body["gaps"])
    assert body["timing_pack"]["source_url"].startswith("https://")
    assert body["operating_line"]["outstanding_balance_usd"] == 0.0  # no loan tied to CF_YEAR


def test_operating_line_ledger_and_idempotency(client, auth_headers):
    cid = str(uuid.uuid4())
    loan = client.post("/api/v1/operating-loans", headers=auth_headers, json={
        "client_id": cid, "name": "FCS operating line", "lender": "Farm Credit",
        "credit_limit_usd": 200000, "interest_rate_pct": 7.75, "crop_year": LOAN_YEAR,
    })
    assert loan.status_code == 201, loan.text
    loan_id = loan.json()["id"]
    # offline replay is idempotent
    assert client.post("/api/v1/operating-loans", headers=auth_headers, json={
        "client_id": cid, "name": "FCS operating line", "credit_limit_usd": 200000,
    }).json()["id"] == loan_id

    for etype, amt, when in [("draw", 100000, f"{LOAN_YEAR}-04-15"),
                             ("interest", 2000, f"{LOAN_YEAR}-11-01"),
                             ("paydown", 30000, f"{LOAN_YEAR}-12-01")]:
        r = client.post(f"/api/v1/operating-loans/{loan_id}/events", headers=auth_headers,
                        json={"occurred_on": when, "event_type": etype, "amount": amt})
        assert r.status_code == 201, r.text

    status = client.get(f"/api/v1/operating-loans?year={LOAN_YEAR}", headers=auth_headers).json()
    mine = next(l for l in status["loans"] if l["id"] == loan_id)
    assert mine["outstanding_balance_usd"] == 72000.0  # 100000 + 2000 - 30000
    assert mine["available_usd"] == 128000.0
    assert mine["over_limit"] is False
    assert mine["event_count"] == 3

    # the cash-flow view for that year reflects the same derived balance
    cf = client.get(f"/api/v1/financials/cash-flow?year={LOAN_YEAR}", headers=auth_headers).json()
    assert cf["operating_line"]["outstanding_balance_usd"] == 72000.0

    # event on an unknown loan is a 404, not a silent create
    bad = client.post(f"/api/v1/operating-loans/{uuid.uuid4()}/events", headers=auth_headers,
                      json={"occurred_on": f"{LOAN_YEAR}-04-15", "event_type": "draw", "amount": 1000})
    assert bad.status_code == 404
