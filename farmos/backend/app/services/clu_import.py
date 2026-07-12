"""CLU / field-boundary import from a farmers.gov export.

Accepts a zipped ESRI shapefile or GeoJSON. There is no published .dbf
column dictionary for the farmers.gov producer export, so attribute lookup
is defensive: several observed spellings per attribute, case-insensitive.
Import is two-step (preview → apply) so nothing lands without the farmer
seeing the rows.
"""
from __future__ import annotations

import tempfile
import zipfile
from dataclasses import dataclass, field as dc_field
from pathlib import Path

import fiona
from shapely.geometry import MultiPolygon, shape
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


def parse_upload(filename: str, content: bytes) -> list[CluRow]:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
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
        elif filename.lower().endswith((".geojson", ".json")):
            src_path = tmp / "upload.geojson"
            src_path.write_bytes(content)
        else:
            raise ValueError("expected a zipped shapefile or a GeoJSON file")

        rows: list[CluRow] = []
        with fiona.open(src_path) as src:
            import pyproj

            src_crs = src.crs or "EPSG:4326"
            to_4326 = pyproj.Transformer.from_crs(src_crs, "EPSG:4326", always_xy=True).transform
            for feat in src:
                props = dict(feat["properties"] or {})
                geom = _to_multipolygon(feat["geometry"])
                geom = shp_transform(to_4326, geom)
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


def _s(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    # normalize numeric-looking codes ("101.0" → "101")
    if s.endswith(".0"):
        s = s[:-2]
    return s or None
