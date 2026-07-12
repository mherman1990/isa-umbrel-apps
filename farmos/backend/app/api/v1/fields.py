from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from geoalchemy2.shape import to_shape
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import auth
from ...db import get_session
from ...models import AppUser, AuditLog, Farm, FarmProfile, Field
from ...services import clu_import

router = APIRouter(tags=["fields"])

# In-flight import previews, keyed by import id. Small and ephemeral —
# a restart just means re-uploading the file.
_pending_imports: dict[str, list[clu_import.CluRow]] = {}


def _field_view(f: Field) -> dict:
    shp = to_shape(f.boundary) if f.boundary is not None else None
    return {
        "id": str(f.id),
        "farm_id": str(f.farm_id),
        "name": f.name,
        "tract_number": f.tract_number,
        "field_number": f.field_number,
        "clu_identifier": f.clu_identifier,
        "acres": float(f.clu_calculated_acres or f.gis_acres or 0) or None,
        "gis_acres": float(f.gis_acres) if f.gis_acres is not None else None,
        "source": f.source,
        "boundary": json.loads(json.dumps(shp.__geo_interface__)) if shp is not None else None,
    }


@router.get("/farms")
def list_farms(session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    return [
        {
            "id": str(f.id),
            "farm_number": f.farm_number,
            "state_ansi_code": f.state_ansi_code,
            "county_ansi_code": f.county_ansi_code,
        }
        for f in session.scalars(select(Farm))
    ]


@router.get("/fields")
def list_fields(session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    rows = session.scalars(select(Field).where(Field.archived_at.is_(None)).order_by(Field.tract_number)).all()
    return [_field_view(f) for f in rows]


class FieldPatch(BaseModel):
    name: str | None = None
    productivity_index: float | None = None


@router.patch("/fields/{field_id}")
def patch_field(
    field_id: uuid.UUID,
    body: FieldPatch,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    f = session.get(Field, field_id)
    if f is None:
        raise HTTPException(status_code=404, detail="unknown field")
    if body.name is not None:
        f.name = body.name
    if body.productivity_index is not None:
        f.productivity_index = body.productivity_index
    return _field_view(f)


@router.post("/fields/import")
async def import_preview(
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    """Step 1: parse a farmers.gov export (zipped shapefile / GeoJSON) and
    return a preview. Nothing is written until /apply."""
    content = await file.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="upload too large")
    try:
        rows = clu_import.parse_upload(file.filename or "upload", content)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    existing = {
        (f.tract_number, f.field_number): f
        for f in session.scalars(select(Field).where(Field.archived_at.is_(None)))
    }
    import_id = str(uuid.uuid4())
    _pending_imports[import_id] = rows
    preview = []
    for i, r in enumerate(rows):
        verdict = "new"
        if r.tract_number and (r.tract_number, r.field_number) in existing:
            verdict = "matches_existing"
        preview.append(
            {
                "row": i,
                "farm_number": r.farm_number,
                "tract_number": r.tract_number,
                "field_number": r.field_number,
                "clu_identifier": r.clu_identifier,
                "acres": r.acres,
                "gis_acres": r.gis_acres,
                "verdict": verdict,
                "warnings": r.warnings,
            }
        )
    return {"import_id": import_id, "rows": preview}


class ApplyIn(BaseModel):
    accepted_rows: list[int]


@router.post("/fields/import/{import_id}/apply")
def import_apply(
    import_id: str,
    body: ApplyIn,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    rows = _pending_imports.get(import_id)
    if rows is None:
        raise HTTPException(status_code=404, detail="unknown or expired import — re-upload the file")
    profile = session.scalars(select(FarmProfile)).first()
    created = 0
    for i in body.accepted_rows:
        if not (0 <= i < len(rows)):
            continue
        r = rows[i]
        farm = _get_or_create_farm(session, profile, r)
        tract = r.tract_number or "unknown"
        fieldno = r.field_number or f"import-{i}"
        exists = session.scalar(
            select(Field).where(
                Field.farm_id == farm.id, Field.tract_number == tract, Field.field_number == fieldno
            )
        )
        if exists is not None:
            continue
        session.add(
            Field(
                farm_id=farm.id,
                tract_number=tract,
                field_number=fieldno,
                clu_identifier=r.clu_identifier,
                boundary=f"SRID=4326;{r.geometry_wkt}",
                clu_calculated_acres=r.acres,
                gis_acres=r.gis_acres,
                source="clu_import",
            )
        )
        created += 1
    session.add(AuditLog(user_id=user.id, action="field.import", detail={"created": created}))
    del _pending_imports[import_id]
    return {"created": created}


def _get_or_create_farm(session: Session, profile: FarmProfile | None, r: clu_import.CluRow) -> Farm:
    state = r.state_code or (profile.state_code if profile else "IA")
    county = r.county_code or (profile.county_ansi_code if profile else None) or "000"
    number = r.farm_number or "unknown"
    farm = session.scalar(
        select(Farm).where(
            Farm.state_ansi_code == state,
            Farm.county_ansi_code == county,
            Farm.farm_number == number,
        )
    )
    if farm is None:
        if profile is None:
            raise HTTPException(status_code=409, detail="complete onboarding before importing fields")
        farm = Farm(
            farm_profile_id=profile.id, farm_number=number, state_ansi_code=state, county_ansi_code=county
        )
        session.add(farm)
        session.flush()
    return farm
