"""Boundary editor — create-by-draw + edit, with honest validation."""
from __future__ import annotations

import uuid

import pytest

pytestmark = pytest.mark.db

# a ~227 ac box and a larger box in Story County, IA (WGS84 lon/lat)
BOX_A = {"type": "Polygon", "coordinates": [[[-93.63, 42.02], [-93.62, 42.02], [-93.62, 42.03], [-93.63, 42.03], [-93.63, 42.02]]]}
BOX_B = {"type": "Polygon", "coordinates": [[[-93.63, 42.02], [-93.615, 42.02], [-93.615, 42.035], [-93.63, 42.035], [-93.63, 42.02]]]}
BOWTIE = {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]]}


def _farm(app_and_engine):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import Farm, FarmProfile

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        profile = s.query(FarmProfile).first()
        if profile is None:
            profile = FarmProfile(operation_name="Draw Farm")
            s.add(profile)
            s.flush()
        farm = s.scalar(select(Farm).where(Farm.farm_number == "7373"))
        if farm is None:
            farm = Farm(farm_profile_id=profile.id, farm_number="7373", state_ansi_code="19", county_ansi_code="169")
            s.add(farm)
            s.flush()
        fid = str(farm.id)
        s.commit()
        return fid


def test_create_field_by_draw(client, auth_headers, app_and_engine):
    farm_id = _farm(app_and_engine)
    r = client.post("/api/v1/fields", headers=auth_headers, json={
        "farm_id": farm_id, "tract_number": "7374", "field_number": "1", "name": "Drawn 40", "geometry": BOX_A})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["source"] == "manual"
    assert 220 < body["acres"] < 235  # recomputed, ~227

    # duplicate tract/field -> 409
    assert client.post("/api/v1/fields", headers=auth_headers, json={
        "farm_id": farm_id, "tract_number": "7374", "field_number": "1", "geometry": BOX_A}).status_code == 409
    # unknown farm -> 422
    assert client.post("/api/v1/fields", headers=auth_headers, json={
        "farm_id": str(uuid.uuid4()), "tract_number": "7374", "field_number": "9", "geometry": BOX_A}).status_code == 422
    # self-intersecting -> 422 (never silently repaired)
    assert client.post("/api/v1/fields", headers=auth_headers, json={
        "farm_id": farm_id, "tract_number": "7374", "field_number": "2", "geometry": BOWTIE}).status_code == 422


def test_edit_boundary_recomputes_and_flags_manual(client, auth_headers, app_and_engine):
    farm_id = _farm(app_and_engine)
    created = client.post("/api/v1/fields", headers=auth_headers, json={
        "farm_id": farm_id, "tract_number": "7374", "field_number": "3", "geometry": BOX_A}).json()
    fid, before = created["id"], created["acres"]

    e = client.put(f"/api/v1/fields/{fid}/boundary", headers=auth_headers, json={"geometry": BOX_B})
    assert e.status_code == 200, e.text
    assert e.json()["acres"] > before  # larger box -> more acres, recomputed
    assert e.json()["source"] == "manual"

    # invalid edit -> 422, unknown field -> 404
    assert client.put(f"/api/v1/fields/{fid}/boundary", headers=auth_headers, json={"geometry": BOWTIE}).status_code == 422
    assert client.put(f"/api/v1/fields/{uuid.uuid4()}/boundary", headers=auth_headers,
                      json={"geometry": BOX_A}).status_code == 404
