"""FSA-578 view: CART/NIEM-named fields + honest completeness flags, and
the rotation matrix."""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.db


def _ensure_field_with_crop(app_and_engine):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import CropYear, Farm, FarmProfile, Field

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        profile = s.query(FarmProfile).first()
        if profile is None:
            profile = FarmProfile(operation_name="578 Test Farm")
            s.add(profile)
            s.flush()
        farm = s.scalar(select(Farm).where(Farm.farm_number == "5500"))
        if farm is None:
            farm = Farm(farm_profile_id=profile.id, farm_number="5500",
                        state_ansi_code="19", county_ansi_code="153")
            s.add(farm)
            s.flush()
        field = s.scalar(select(Field).where(Field.name == "FSA 80"))
        if field is None:
            field = Field(
                farm_id=farm.id, tract_number="5501", field_number="1", name="FSA 80",
                boundary="SRID=4326;MULTIPOLYGON(((-93.5 42.5,-93.49 42.5,-93.49 42.51,-93.5 42.51,-93.5 42.5)))",
                gis_acres=80, source="manual",
            )
            s.add(field)
            s.flush()
        if not s.scalar(select(CropYear).where(CropYear.field_id == field.id, CropYear.crop_year == 2032)):
            s.add(CropYear(field_id=field.id, crop_year=2032, crop_code="0041", crop_name="corn",
                           reported_acres=80))
        s.commit()


def test_fsa578_view_and_completeness(client, auth_headers, app_and_engine):
    _ensure_field_with_crop(app_and_engine)

    rows = client.get("/api/v1/crop-years?year=2032&format=fsa578", headers=auth_headers).json()
    row = next(r for r in rows if r["TractNumber"] == "5501")
    assert row["CropYear"] == 2032
    assert row["FarmNumber"] == "5500"
    assert row["CropCode"] == "0041"
    assert row["IntendedUse"] == "GR"
    assert row["ReportedAcreage"] == 80.0
    assert row["ProducerShare"] == 1.0
    assert row["IrrigationPractice"] == "N"
    # honesty: manual field with no planting date and no CLU is flagged, not glossed
    assert "planting date" in row["incomplete"]
    assert any("CLU" in m for m in row["incomplete"])


def test_rotation_matrix(client, auth_headers, app_and_engine):
    _ensure_field_with_crop(app_and_engine)
    body = client.get("/api/v1/rotation", headers=auth_headers).json()
    assert 2032 in body["years"]
    row = next(f for f in body["fields"] if f["field_name"] == "FSA 80")
    assert row["crops"]["2032"] == "corn"
