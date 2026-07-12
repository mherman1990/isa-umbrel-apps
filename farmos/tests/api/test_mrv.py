"""MRV readiness: window math, verifier-grade demands, missing-evidence
honesty, days-left countdown."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

import pytest

pytestmark = pytest.mark.db

CROP_YEAR = 2027


def _setup(app_and_engine):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import AppUser, CaptureEvent, Farm, FarmProfile, Field, Practice, PracticeEvidence, RegionPackRow
    from app.region_packs import loader

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        if not s.scalar(select(RegionPackRow).where(RegionPackRow.region_code == "US-IA")):
            loader.load_pack(s, loader.default_pack_path())

        profile = s.query(FarmProfile).first() or FarmProfile(operation_name="MRV Farm")
        s.add(profile)
        s.flush()
        farm = s.scalar(select(Farm)) or Farm(farm_profile_id=profile.id, farm_number="3300",
                                              state_ansi_code="19", county_ansi_code="153")
        s.add(farm)
        s.flush()
        field = s.scalar(select(Field).where(Field.name == "MRV 80"))
        if field is None:
            field = Field(
                farm_id=farm.id, tract_number="3301", field_number="1", name="MRV 80",
                boundary="SRID=4326;MULTIPOLYGON(((-93.3 42.7,-93.29 42.7,-93.29 42.71,-93.3 42.71,-93.3 42.7)))",
                gis_acres=80, source="manual",
            )
            s.add(field)
            s.flush()

        practice = s.scalar(select(Practice).where(Practice.crop_year == CROP_YEAR))
        if practice is None:
            practice = Practice(field_id=field.id, crop_year=CROP_YEAR, practice_type="cover_crop",
                                attributes={"species": "cereal rye"})
            s.add(practice)
            s.flush()

            user = s.query(AppUser).first()
            # verifier-grade termination photo INSIDE the Apr 1 - May 15 window
            cap = CaptureEvent(
                client_id=uuid.uuid4(), user_id=user.id, kind="photo",
                artifact_path="artifacts/mrv/term.jpg", artifact_sha256="cd" * 32,
                mime_type="image/jpeg",
                captured_at=datetime(2027, 4, 20, 15, 0, tzinfo=timezone.utc),
                provenance="captured",
                timestamp_proof={"ots_b64": "ZmFrZQ==", "status": "attested"},
                status="confirmed",
            )
            s.add(cap)
            s.flush()
            s.add(PracticeEvidence(practice_id=practice.id, capture_event_id=cap.id,
                                   note="termination photo"))
        s.commit()


def _readiness(app_and_engine, today):
    from sqlalchemy.orm import Session

    from app.services import mrv

    _, engine = app_and_engine
    with Session(engine) as s:
        return mrv.readiness(s, "swof", CROP_YEAR, today=today)


def test_swof_readiness_report(app_and_engine):
    _setup(app_and_engine)
    r = _readiness(app_and_engine, today=date(2026, 11, 1))

    assert r["summary"]["requirements_defined"] == 2
    by_key = {req["req_key"]: req for req in r["requirements"]}

    term = by_key["cover-crop-termination-photo"]
    check = term["practices"][0]
    assert check["status"] == "met"
    assert check["detail"]["tamper_evident"] is True
    assert check["window"] == ["2027-04-01", "2027-05-15"]

    estab = by_key["cover-crop-establishment-photo"]
    check = estab["practices"][0]
    assert check["status"] == "missing"
    # window is 2026-10-01..2026-12-15 (year_offset -1); on Nov 1 there are 44 days left
    assert check["window"] == ["2026-10-01", "2026-12-15"]
    assert check["days_left"] == 44
    assert check["window_closed"] is False
    # requirement carries its citation and freshness like everything else
    assert estab["citation"] and estab["last_verified"]


def test_window_closed_is_flagged(app_and_engine):
    _setup(app_and_engine)
    r = _readiness(app_and_engine, today=date(2027, 1, 10))  # establishment window has passed
    estab = next(req for req in r["requirements"] if req["req_key"] == "cover-crop-establishment-photo")
    check = estab["practices"][0]
    assert check["status"] == "missing"
    assert check["window_closed"] is True
    assert check["days_left"] is None


def test_readiness_endpoint_and_no_spec_case(client, auth_headers, app_and_engine):
    _setup(app_and_engine)
    r = client.get(f"/api/v1/programs/swof/readiness?crop_year={CROP_YEAR}", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.json()["summary"]["requirements_defined"] == 2

    # a program with no evidence spec says so honestly
    r = client.get(f"/api/v1/programs/csp/readiness?crop_year={CROP_YEAR}", headers=auth_headers)
    assert r.status_code == 200
    assert "no evidence spec" in r.json()["note"]

    assert client.get("/api/v1/programs/nope/readiness?crop_year=2027", headers=auth_headers).status_code == 404
