"""Weather auto-attach (optional adapter — Open-Meteo, no key).

When a field operation is confirmed, a background job fetches conditions
at the field centroid for the hour it happened and stores them on the
record. That's the wind/temp line a restricted-use pesticide record needs,
captured without the farmer typing anything. Offline or API-down means
the record simply has no weather — the adapter degrades to nothing
(Hard Requirement #4) and a nightly retry backfills recent gaps.
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Field, FieldOperation

HOURLY_VARS = "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation"


def _fetch_json(url: str, timeout: int = 20) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 — fixed public host
        return json.loads(resp.read().decode())


def fetch_conditions(lat: float, lon: float, at: datetime) -> dict | None:
    """Nearest-hour conditions from Open-Meteo (forecast API covers the
    recent past; archive API covers older dates)."""
    at_utc = at.astimezone(timezone.utc)
    day = at_utc.date().isoformat()
    base_params = {
        "latitude": f"{lat:.4f}",
        "longitude": f"{lon:.4f}",
        "hourly": HOURLY_VARS,
        "windspeed_unit": "mph",
        "temperature_unit": "fahrenheit",
        "timezone": "UTC",
    }
    if datetime.now(timezone.utc) - at_utc <= timedelta(days=7):
        params = {**base_params, "past_days": "7", "forecast_days": "1"}
        url = "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(params)
    else:
        params = {**base_params, "start_date": day, "end_date": day}
        url = "https://archive-api.open-meteo.com/v1/archive?" + urllib.parse.urlencode(params)

    data = _fetch_json(url)
    hours = data.get("hourly", {}).get("time") or []
    if not hours:
        return None
    target = at_utc.strftime("%Y-%m-%dT%H:00")
    try:
        idx = hours.index(target)
    except ValueError:
        # nearest available hour instead of nothing
        stamps = [datetime.fromisoformat(h).replace(tzinfo=timezone.utc) for h in hours]
        idx = min(range(len(stamps)), key=lambda i: abs((stamps[i] - at_utc).total_seconds()))
    hourly = data["hourly"]

    def pick(var):
        vals = hourly.get(var)
        return vals[idx] if vals and idx < len(vals) and vals[idx] is not None else None

    return {
        "source": "open-meteo",
        "observed_hour_utc": hours[idx],
        "temp_f": pick("temperature_2m"),
        "humidity_pct": pick("relative_humidity_2m"),
        "wind_mph": pick("wind_speed_10m"),
        "wind_direction_deg": pick("wind_direction_10m"),
        "precip_in_hr": pick("precipitation"),
    }


def attach_weather(session: Session, operation_id) -> bool:
    op = session.get(FieldOperation, operation_id)
    if op is None or op.weather is not None:
        return False
    field = session.get(Field, op.field_id)
    if field is None or field.boundary is None:
        return False
    from geoalchemy2.functions import ST_X, ST_Y, ST_Centroid

    lon, lat = session.execute(
        select(ST_X(ST_Centroid(Field.boundary)), ST_Y(ST_Centroid(Field.boundary))).where(Field.id == field.id)
    ).one()
    try:
        conditions = fetch_conditions(float(lat), float(lon), op.occurred_at)
    except Exception:  # noqa: BLE001 — adapter degrades to nothing
        return False
    if conditions is None:
        return False
    op.weather = conditions
    return True


def backfill_recent(session: Session, days: int = 7, limit: int = 50) -> int:
    """Nightly: attach weather to recent operations that missed it."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    ops = session.scalars(
        select(FieldOperation)
        .where(FieldOperation.weather.is_(None), FieldOperation.occurred_at >= cutoff)
        .limit(limit)
    ).all()
    done = 0
    for op in ops:
        if attach_weather(session, op.id):
            done += 1
    return done
