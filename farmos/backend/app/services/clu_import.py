"""CLU / field-boundary import from a farmers.gov export.

Accepts a zipped ESRI shapefile or GeoJSON. There is no published .dbf
column dictionary for the farmers.gov producer export, so attribute lookup
is defensive: several observed spellings per attribute, case-insensitive.
Import is two-step (preview → apply) so nothing lands without the farmer
seeing the rows.

Shapefile I/O is pure-Python (pyshp) so the image needs no GDAL — the
heaviest possible native dependency to ship to a Raspberry Pi, and one
with no arm64 wheel. shapely (GEOS) and pyproj (PROJ) both ship arm64
wheels, so nothing here compiles from source.
"""
from __future__ import annotations

import json
import tempfile
import zipfile
from dataclasses import dataclass, field as dc_field
from pathlib import Path

import shapefile  # pyshp
from shapely.geometry import MultiPolygon, shape
from shapely.geometry.polygon import orient
from shapely.ops import transform as shp_transform

# candidate attribute names seen in CLU exports, lowercase
ATTR_CANDIDATES = {
    "farm_number": ("farm_nbr", "farm_no", "farmnumber", "farm_num", "fn", "farm"),
    "tract_number": ("tract_nbr", "tract_no", "tractnumber", "tract_num", "tract"),
    "field_number": ("clu_number", "field_nbr", "field_no", "fieldnumber", "clu_nbr", "field", "clu"),
    "clu_identifier": ("clu_identifier", "cluid", "clu_id", "clu_guid"),
    "acres": ("calc_acres", "calcacres", "clu_calculated_acreage", "acres", "gis_acres", "acreage"),
    "state_code": ("state_ansi", "statefp", "state_code", "state"),
    "county_code": ("county_ansi", "countyfp", "county_code", "county"),
}

SQ_M_PER_ACRE = 4046.8564224

# ESRI-style WGS84 .prj (pyshp doesn't emit a .prj on its own)
WGS84_PRJ = (
    'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],'
    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
)


@dataclass
class CluRow:
    farm_number: str | None
    tract_number: str | None
    field_number: str | None
    clu_identifier: str | None
    acres: float | None
    state_code: str | None
    county_code: str | None
    geometry_wkt: str
    gis_acres: float | None
    warnings: list[str] = dc_field(default_factory=list)


def _lookup(props: dict, key: str):
    lowered = {str(k).lower(): v for k, v in props.items()}
    for cand in ATTR_CANDIDATES[key]:
        if cand in lowered and lowered[cand] not in (None, ""):
            return lowered[cand]
    return None


def _to_multipolygon(geom) -> MultiPolygon:
    g = shape(geom)
    if g.geom_type == "Polygon":
        g = MultiPolygon([g])
    if g.geom_type != "MultiPolygon":
        raise ValueError(f"unsupported geometry type {g.geom_type}")
    return g


def _acres_4326(geom: MultiPolygon) -> float:
    # Equal-area projection for an honest acreage recompute.
    import pyproj

    tfm = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:5070", always_xy=True).transform
    return round(shp_transform(tfm, geom).area / SQ_M_PER_ACRE, 2)


def _shp_transformer(shp_path: Path):
    """Reproject-to-4326 transform for a shapefile, from its .prj if present.
    Returns None when the source is already lon/lat WGS84 (no-op)."""
    prj = shp_path.with_suffix(".prj")
    if not prj.exists():
        return None
    try:
        import pyproj

        src = pyproj.CRS.from_wkt(prj.read_text())
        if src.to_epsg() == 4326:
            return None
        return pyproj.Transformer.from_crs(src, "EPSG:4326", always_xy=True).transform
    except Exception:  # noqa: BLE001 — unreadable .prj: assume WGS84, best effort
        return None


def _read_features(filename: str, tmp: Path, content: bytes):
    """Yield (properties: dict, geojson_geometry: dict, transform_or_None)."""
    if filename.lower().endswith(".zip"):
        zip_path = tmp / "upload.zip"
        zip_path.write_bytes(content)
        with zipfile.ZipFile(zip_path) as zf:
            for name in zf.namelist():  # reject path traversal before extracting
                if name.startswith("/") or ".." in name:
                    raise ValueError(f"unsafe path in zip: {name}")
            zf.extractall(tmp / "shp")
        shp_files = list((tmp / "shp").rglob("*.shp"))
        if not shp_files:
            raise ValueError("zip contains no .shp file")
        src_path = shp_files[0]
        tfm = _shp_transformer(src_path)
        reader = shapefile.Reader(str(src_path))
        try:
            for sr in reader.shapeRecords():
                if sr.shape.shapeType == shapefile.NULL:
                    continue
                yield sr.record.as_dict(), sr.shape.__geo_interface__, tfm
        finally:
            reader.close()
    elif filename.lower().endswith((".geojson", ".json")):
        data = json.loads(content.decode("utf-8"))
        feats = data.get("features", []) if data.get("type") == "FeatureCollection" else [data]
        for feat in feats:
            if not feat.get("geometry"):
                continue
            yield (feat.get("properties") or {}), feat["geometry"], None  # GeoJSON is WGS84 by spec
    else:
        raise ValueError("expected a zipped shapefile or a GeoJSON file")


def parse_upload(filename: str, content: bytes) -> list[CluRow]:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        rows: list[CluRow] = []
        for props, geom_dict, tfm in _read_features(filename, tmp, content):
            geom = _to_multipolygon(geom_dict)
            if tfm is not None:
                geom = shp_transform(tfm, geom)
            warnings: list[str] = []
            acres_attr = _lookup(props, "acres")
            acres = float(acres_attr) if acres_attr is not None else None
            gis_acres = _acres_4326(geom)
            if acres is not None and abs(gis_acres - acres) > max(1.0, acres * 0.05):
                warnings.append(f"attribute acres {acres} differs from computed {gis_acres}")
            for key in ("farm_number", "tract_number", "field_number"):
                if _lookup(props, key) is None:
                    warnings.append(f"missing {key} attribute")
            rows.append(
                CluRow(
                    farm_number=_s(_lookup(props, "farm_number")),
                    tract_number=_s(_lookup(props, "tract_number")),
                    field_number=_s(_lookup(props, "field_number")),
                    clu_identifier=_s(_lookup(props, "clu_identifier")),
                    acres=acres,
                    state_code=_s(_lookup(props, "state_code")),
                    county_code=_s(_lookup(props, "county_code")),
                    geometry_wkt=geom.wkt,
                    gis_acres=gis_acres,
                    warnings=warnings,
                )
            )
        if not rows:
            raise ValueError("no features found in upload")
        return rows


def export_shapefile_zip(rows: list[dict]) -> bytes:
    """Write field boundaries as a zipped ESRI shapefile (EPSG:4326) — the
    format farmers.gov imports back. `rows`: dicts with geometry_wkt and the
    FSA attribute set."""
    import io

    from shapely import wkt as shp_wkt

    with tempfile.TemporaryDirectory() as td:
        base = Path(td) / "farmos-fields"
        w = shapefile.Writer(str(base), shapeType=shapefile.POLYGON)
        w.field("FARM_NBR", "C", size=10)
        w.field("TRACT_NBR", "C", size=10)
        w.field("CLU_NBR", "C", size=10)
        w.field("CLUID", "C", size=36)
        w.field("ACRES", "N", size=18, decimal=3)
        w.field("NAME", "C", size=80)
        for r in rows:
            geom = shp_wkt.loads(r["geometry_wkt"])
            polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
            parts = []
            for poly in polys:
                poly = orient(poly, sign=-1.0)  # ESRI convention: exterior ring clockwise
                parts.append([list(pt) for pt in poly.exterior.coords])
                for ring in poly.interiors:
                    parts.append([list(pt) for pt in ring.coords])
            w.poly(parts)
            w.record(
                (r.get("farm_number") or "")[:10],
                (r.get("tract_number") or "")[:10],
                (r.get("field_number") or "")[:10],
                (r.get("clu_identifier") or "")[:36],
                float(r.get("acres") or 0),
                (r.get("name") or "")[:80],
            )
        w.close()
        base.with_suffix(".prj").write_text(WGS84_PRJ)  # pyshp doesn't write .prj

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for sidecar in Path(td).glob("farmos-fields.*"):
                zf.write(sidecar, sidecar.name)
        return buf.getvalue()


def _s(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    # normalize numeric-looking codes ("101.0" → "101")
    if s.endswith(".0"):
        s = s[:-2]
    return s or None
