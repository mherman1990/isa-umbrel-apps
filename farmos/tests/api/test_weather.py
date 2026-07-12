"""Weather auto-attach: nearest-hour pick, centroid lookup, graceful
degradation when the API is unreachable."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

pytestmark = pytest.mark.db

FAKE_RESPONSE = {
    "hourly": {
        "time": ["2025-06-01T13:00", "2025-06-01T14:00", "2025-06-01T15:00"],
        "temperature_2m": [72.1, 75.3, 77.0],
        "relative_humidity_2m": [60, 55, 50],
        "wind_speed_10m": [6.2, 8.1, 9.9],
        "wind_direction_10m": [170, 180, 190],
        "precipitation": [0.0, 0.0, 0.1],
    }
}


def _make_op(app_and_engine, occurred_at):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import Farm, FarmProfile, Field, FieldOperation

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        profile = s.query(FarmProfile).first()
        farm = s.scalar(select(Farm)) or Farm(
            farm_profile_id=profile.id, farm_number="6600", state_ansi_code="19", county_ansi_code="153"
        )
        s.add(farm)
        s.flush()
        field = s.scalar(select(Field).where(Field.name == "Weather 40"))
        if field is None:
            field = Field(
                farm_id=farm.id, tract_number="6601", field_number="1", name="Weather 40",
                boundary="SRID=4326;MULTIPOLYGON(((-93.6 42.4,-93.59 42.4,-93.59 42.41,-93.6 42.41,-93.6 42.4)))",
                gis_acres=40, source="manual",
            )
            s.add(field)
            s.flush()
        op = FieldOperation(field_id=field.id, op_type="spray", occurred_at=occurred_at)
        s.add(op)
        s.commit()
        return op.id


def test_attach_weather_nearest_hour(app_and_engine, monkeypatch):
    from sqlalchemy.orm import Session

    from app.models import FieldOperation
    from app.services import weather

    captured_urls = []

    def fake_fetch(url, timeout=20):
        captured_urls.append(url)
        return FAKE_RESPONSE

    monkeypatch.setattr(weather, "_fetch_json", fake_fetch)
    op_id = _make_op(app_and_engine, datetime(2025, 6, 1, 14, 20, tzinfo=timezone.utc))

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        assert weather.attach_weather(s, op_id) is True
        s.commit()
    with Session(engine) as s:
        op = s.get(FieldOperation, op_id)
        assert op.weather["observed_hour_utc"] == "2025-06-01T14:00"  # 14:20 → nearest hour 14:00
        assert op.weather["wind_mph"] == 8.1
        assert op.weather["temp_f"] == 75.3
    # 2025-06-01 is >7 days ago from any plausible test run → archive API
    assert "archive-api.open-meteo.com" in captured_urls[0]
    # centroid of the test polygon
    assert "latitude=42.40" in captured_urls[0] and "longitude=-93.59" in captured_urls[0]


def test_attach_weather_degrades_when_api_down(app_and_engine, monkeypatch):
    from sqlalchemy.orm import Session

    from app.models import FieldOperation
    from app.services import weather

    def boom(url, timeout=20):
        raise OSError("no route to host")

    monkeypatch.setattr(weather, "_fetch_json", boom)
    op_id = _make_op(app_and_engine, datetime(2025, 6, 2, 9, 0, tzinfo=timezone.utc))

    _, engine = app_and_engine
    with Session(engine, expire_on_commit=False) as s:
        assert weather.attach_weather(s, op_id) is False  # degraded, not raised
        s.commit()
    with Session(engine) as s:
        assert s.get(FieldOperation, op_id).weather is None
