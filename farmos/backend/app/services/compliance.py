"""Restricted-use pesticide record compliance (spec §6).

The legal requirements are region-pack DATA (7 U.S.C. 136i-1 baseline for
Iowa). This service finds every spray operation that used a product with
an EPA registration number and grades its record against the pack's
required-field list — complete records are exportable; incomplete ones
say exactly what's missing while the applicator still remembers.
"""
from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AppUser, Field, FieldOperation, OperationProduct, Product
from ..region_packs import loader


def _pack_compliance():
    path = loader.default_pack_path()
    if path is None:
        return None
    pack, _ = loader.read_pack(path)
    return pack.compliance


def _field_value(op: FieldOperation, link: OperationProduct, product: Product,
                 field: Field | None, applicator: AppUser | None, key: str):
    details = op.details or {}
    if key == "product_name":
        return product.name
    if key == "epa_reg_number":
        return product.epa_reg_number
    if key == "total_amount":
        return link.total_quantity and f"{link.total_quantity} {link.unit or ''}".strip()
    if key == "rate":
        return link.rate and f"{link.rate} {link.rate_unit or ''}".strip()
    if key == "location":
        return field and (field.name or f"T{field.tract_number}/F{field.field_number}")
    if key == "area_size":
        return op.acres_covered or (field and (field.clu_calculated_acres or field.gis_acres))
    if key == "crop":
        return details.get("crop")
    if key == "application_date":
        return op.occurred_at.date().isoformat()
    if key == "applicator_name":
        return details.get("applicator") or (applicator and applicator.display_name)
    if key == "applicator_certification":
        return details.get("applicator_certification")
    return details.get(key)


def rup_records(session: Session, year: int) -> dict:
    spec = _pack_compliance()
    if spec is None:
        return {"configured": False, "note": "region pack has no compliance section"}

    rows = session.execute(
        select(FieldOperation, OperationProduct, Product)
        .join(OperationProduct, OperationProduct.operation_id == FieldOperation.id)
        .join(Product, OperationProduct.product_id == Product.id)
        .where(
            FieldOperation.op_type == "spray",
            Product.epa_reg_number.isnot(None),
            FieldOperation.occurred_at >= date(year, 1, 1),
            FieldOperation.occurred_at <= date(year, 12, 31),
        )
        .order_by(FieldOperation.occurred_at)
    ).all()

    records = []
    for op, link, product in rows:
        field = session.get(Field, op.field_id)
        applicator = session.get(AppUser, op.operator_user_id) if op.operator_user_id else None
        values = {k: _field_value(op, link, product, field, applicator, k) for k in spec.rup_required_fields}
        missing = [k for k, v in values.items() if v in (None, "", 0)]
        records.append(
            {
                "operation_id": str(op.id),
                "occurred_at": op.occurred_at.isoformat(),
                "product": product.name,
                "epa_reg_number": product.epa_reg_number,
                "values": {k: (str(v) if v is not None else None) for k, v in values.items()},
                "missing": missing,
                "complete": not missing,
                "source_capture_event_id": str(op.source_capture_event_id) if op.source_capture_event_id else None,
            }
        )

    return {
        "configured": True,
        "year": year,
        "retention_years": spec.rup_retention_years,
        "required_fields": spec.rup_required_fields,
        "citation": spec.citation,
        "source_url": spec.source_url,
        "last_verified": spec.last_verified.isoformat(),
        "stale": spec.verify_by < date.today(),
        "records": records,
        "summary": {
            "total": len(records),
            "complete": sum(1 for r in records if r["complete"]),
        },
    }
