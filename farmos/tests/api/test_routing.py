"""Photo/document routing: classification fan-out, vault retention,
nearest-field attachment, and document confirmation."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import pytest

pytestmark = pytest.mark.db


def _queued_transport(responses: list[str]):
    """Pops one canned response per call — classify then extract."""
    queue = list(responses)

    def transport(*, model, system, messages, max_tokens):
        return queue.pop(0), 1200, 300

    return transport


def _upload_photo(client, auth_headers, gps=None):
    cid = str(uuid.uuid4())
    data = {"client_id": cid, "kind": "photo", "captured_at": datetime.now(timezone.utc).isoformat()}
    if gps:
        data["gps_lat"], data["gps_lon"] = str(gps[0]), str(gps[1])
    r = client.post(
        "/api/v1/captures",
        files={"file": ("photo.jpg", b"\xff\xd8\xff fake jpeg bytes", "image/jpeg")},
        data=data,
        headers=auth_headers,
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _run_route(app_and_engine, capture_id):
    from sqlalchemy.orm import Session

    from app.capture import pipeline

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        return pipeline.run_route(s, uuid.UUID(capture_id))


def _ensure_field(app_and_engine):
    """Self-contained test field around (-94.2, 41.5)."""
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import Farm, FarmProfile, Field

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        field = s.scalar(select(Field).where(Field.tract_number == "9901"))
        if field is None:
            profile = s.query(FarmProfile).first()
            if profile is None:
                profile = FarmProfile(operation_name="Routing Test Farm")
                s.add(profile)
                s.flush()
            farm = s.scalar(select(Farm).where(Farm.farm_number == "9900"))
            if farm is None:
                farm = Farm(farm_profile_id=profile.id, farm_number="9900",
                            state_ansi_code="19", county_ansi_code="153")
                s.add(farm)
                s.flush()
            field = Field(
                farm_id=farm.id, tract_number="9901", field_number="1", name="Routing 40",
                boundary="SRID=4326;MULTIPOLYGON(((-94.21 41.49,-94.19 41.49,-94.19 41.51,-94.21 41.51,-94.21 41.49)))",
                gis_acres=40, source="manual",
            )
            s.add(field)
            s.commit()
        return str(field.id)


def test_scouting_photo_attaches_to_nearest_field(client, auth_headers, app_and_engine):
    from app import llm

    field_id = _ensure_field(app_and_engine)
    # GPS inside the Routing 40 polygon
    capture_id = _upload_photo(client, auth_headers, gps=(41.5, -94.2))
    llm.set_transport(
        _queued_transport(
            [json.dumps({"kind": "scouting", "title": "waterhemp", "summary": "waterhemp escapes in beans"})]
        )
    )
    try:
        results = _run_route(app_and_engine, capture_id)
    finally:
        llm.set_transport(None)

    assert len(results) == 1
    assert results[0].target_type == "field_operation"
    assert results[0].extracted["op_type"] == "scout"
    assert results[0].extracted.get("field_id") == field_id, "GPS should have resolved the nearest field"

    capture = client.get(f"/api/v1/captures/{capture_id}", headers=auth_headers).json()
    assert capture["status"] == "queued"


def test_document_photo_lands_in_vault_and_inbox(client, auth_headers, app_and_engine):
    from app import llm

    capture_id = _upload_photo(client, auth_headers)
    classify = json.dumps(
        {"kind": "document", "doc_type": "scale_ticket", "title": "Heartland Co-op ticket 4471",
         "summary": "grain scale ticket"}
    )
    extract = json.dumps(
        {"payload": {"elevator": "Heartland Co-op", "net_bushels": 912.4, "moisture_pct": 14.8,
                     "ticket_number": "4471"},
         "confidence": 0.88,
         "ambiguities": []}
    )
    llm.set_transport(_queued_transport([classify, extract]))
    try:
        results = _run_route(app_and_engine, capture_id)
    finally:
        llm.set_transport(None)

    assert len(results) == 1
    assert results[0].target_type == "document"

    # vault row exists BEFORE confirmation (retention never depends on it)
    docs = client.get("/api/v1/documents?doc_type=scale_ticket", headers=auth_headers).json()
    doc = next(d for d in docs if d["title"] == "Heartland Co-op ticket 4471")
    assert doc["extracted"] is None  # not settled yet

    # confirm from the inbox, with a farmer correction
    inbox = client.get("/api/v1/inbox", headers=auth_headers).json()
    item = next(i for i in inbox if i["capture"]["id"] == capture_id)
    payload = dict(item["extracted"])
    payload["moisture_pct"] = 15.0
    r = client.post(f"/api/v1/inbox/{item['id']}/confirm", json={"final_payload": payload}, headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.json()["created_record_type"] == "document"

    settled = client.get(f"/api/v1/documents/{doc['id']}", headers=auth_headers).json()
    assert settled["extracted"]["moisture_pct"] == 15.0
    assert settled["extracted"]["net_bushels"] == 912.4


def test_unroutable_media_fails_honestly(client, auth_headers, app_and_engine):
    from app import llm

    cid = str(uuid.uuid4())
    r = client.post(
        "/api/v1/captures",
        files={"file": ("weird.bin", b"not media", "application/octet-stream")},
        data={"client_id": cid, "kind": "file", "captured_at": datetime.now(timezone.utc).isoformat()},
        headers=auth_headers,
    )
    capture_id = r.json()["id"]
    llm.set_transport(_queued_transport(["should never be called"]))
    try:
        results = _run_route(app_and_engine, capture_id)
    finally:
        llm.set_transport(None)
    assert results == []
    capture = client.get(f"/api/v1/captures/{capture_id}", headers=auth_headers).json()
    assert capture["status"] == "failed"
    assert "unsupported media type" in capture["status_detail"]
