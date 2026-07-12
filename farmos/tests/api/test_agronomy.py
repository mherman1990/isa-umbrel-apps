"""Agronomy API — N-rate endpoint incl. the records-comparison path."""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.db

AG_YEAR = 2043


def _field_with_n_practice(app_and_engine):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import Farm, FarmProfile, Field, Practice

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        profile = s.query(FarmProfile).first()
        if profile is None:
            profile = FarmProfile(operation_name="Agro Farm")
            s.add(profile)
            s.flush()
        farm = s.scalar(select(Farm).where(Farm.farm_number == "5252"))
        if farm is None:
            farm = Farm(farm_profile_id=profile.id, farm_number="5252", state_ansi_code="19", county_ansi_code="169")
            s.add(farm)
            s.flush()
        field = s.scalar(select(Field).where(Field.name == "Agro Field"))
        if field is None:
            field = Field(
                farm_id=farm.id, tract_number="5253", field_number="1", name="Agro Field",
                boundary="SRID=4326;MULTIPOLYGON(((-93.7 42.3,-93.69 42.3,-93.69 42.31,-93.7 42.31,-93.7 42.3)))",
                gis_acres=100, clu_calculated_acres=100, source="manual",
            )
            s.add(field)
            s.flush()
        if not s.scalar(select(Practice).where(Practice.field_id == field.id, Practice.crop_year == AG_YEAR,
                                               Practice.practice_type == "nutrient_mgmt")):
            s.add(Practice(field_id=field.id, crop_year=AG_YEAR, practice_type="nutrient_mgmt",
                           attributes={"rate": 185, "source": "anhydrous"}))
        fid = str(field.id)
        s.commit()
        return fid


def test_n_rate_endpoint_prices_only(client, auth_headers):
    r = client.get("/api/v1/agronomy/n-rate?corn_price=5&n_price_per_lb=0.5&rotation=corn_after_soybean",
                   headers=auth_headers)
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["mrtn_rate_lb_n"] == 134
    assert b["source_url"].startswith("https://") and b["unverified"] is True
    assert b["comparison"] is None


def test_n_rate_endpoint_compares_to_recorded_practice(client, auth_headers, app_and_engine):
    field_id = _field_with_n_practice(app_and_engine)
    r = client.get(
        f"/api/v1/agronomy/n-rate?corn_price=5&n_price_per_lb=0.5&rotation=corn_after_soybean"
        f"&field_id={field_id}&crop_year={AG_YEAR}",
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    c = r.json()["comparison"]
    assert c is not None
    assert c["applied_n_lb"] == 185.0  # read from the nutrient_mgmt practice
    assert c["source"] == "nutrient_mgmt practice"
    assert c["net_left_on_table_per_ac"] > 0  # 185 is well above the ~134 optimum

    # invalid price -> 422 (never a bogus rate)
    assert client.get("/api/v1/agronomy/n-rate?corn_price=0&n_price_per_lb=0.5", headers=auth_headers).status_code == 422
