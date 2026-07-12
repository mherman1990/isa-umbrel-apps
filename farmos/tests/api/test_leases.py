"""Lease CRUD (the newly wired entity) + operating-mode scenarios."""
from __future__ import annotations

import uuid

import pytest

pytestmark = pytest.mark.db


def _make_field(app_and_engine):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import Farm, FarmProfile, Field

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        profile = s.query(FarmProfile).first()
        if profile is None:
            profile = FarmProfile(operation_name="Lease Farm")
            s.add(profile)
            s.flush()
        farm = s.scalar(select(Farm).where(Farm.farm_number == "4646"))
        if farm is None:
            farm = Farm(farm_profile_id=profile.id, farm_number="4646", state_ansi_code="19", county_ansi_code="169")
            s.add(farm)
            s.flush()
        field = s.scalar(select(Field).where(Field.name == "Lease Field"))
        if field is None:
            field = Field(
                farm_id=farm.id, tract_number="4647", field_number="1", name="Lease Field",
                boundary="SRID=4326;MULTIPOLYGON(((-93.7 42.3,-93.69 42.3,-93.69 42.31,-93.7 42.31,-93.7 42.3)))",
                gis_acres=120, clu_calculated_acres=120, source="manual",
            )
            s.add(field)
            s.flush()
        fid = str(field.id)
        s.commit()
        return fid


def test_lease_crud_and_idempotency(client, auth_headers, app_and_engine):
    field_id = _make_field(app_and_engine)
    cid = str(uuid.uuid4())
    body = {"client_id": cid, "field_id": field_id, "lease_type": "cash_rent",
            "landlord_name": "Iverson Trust", "producer_share": 1.0, "rent_per_acre": 285,
            "start_date": "2026-01-01"}
    r = client.post("/api/v1/leases", headers=auth_headers, json=body)
    assert r.status_code == 201, r.text
    lid = r.json()["id"]
    assert client.post("/api/v1/leases", headers=auth_headers, json=body).json()["id"] == lid  # idempotent

    listed = client.get(f"/api/v1/leases?field_id={field_id}", headers=auth_headers).json()
    assert any(x["id"] == lid and x["rent_per_acre"] == 285.0 for x in listed)

    patched = client.patch(f"/api/v1/leases/{lid}", headers=auth_headers, json={"rent_per_acre": 300})
    assert patched.json()["rent_per_acre"] == 300.0

    assert client.delete(f"/api/v1/leases/{lid}", headers=auth_headers).status_code == 204
    assert not any(x["id"] == lid for x in client.get("/api/v1/leases", headers=auth_headers).json())

    # unknown field -> 422; unknown lease -> 404
    assert client.post("/api/v1/leases", headers=auth_headers, json={
        "field_id": str(uuid.uuid4()), "lease_type": "owned", "start_date": "2026-01-01"}).status_code == 422
    assert client.patch(f"/api/v1/leases/{uuid.uuid4()}", headers=auth_headers,
                        json={"rent_per_acre": 1}).status_code == 404


def test_operating_mode_scenarios(client, auth_headers):
    r = client.post("/api/v1/financials/scenarios", headers=auth_headers, json={
        "acres": 100, "yield_bu_per_ac": 200, "price_per_bu": 4.50, "operating_cost_per_ac": 400,
        "cash_rent_per_acre": 280, "producer_share": 0.5, "landlord_cost_share": 0.5})
    assert r.status_code == 200, r.text
    body = r.json()
    by_mode = {s["mode"]: s for s in body["scenarios"]}
    assert by_mode["self_farm"]["net_income"] == 50000.0 and by_mode["self_farm"]["cash_outlay"] == 40000.0
    assert by_mode["cash_rent"]["net_income"] == 22000.0 and by_mode["cash_rent"]["cash_outlay"] == 68000.0
    # landlord_cost_share defaults to 1 - producer_share = 0.5
    assert by_mode["crop_share"]["net_income"] == 25000.0 and by_mode["crop_share"]["cash_outlay"] == 20000.0

    # comparative verdict is allowed on this app (D4), but it's arithmetic on inputs
    assert body["verdict"]["highest_net"]["mode"] == "self_farm"
    assert body["verdict"]["lowest_cash_outlay"]["mode"] == "crop_share"

    # missing params -> that structure is omitted with a gap, never fabricated
    r2 = client.post("/api/v1/financials/scenarios", headers=auth_headers, json={
        "acres": 100, "yield_bu_per_ac": 200, "price_per_bu": 4.5, "operating_cost_per_ac": 400})
    b2 = r2.json()
    assert [s["mode"] for s in b2["scenarios"]] == ["self_farm"]
    assert b2["gaps"] and any("cash_rent_per_acre" in g for g in b2["gaps"])

    # invalid input (share > 1) -> 422 validation, not a bogus number
    assert client.post("/api/v1/financials/scenarios", headers=auth_headers, json={
        "acres": 100, "yield_bu_per_ac": 200, "price_per_bu": 4.5, "operating_cost_per_ac": 400,
        "producer_share": 1.5}).status_code == 422
