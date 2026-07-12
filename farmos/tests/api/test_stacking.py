"""Stacking/eligibility engine test matrix (Hard Requirement #18b).

Covers: the canonical IDALS-discount-excludes-cost-share rule, SWOF
additionality, explicit stackable pairs, unknown-pair honesty, stale-rule
degradation, best-combo selection, and the practice/evidence chain."""
from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest

pytestmark = pytest.mark.db

KEYS = ["idals-rma-insurance-discount", "idals-wqi-cover-crop", "eqip", "swof", "pfi-cover-crop"]


@pytest.fixture()
def loaded_pack(app_and_engine):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import RegionPackRow
    from app.region_packs import loader

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        if not s.scalar(select(RegionPackRow).where(RegionPackRow.region_code == "US-IA")):
            loader.load_pack(s, loader.default_pack_path())
            s.commit()
    return True


def _check(app_and_engine, keys, acres=100, today=None):
    from sqlalchemy.orm import Session

    from app.services import stacking

    _, engine = app_and_engine
    with Session(engine) as s:
        return stacking.check(s, keys, acres, today=today or date(2026, 8, 1))


def _pair(result, a, b):
    return next(p for p in result["pairs"] if set(p["programs"]) == {a, b})


def test_idals_discount_exclusions(app_and_engine, loaded_pack):
    """The spec's canonical rule: the discount excludes acres in other
    state/federal cover-crop cost-share."""
    r = _check(app_and_engine, KEYS)

    assert _pair(r, "idals-rma-insurance-discount", "idals-wqi-cover-crop")["relation"] == "exclusive"
    assert _pair(r, "idals-rma-insurance-discount", "eqip")["relation"] == "exclusive"
    # every asserted relation carries a citation
    for p in r["pairs"]:
        if p["relation"] != "unknown":
            assert p["citation"] and p["source_url"] and p["last_verified"]

    # any combination containing discount + WQI is illegal
    for combo in r["combinations"]:
        s = set(combo["programs"])
        if {"idals-rma-insurance-discount", "idals-wqi-cover-crop"} <= s:
            assert combo["legal"] is False
        if {"idals-rma-insurance-discount", "eqip"} <= s:
            assert combo["legal"] is False


def test_swof_additionality_and_stackables(app_and_engine, loaded_pack):
    r = _check(app_and_engine, KEYS)
    assert _pair(r, "swof", "idals-wqi-cover-crop")["relation"] == "exclusive"
    assert _pair(r, "swof", "eqip")["relation"] == "exclusive"
    assert _pair(r, "idals-wqi-cover-crop", "eqip")["relation"] == "stackable"
    assert _pair(r, "idals-rma-insurance-discount", "swof")["relation"] == "stackable"


def test_unknown_pairs_are_never_assumed(app_and_engine, loaded_pack):
    """No rule on file → unknown, and unknown pairs keep a combo out of
    the best-verified ranking (Hard Requirement #6)."""
    r = _check(app_and_engine, ["pfi-cover-crop", "swof"])
    pair = _pair(r, "pfi-cover-crop", "swof")
    assert pair["relation"] == "unknown"
    assert "confirm" in pair["note"]
    both = next(c for c in r["combinations"] if len(c["programs"]) == 2)
    assert both["legal"] is True  # not known-illegal...
    assert both["fully_verified"] is False  # ...but never called verified money


def test_best_verified_combo_maximizes_dollars(app_and_engine, loaded_pack):
    """discount($5) + swof($33) = $38/ac is the best FULLY VERIFIED combo —
    beating wqi($30)+eqip(stackable but eqip has no computable rate) and
    every exclusive-violating pairing."""
    r = _check(app_and_engine, KEYS, acres=300)
    best = r["best_verified_combo"]
    assert best is not None
    assert set(best["programs"]) == {"idals-rma-insurance-discount", "swof"}
    assert best["per_acre_usd"] == 38.0
    assert best["total_usd"] == 38.0 * 300
    # and the engine is honest that wqi+eqip's dollars are partly not computable
    wqi_eqip = next(c for c in r["combinations"] if set(c["programs"]) == {"idals-wqi-cover-crop", "eqip"})
    assert wqi_eqip["legal"] and wqi_eqip["fully_verified"]
    assert wqi_eqip["per_acre_usd"] == 30.0
    assert "eqip" in wqi_eqip["not_computable"]


def test_stale_rules_degrade_to_unknown(app_and_engine, loaded_pack):
    """Past verify_by, an exclusive rule stops asserting anything — the
    engine enforces staleness, discipline doesn't."""
    future = date(2028, 6, 1)  # beyond every verify_by in the pack
    r = _check(app_and_engine, ["idals-rma-insurance-discount", "idals-wqi-cover-crop"], today=future)
    pair = _pair(r, "idals-rma-insurance-discount", "idals-wqi-cover-crop")
    assert pair["relation"] == "unknown"
    assert pair["stale"] is True
    assert r["best_verified_combo"] is None or len(r["best_verified_combo"]["programs"]) == 1


def test_practice_with_evidence_chain(client, auth_headers, app_and_engine):
    """Practice inventory: create, attach evidence, tamper-evident flag."""
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import Farm, FarmProfile, Field

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        profile = s.query(FarmProfile).first()
        farm = s.scalar(select(Farm)) or Farm(farm_profile_id=profile.id, farm_number="4400",
                                              state_ansi_code="19", county_ansi_code="153")
        s.add(farm)
        s.flush()
        field = s.scalar(select(Field).where(Field.name == "Practice 60"))
        if field is None:
            field = Field(
                farm_id=farm.id, tract_number="4401", field_number="1", name="Practice 60",
                boundary="SRID=4326;MULTIPOLYGON(((-93.4 42.6,-93.39 42.6,-93.39 42.61,-93.4 42.61,-93.4 42.6)))",
                gis_acres=60, source="manual",
            )
            s.add(field)
            s.commit()
        field_id = str(field.id)

    r = client.post(
        "/api/v1/practices",
        json={"field_id": field_id, "crop_year": 2026, "practice_type": "cover_crop",
              "attributes": {"species": "cereal rye", "seeding_date": "2026-10-01"}},
        headers=auth_headers,
    )
    assert r.status_code == 201, r.text
    practice_id = r.json()["id"]

    # evidence must reference something real
    r = client.post(f"/api/v1/practices/{practice_id}/evidence", json={"note": "trust me"}, headers=auth_headers)
    assert r.status_code == 422

    # attach a real capture as evidence
    import uuid as uuid_mod
    from datetime import datetime, timezone

    cid = str(uuid_mod.uuid4())
    cap = client.post(
        "/api/v1/captures",
        files={"file": ("rye.jpg", b"\xff\xd8\xff rye photo", "image/jpeg")},
        data={"client_id": cid, "kind": "photo", "captured_at": datetime.now(timezone.utc).isoformat()},
        headers=auth_headers,
    ).json()
    r = client.post(
        f"/api/v1/practices/{practice_id}/evidence",
        json={"capture_event_id": cap["id"], "note": "establishment photo"},
        headers=auth_headers,
    )
    assert r.status_code == 201
    body = r.json()
    assert body["evidence_count"] == 1
    assert body["evidence"][0]["tamper_evident"] is False  # not anchored yet — honest


def test_stacking_endpoint(client, auth_headers, app_and_engine, loaded_pack):
    r = client.get(
        "/api/v1/programs/stacking?programs=idals-rma-insurance-discount,swof,idals-wqi-cover-crop&acres=200",
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["best_verified_combo"]["per_acre_usd"] == 38.0
    assert client.get("/api/v1/programs/stacking?programs=only-one&acres=10", headers=auth_headers).status_code == 422
