"""RUP record compliance: pack-driven required fields, honest missing
lists, complete-record detection."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

pytestmark = pytest.mark.db

YEAR = 2033


def _setup(app_and_engine):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import (AppUser, Farm, FarmProfile, Field, FieldOperation,
                            OperationProduct, Product)

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        profile = s.query(FarmProfile).first() or FarmProfile(operation_name="RUP Farm")
        s.add(profile)
        s.flush()
        farm = s.scalar(select(Farm)) or Farm(farm_profile_id=profile.id, farm_number="2200",
                                              state_ansi_code="19", county_ansi_code="153")
        s.add(farm)
        s.flush()
        field = s.scalar(select(Field).where(Field.name == "RUP 40"))
        if field is None:
            field = Field(farm_id=farm.id, tract_number="2201", field_number="1", name="RUP 40",
                          boundary="SRID=4326;MULTIPOLYGON(((-93.2 42.8,-93.19 42.8,-93.19 42.81,-93.2 42.81,-93.2 42.8)))",
                          gis_acres=40, clu_calculated_acres=40, source="manual")
            s.add(field)
            s.flush()
        user = s.query(AppUser).first()

        rup = Product(name="Atrazine 4L Test", category="herbicide", epa_reg_number="100-497",
                      default_unit="qt")
        plain = Product(name="Plain Glyphosate Test", category="herbicide", default_unit="qt")
        s.add_all([rup, plain])
        s.flush()

        # complete RUP record
        op1 = FieldOperation(field_id=field.id, op_type="spray", operator_user_id=user.id,
                             occurred_at=datetime(YEAR, 5, 10, tzinfo=timezone.utc),
                             acres_covered=40,
                             details={"crop": "corn", "applicator": "Matt H",
                                      "applicator_certification": "IA-PA-12345"})
        s.add(op1)
        s.flush()
        s.add(OperationProduct(operation_id=op1.id, product_id=rup.id, rate=2, rate_unit="qt/ac",
                               total_quantity=80, unit="qt"))

        # incomplete RUP record (no certification, no total, no crop)
        op2 = FieldOperation(field_id=field.id, op_type="spray", operator_user_id=user.id,
                             occurred_at=datetime(YEAR, 6, 1, tzinfo=timezone.utc), details={})
        s.add(op2)
        s.flush()
        s.add(OperationProduct(operation_id=op2.id, product_id=rup.id, rate=2, rate_unit="qt/ac"))

        # non-RUP spray — must NOT appear
        op3 = FieldOperation(field_id=field.id, op_type="spray",
                             occurred_at=datetime(YEAR, 6, 2, tzinfo=timezone.utc), details={})
        s.add(op3)
        s.flush()
        s.add(OperationProduct(operation_id=op3.id, product_id=plain.id, rate=32, rate_unit="oz/ac"))
        s.commit()


def test_rup_compliance_report(client, auth_headers, app_and_engine):
    _setup(app_and_engine)
    r = client.get(f"/api/v1/compliance/rup?year={YEAR}", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is True
    assert body["retention_years"] == 2
    assert "136i-1" in body["citation"]
    assert body["summary"]["total"] == 2  # only RUP products

    complete = next(rec for rec in body["records"] if rec["complete"])
    assert complete["values"]["applicator_certification"] == "IA-PA-12345"
    assert complete["values"]["epa_reg_number"] == "100-497"

    incomplete = next(rec for rec in body["records"] if not rec["complete"])
    assert "applicator_certification" in incomplete["missing"]
    assert "total_amount" in incomplete["missing"]
    assert "crop" in incomplete["missing"]
