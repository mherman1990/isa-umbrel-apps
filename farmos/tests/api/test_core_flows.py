"""End-to-end API flows against real PostGIS: auth, profile, programs,
capture→parse→inbox→record (with a fake LLM transport), offline sync
idempotency, CLU GeoJSON import, spend cap."""
from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime, timezone

import pytest

pytestmark = pytest.mark.db

CANONICAL_MODEL_OUTPUT = json.dumps(
    [
        {
            "target_type": "field_operation",
            "confidence": 0.85,
            "ambiguities": [],
            "payload": {
                "op_type": "spray",
                "field_name": "home eighty",
                "products": [{"name": "Enlist One", "rate": 32, "rate_unit": "oz/ac"}],
                "details": {"carrier_gal_per_ac": 20, "wind": "S 8 mph"},
            },
        },
        {
            "target_type": "equipment_issue",
            "confidence": 0.92,
            "ambiguities": [],
            "payload": {"equipment": "sprayer left boom", "issue": "dripping", "recurring": True},
        },
        {
            "target_type": "input_inventory",
            "confidence": 0.9,
            "ambiguities": [],
            "payload": {"product_name": "Enlist One", "observation": "low", "quantity_hint": "two jugs"},
        },
    ]
)


def _fake_transport(output_text):
    def transport(*, model, system, messages, max_tokens):
        return output_text, 1500, 400

    return transport


def test_auth_pairing_flow(client, auth_headers):
    r = client.post("/api/v1/auth/pairing-codes", json={"role": "operator"}, headers=auth_headers)
    assert r.status_code == 200, r.text
    code = r.json()["code"]
    r2 = client.post("/api/v1/auth/pair", json={"code": code, "device_name": "Dad's phone"})
    assert r2.status_code == 200
    token2 = r2.json()["token"]
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token2}"}).status_code == 200
    # single use
    assert client.post("/api/v1/auth/pair", json={"code": code, "device_name": "again"}).status_code == 400


def test_profile_and_program_finder(client, auth_headers, app_and_engine):
    r = client.put(
        "/api/v1/profile",
        json={
            "operation_name": "Lazy H Farms",
            "state_code": "IA",
            "county_ansi_code": "153",
            "beginning_farmer": True,
            "crops": {"corn": {"acres": 300}, "soybeans": {"acres": 300}},
            "practice_history": {"cover_crops": True, "enrolled_cover_crop_programs": []},
        },
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["anthropic_key_set"] is False

    # load the Iowa pack, then ask for matches
    _, engine = app_and_engine
    from sqlalchemy.orm import Session

    from app.region_packs import loader

    with Session(engine) as s:
        loader.load_pack(s, loader.default_pack_path())
        s.commit()

    r = client.get("/api/v1/programs/matches", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert len(body["programs"]) >= 5, "Phase 1 acceptance: >=5 Iowa programs"
    for p in body["programs"]:
        assert p["source_url"], p["program_key"]
        assert p["last_verified"], p["program_key"]
    # stacking-exclusion rule shows up on the insurance-discount program
    discount = next(p for p in body["programs"] if p["program_key"] == "idals-rma-insurance-discount")
    rule = next(r_ for r_ in discount["rules"] if r_["rule_key"] == "no_other_cover_crop_program")
    assert rule["verdict"] == "pass"  # profile says no other cover-crop enrollments
    assert rule["citation"]


def test_capture_to_inbox_to_record(client, auth_headers, app_and_engine, monkeypatch):
    _, engine = app_and_engine
    from sqlalchemy.orm import Session

    from app import llm
    from app.capture import pipeline
    from app.models import Farm, FarmProfile, Field

    # a field the parse can be confirmed against
    with Session(engine, expire_on_commit=False) as s:
        profile = s.query(FarmProfile).first()
        farm = Farm(farm_profile_id=profile.id, farm_number="1234", state_ansi_code="19", county_ansi_code="153")
        s.add(farm)
        s.flush()
        field = Field(
            farm_id=farm.id, tract_number="101", field_number="1", name="Home 80",
            boundary="SRID=4326;MULTIPOLYGON(((-93.5 42.0,-93.49 42.0,-93.49 42.01,-93.5 42.01,-93.5 42.0)))",
            clu_calculated_acres=80, gis_acres=79.8, source="manual",
        )
        s.add(field)
        s.commit()
        field_id = str(field.id)

    # upload a voice capture (job queue stubbed; we drive the pipeline inline)
    client_id = str(uuid.uuid4())
    r = client.post(
        "/api/v1/captures",
        files={"file": ("log.webm", b"fake-audio-bytes", "audio/webm")},
        data={"client_id": client_id, "kind": "voice", "captured_at": datetime.now(timezone.utc).isoformat()},
        headers=auth_headers,
    )
    assert r.status_code == 201, r.text
    capture_id = r.json()["id"]
    assert r.json()["status"] == "recorded"

    # idempotent replay of the same client_id
    r2 = client.post(
        "/api/v1/captures",
        files={"file": ("log.webm", b"fake-audio-bytes", "audio/webm")},
        data={"client_id": client_id, "kind": "voice", "captured_at": datetime.now(timezone.utc).isoformat()},
        headers=auth_headers,
    )
    assert r2.json()["id"] == capture_id

    # drive the pipeline: fake whisper + fake LLM
    from app.capture import transcribe as transcribe_mod

    monkeypatch.setattr(transcribe_mod, "transcribe", lambda path: "just finished spraying the home eighty...")
    llm.set_transport(_fake_transport(CANONICAL_MODEL_OUTPUT))
    try:
        from app.config import settings

        with Session(engine, expire_on_commit=False) as s:
            pipeline.run_transcription(s, uuid.UUID(capture_id), settings.data_dir)
        with Session(engine, expire_on_commit=False) as s:
            results = pipeline.run_parse(s, uuid.UUID(capture_id))
            assert len(results) == 3, "multi-record extraction: one capture -> N records"
    finally:
        llm.set_transport(None)

    # three inbox items
    r = client.get("/api/v1/inbox", headers=auth_headers)
    items = [i for i in r.json() if i["capture"]["id"] == capture_id]
    assert len(items) == 3
    op_item = next(i for i in items if i["target_type"] == "field_operation")

    # confirming without a field_id fails honestly (never guess silently)
    r = client.post(f"/api/v1/inbox/{op_item['id']}/confirm", json={}, headers=auth_headers)
    assert r.status_code == 422

    # confirm with the field resolved
    payload = dict(op_item["extracted"])
    payload["field_id"] = field_id
    r = client.post(f"/api/v1/inbox/{op_item['id']}/confirm", json={"final_payload": payload}, headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.json()["created_record_type"] == "field_operation"

    # double-confirm is a conflict (immutability of resolution)
    r = client.post(f"/api/v1/inbox/{op_item['id']}/confirm", json={"final_payload": payload}, headers=auth_headers)
    assert r.status_code == 409

    # the record carries provenance back to the capture
    r = client.get("/api/v1/operations", headers=auth_headers)
    op = next(o for o in r.json() if o["source_capture_event_id"] == capture_id)
    assert op["op_type"] == "spray"
    assert op["products"][0]["name"] == "Enlist One"

    # spend was metered
    r = client.get("/api/v1/spend", headers=auth_headers)
    assert r.json()["month_to_date_usd"] > 0


def test_sync_batch_idempotency(client, auth_headers):
    cid = str(uuid.uuid4())
    item = {
        "client_id": cid,
        "type": "capture",
        "payload": {
            "kind": "voice",
            "mime_type": "audio/webm",
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "data_base64": base64.b64encode(b"airplane-mode-audio").decode(),
        },
    }
    r = client.post("/api/v1/sync/batch", json={"items": [item]}, headers=auth_headers)
    assert r.json()["results"][0]["result"] == "created"
    r = client.post("/api/v1/sync/batch", json={"items": [item]}, headers=auth_headers)
    assert r.json()["results"][0]["result"] == "duplicate"

    r = client.get("/api/v1/sync/status", headers=auth_headers)
    body = r.json()
    assert "pending_captures" in body and "inbox_count" in body and "spend_month_usd" in body


def test_clu_geojson_import(client, auth_headers):
    gj = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"FARM_NBR": 1234, "TRACT_NBR": 555, "CLU_NUMBER": 7,
                               "CALC_ACRES": 78.7, "STATE_ANSI": "19", "COUNTY_ANSI": "153"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[-93.6, 42.1], [-93.59, 42.1], [-93.59, 42.11], [-93.6, 42.11], [-93.6, 42.1]]],
                },
            }
        ],
    }
    r = client.post(
        "/api/v1/fields/import",
        files={"file": ("export.geojson", json.dumps(gj).encode(), "application/geo+json")},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rows"][0]["farm_number"] == "1234"
    assert body["rows"][0]["tract_number"] == "555"
    assert body["rows"][0]["gis_acres"] is not None

    r = client.post(
        f"/api/v1/fields/import/{body['import_id']}/apply",
        json={"accepted_rows": [0]},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["created"] == 1

    fields = client.get("/api/v1/fields", headers=auth_headers).json()
    imported = next(f for f in fields if f["tract_number"] == "555")
    assert imported["boundary"]["type"] == "MultiPolygon"


def test_spend_cap_parks_capture(client, auth_headers, app_and_engine, monkeypatch):
    _, engine = app_and_engine
    from sqlalchemy.orm import Session

    from app import llm
    from app.capture import pipeline
    from app.models import ApiSpend, CaptureEvent, FarmProfile

    with Session(engine, expire_on_commit=False) as s:
        profile = s.query(FarmProfile).first()
        profile.monthly_spend_cap_usd = 0.01
        s.add(ApiSpend(purpose="test", model="claude-haiku-4-5", input_tokens=1, output_tokens=1, cost_usd=1.0))
        s.commit()

    cid = str(uuid.uuid4())
    r = client.post(
        "/api/v1/captures",
        files={"file": ("log.webm", b"capped-audio", "audio/webm")},
        data={"client_id": cid, "kind": "voice", "captured_at": datetime.now(timezone.utc).isoformat()},
        headers=auth_headers,
    )
    capture_id = r.json()["id"]

    from app.capture import transcribe as transcribe_mod
    from app.config import settings

    monkeypatch.setattr(transcribe_mod, "transcribe", lambda path: "some transcript")
    llm.set_transport(_fake_transport("[]"))
    try:
        with Session(engine, expire_on_commit=False) as s:
            pipeline.run_transcription(s, uuid.UUID(capture_id), settings.data_dir)
        with Session(engine, expire_on_commit=False) as s:
            results = pipeline.run_parse(s, uuid.UUID(capture_id))
        assert results == []
        with Session(engine) as s:
            row = s.get(CaptureEvent, uuid.UUID(capture_id))
            assert row.status == "transcribed"
            assert row.status_detail == "spend_cap"  # parked, not lost
    finally:
        llm.set_transport(None)
        with Session(engine, expire_on_commit=False) as s:
            profile = s.query(FarmProfile).first()
            profile.monthly_spend_cap_usd = 20
            s.commit()
