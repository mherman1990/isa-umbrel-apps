from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field as PField
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import auth
from ...db import get_session
from ...models import (
    AppUser,
    AuditLog,
    BudgetLine,
    Field,
    MoneyTransaction,
    OperatingLoan,
    OperatingLoanEvent,
)
from ...services import cashflow, financials, lender_packet as lender_packet_svc

router = APIRouter(tags=["financials"])


def _txn_view(t: MoneyTransaction) -> dict:
    return {
        "id": str(t.id),
        "occurred_on": t.occurred_on.isoformat(),
        "description": t.description,
        "kind": t.kind,
        "category": t.category,
        "amount": float(t.amount),
        "crop": t.crop,
        "field_id": str(t.field_id) if t.field_id else None,
        "document_id": str(t.document_id) if t.document_id else None,
        "imported": t.source is not None,
    }


class TransactionIn(BaseModel):
    client_id: uuid.UUID | None = None
    occurred_on: date
    description: str
    kind: str = PField(default="expense", pattern="^(expense|income)$")
    category: str = "other"
    amount: float = PField(gt=0)
    crop: str | None = None
    field_id: uuid.UUID | None = None
    crop_year: int | None = None
    document_id: uuid.UUID | None = None


@router.get("/transactions")
def list_transactions(
    year: int | None = None,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    q = select(MoneyTransaction).order_by(MoneyTransaction.occurred_on.desc()).limit(500)
    if year:
        q = q.where(
            MoneyTransaction.occurred_on >= date(year, 1, 1),
            MoneyTransaction.occurred_on <= date(year, 12, 31),
        )
    return [_txn_view(t) for t in session.scalars(q)]


@router.post("/transactions", status_code=201)
def create_transaction(
    body: TransactionIn,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    if body.client_id is not None:
        existing = session.scalar(select(MoneyTransaction).where(MoneyTransaction.client_id == body.client_id))
        if existing is not None:
            return _txn_view(existing)
    if body.field_id is not None and session.get(Field, body.field_id) is None:
        raise HTTPException(status_code=422, detail="unknown field_id")
    t = MoneyTransaction(
        client_id=body.client_id,
        occurred_on=body.occurred_on,
        description=body.description,
        kind=body.kind,
        category=body.category,
        amount=body.amount,
        crop=body.crop.lower() if body.crop else None,
        field_id=body.field_id,
        crop_year=body.crop_year,
        document_id=body.document_id,
    )
    session.add(t)
    session.flush()
    session.add(AuditLog(user_id=user.id, action="transaction.create", entity_type="money_transaction", entity_id=t.id))
    return _txn_view(t)


@router.get("/budget")
def list_budget(
    year: int,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    rows = session.scalars(
        select(BudgetLine).where(BudgetLine.crop_year == year).order_by(BudgetLine.crop, BudgetLine.category)
    ).all()
    return [
        {"id": str(b.id), "crop": b.crop, "category": b.category,
         "amount_per_acre": float(b.amount_per_acre), "imported": b.source is not None}
        for b in rows
    ]


@router.get("/financials/summary")
def summary(
    year: int,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    return {
        "year": year,
        "crops": financials.crop_summary(session, year),
        "fields": financials.field_breakeven(session, year),
        "note": "Breakeven shows only where costs AND harvested bushels exist — missing pieces are listed, never estimated.",
    }


@router.get("/financials/schedule-f")
def schedule_f(
    year: int,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    """Whole-farm transactions rolled up to Schedule F lines (from the
    versioned tax pack). Uncategorized money is surfaced, never guessed."""
    return financials.schedule_f(session, year)


@router.get("/financials/lender-packet")
def lender_packet(
    year: int,
    format: str = Query("json", pattern="^(json|html)$"),
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    """Income statement + enterprise detail + grain position, assembled from
    records, with an explicit 'not included' section (no balance sheet). HTML
    format is a self-contained printable page the PWA prints to PDF."""
    packet = lender_packet_svc.build(session, year)
    if format == "html":
        return HTMLResponse(content=lender_packet_svc.render_html(packet))
    return packet


# --------------------------------------------------------------- cash flow / operating line


class OperatingLoanIn(BaseModel):
    client_id: uuid.UUID | None = None
    name: str
    lender: str | None = None
    credit_limit_usd: float = PField(ge=0)
    interest_rate_pct: float | None = None
    crop_year: int | None = None
    opened_on: date | None = None
    notes: str | None = None


class LoanEventIn(BaseModel):
    client_id: uuid.UUID | None = None
    occurred_on: date
    event_type: str = PField(pattern="^(draw|paydown|interest)$")
    amount: float = PField(gt=0)
    description: str | None = None


def _loan_view(loan: OperatingLoan) -> dict:
    return {
        "id": str(loan.id),
        "name": loan.name,
        "lender": loan.lender,
        "credit_limit_usd": float(loan.credit_limit_usd),
        "interest_rate_pct": float(loan.interest_rate_pct) if loan.interest_rate_pct is not None else None,
        "crop_year": loan.crop_year,
        "opened_on": loan.opened_on.isoformat() if loan.opened_on else None,
        "notes": loan.notes,
    }


@router.get("/operating-loans")
def list_operating_loans(
    year: int | None = None,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    return cashflow.operating_line(session, year or date.today().year)


@router.post("/operating-loans", status_code=201)
def create_operating_loan(
    body: OperatingLoanIn,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    if body.client_id is not None:
        existing = session.scalar(select(OperatingLoan).where(OperatingLoan.client_id == body.client_id))
        if existing is not None:
            return _loan_view(existing)
    loan = OperatingLoan(
        client_id=body.client_id,
        name=body.name,
        lender=body.lender,
        credit_limit_usd=body.credit_limit_usd,
        interest_rate_pct=body.interest_rate_pct,
        crop_year=body.crop_year,
        opened_on=body.opened_on,
        notes=body.notes,
    )
    session.add(loan)
    session.flush()
    session.add(AuditLog(user_id=user.id, action="operating_loan.create", entity_type="operating_loan", entity_id=loan.id))
    return _loan_view(loan)


@router.post("/operating-loans/{loan_id}/events", status_code=201)
def add_loan_event(
    loan_id: uuid.UUID,
    body: LoanEventIn,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    loan = session.get(OperatingLoan, loan_id)
    if loan is None:
        raise HTTPException(status_code=404, detail="unknown loan")
    if body.client_id is not None:
        existing = session.scalar(select(OperatingLoanEvent).where(OperatingLoanEvent.client_id == body.client_id))
        if existing is not None:
            return {"id": str(existing.id), "loan_id": str(existing.loan_id)}
    event = OperatingLoanEvent(
        client_id=body.client_id,
        loan_id=loan.id,
        occurred_on=body.occurred_on,
        event_type=body.event_type,
        amount=body.amount,
        description=body.description,
    )
    session.add(event)
    session.flush()
    session.add(AuditLog(user_id=user.id, action="operating_loan.event", entity_type="operating_loan_event", entity_id=event.id))
    return {"id": str(event.id), "loan_id": str(event.loan_id), "event_type": event.event_type, "amount": float(event.amount)}


@router.get("/financials/cash-flow")
def cash_flow(
    year: int,
    session: Session = Depends(get_session),
    user: AppUser = Depends(auth.current_user),
):
    """Monthly projected cash position: budget-derived outflow (typical timing),
    priced-contract inflow, actuals, and the operating-line balance. Gaps named."""
    return cashflow.cash_flow(session, year)
