"""Grain position ledger: produced from harvests, delivered from scale
tickets, contracted/priced from contracts, storage posture, honest gaps."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

pytestmark = pytest.mark.db

YEAR = 2034


def _setup(app_and_engine):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import CropYear, Document, Farm, FarmProfile, Field, FieldOperation

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        profile = s.query(FarmProfile).first() or FarmProfile(operation_name="Grain Farm")
        s.add(profile)
        s.flush()
        # reference posture: corn storage on-farm, no bean storage
        profile.crops = {"corn": {"acres": 100, "storage_bu": 30000}, "soybeans": {"acres": 50, "storage_bu": 0}}

        farm = s.scalar(select(Farm)) or Farm(farm_profile_id=profile.id, farm_number="1100",
                                              state_ansi_code="19", county_ansi_code="153")
        s.add(farm)
        s.flush()
        field = s.scalar(select(Field).where(Field.name == "Grain 100"))
        if field is None:
            field = Field(farm_id=farm.id, tract_number="1101", field_number="1", name="Grain 100",
                          boundary="SRID=4326;MULTIPOLYGON(((-93.1 42.9,-93.09 42.9,-93.09 42.91,-93.1 42.91,-93.1 42.9)))",
                          gis_acres=100, clu_calculated_acres=100, source="manual")
            s.add(field)
            s.flush()
        if not s.scalar(select(CropYear).where(CropYear.field_id == field.id, CropYear.crop_year == YEAR)):
            s.add(CropYear(field_id=field.id, crop_year=YEAR, crop_code="0041", crop_name="corn",
                           reported_acres=100))
        # 100 ac x 210 bu = 21,000 bu produced
        s.add(FieldOperation(field_id=field.id, op_type="harvest",
                             occurred_at=datetime(YEAR, 10, 15, tzinfo=timezone.utc),
                             acres_covered=100, details={"yield_bu_per_ac": 210}))
        # one confirmed scale ticket: 912.4 bu delivered
        s.add(Document(doc_type="scale_ticket", title="ticket 1",
                       file_path="artifacts/x.jpg",
                       extracted={"commodity": "corn", "net_bushels": 912.4, "date": f"{YEAR}-10-16"}))
        s.commit()


def test_position_ledger(client, auth_headers, app_and_engine):
    _setup(app_and_engine)

    # contract 5,000 bu cash @ 4.75 and 3,000 bu HTA unpriced
    for body in (
        {"crop": "corn", "crop_year": YEAR, "contract_type": "cash", "bushels": 5000, "price_per_bu": 4.75,
         "elevator": "Heartland"},
        {"crop": "corn", "crop_year": YEAR, "contract_type": "hta", "bushels": 3000},
    ):
        assert client.post("/api/v1/grain/contracts", json=body, headers=auth_headers).status_code == 201

    r = client.get(f"/api/v1/grain/position?year={YEAR}", headers=auth_headers)
    assert r.status_code == 200, r.text
    corn = next(c for c in r.json()["crops"] if c["crop"] == "corn")
    assert corn["produced_bu"] == 21000.0
    assert corn["delivered_bu"] == 912.4
    assert corn["in_bin_bu"] == 21000.0 - 912.4
    assert corn["contracted_bu"] == 8000.0
    assert corn["priced_bu"] == 5000.0
    assert corn["unpriced_bu"] == 16000.0
    assert corn["storage_capacity_bu"] == 30000
    assert "wait" in corn["posture"]  # in-bin fits storage
    assert corn["sources"] == {"harvest_records": 1, "scale_tickets": 1}

    beans = next(c for c in r.json()["crops"] if c["crop"] == "soybeans")
    assert beans["produced_bu"] is None  # no harvest records
    assert beans["gaps"] and "unknown, not zero" in beans["gaps"][0]


def test_contract_idempotency_and_delivery(client, auth_headers):
    cid = str(uuid.uuid4())
    body = {"client_id": cid, "crop": "corn", "crop_year": YEAR, "contract_type": "cash",
            "bushels": 1000, "price_per_bu": 4.5}
    first = client.post("/api/v1/grain/contracts", json=body, headers=auth_headers).json()
    again = client.post("/api/v1/grain/contracts", json=body, headers=auth_headers).json()
    assert first["id"] == again["id"]

    r = client.post(f"/api/v1/grain/contracts/{first['id']}/deliver", json={"bushels": 400}, headers=auth_headers)
    assert r.json()["delivered_bushels"] == 400.0
