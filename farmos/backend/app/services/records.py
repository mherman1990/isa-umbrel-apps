"""Turn a confirmed inbox item into a real farm record — transactionally,
with provenance back to the capture it came from.

This is the ONLY place parse payloads become records. Ambiguities must have
been resolved by the farmer (the API rejects confirmation while any listed
ambiguity key is still missing from the final payload).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    AuditLog,
    CaptureEvent,
    ConfirmationQueueItem,
    Field,
    FieldOperation,
    InputInventory,
    OperationProduct,
    ParseResult,
    Product,
)


def _get_or_create_product(session: Session, name: str, category: str = "other") -> Product:
    row = session.scalar(select(Product).where(Product.name == name))
    if row is None:
        row = Product(name=name, category=category, default_unit="unit")
        session.add(row)
        session.flush()
    return row


def _create_field_operation(session: Session, capture: CaptureEvent, payload: dict) -> FieldOperation:
    field_id = payload.get("field_id")
    if not field_id:
        raise HTTPException(status_code=422, detail="field_id is required to confirm a field operation")
    field = session.get(Field, uuid.UUID(str(field_id)))
    if field is None:
        raise HTTPException(status_code=422, detail="unknown field_id")
    occurred_at = payload.get("occurred_at") or capture.captured_at.isoformat()
    op = FieldOperation(
        field_id=field.id,
        op_type=payload.get("op_type", "other"),
        occurred_at=datetime.fromisoformat(occurred_at),
        acres_covered=payload.get("acres_covered"),
        notes=payload.get("notes"),
        operator_user_id=capture.user_id,
        source_capture_event_id=capture.id,
        details=payload.get("details") or {},
    )
    session.add(op)
    session.flush()
    for p in payload.get("products") or []:
        product = _get_or_create_product(session, p["name"], p.get("category", "other"))
        session.add(
            OperationProduct(
                operation_id=op.id,
                product_id=product.id,
                rate=p.get("rate"),
                rate_unit=p.get("rate_unit"),
                total_quantity=p.get("total_quantity"),
                unit=p.get("unit"),
            )
        )
        # Draw down inventory when we know the total used.
        if p.get("total_quantity"):
            inv = session.scalar(select(InputInventory).where(InputInventory.product_id == product.id))
            if inv is not None:
                inv.quantity = float(inv.quantity) - float(p["total_quantity"])
    return op


def _create_inventory_note(session: Session, capture: CaptureEvent, payload: dict):
    product = _get_or_create_product(session, payload["product_name"], payload.get("category", "other"))
    inv = session.scalar(select(InputInventory).where(InputInventory.product_id == product.id))
    if inv is None:
        inv = InputInventory(product_id=product.id, quantity=payload.get("quantity") or 0,
                             unit=payload.get("unit") or product.default_unit)
        session.add(inv)
        session.flush()
    elif payload.get("quantity") is not None:
        inv.quantity = payload["quantity"]
    return inv


def confirm_item(
    session: Session,
    item: ConfirmationQueueItem,
    final_payload: dict | None,
    user_id: uuid.UUID,
) -> ConfirmationQueueItem:
    if item.state != "pending":
        raise HTTPException(status_code=409, detail=f"item already {item.state}")
    parse = session.get(ParseResult, item.parse_result_id)
    capture = session.get(CaptureEvent, parse.capture_event_id)
    payload = final_payload if final_payload is not None else parse.extracted

    for amb in parse.ambiguities or []:
        key = amb.get("key")
        if key and payload.get(key) in (None, ""):
            raise HTTPException(status_code=422, detail=f"unresolved ambiguity: {amb.get('question', key)}")

    record_type, record_id = None, None
    if parse.target_type == "field_operation":
        op = _create_field_operation(session, capture, payload)
        record_type, record_id = "field_operation", op.id
    elif parse.target_type == "input_inventory":
        inv = _create_inventory_note(session, capture, payload)
        record_type, record_id = "input_inventory", inv.id
    # equipment_issue / note: kept as the confirmed queue item itself in Phase 1
    # (a dedicated table arrives with the maintenance module).

    item.state = "edited" if final_payload is not None else "confirmed"
    item.resolved_by = user_id
    item.resolved_at = datetime.now(timezone.utc)
    item.final_payload = payload
    item.created_record_type = record_type
    item.created_record_id = record_id
    session.add(AuditLog(user_id=user_id, action="inbox.confirm", entity_type=record_type or parse.target_type,
                         entity_id=record_id, detail={"queue_item": str(item.id)}))

    from ..capture.pipeline import maybe_finalize_capture

    maybe_finalize_capture(session, capture)
    return item


def reject_item(session: Session, item: ConfirmationQueueItem, user_id: uuid.UUID) -> ConfirmationQueueItem:
    if item.state != "pending":
        raise HTTPException(status_code=409, detail=f"item already {item.state}")
    parse = session.get(ParseResult, item.parse_result_id)
    capture = session.get(CaptureEvent, parse.capture_event_id)
    item.state = "rejected"
    item.resolved_by = user_id
    item.resolved_at = datetime.now(timezone.utc)
    session.add(AuditLog(user_id=user_id, action="inbox.reject", entity_type=parse.target_type,
                         detail={"queue_item": str(item.id)}))
    from ..capture.pipeline import maybe_finalize_capture

    maybe_finalize_capture(session, capture)
    return item
