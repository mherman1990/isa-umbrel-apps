"""Validation schema for tax-form line-map packs (Schedule F, ...).

Tax mappings are versioned DATA carrying source_url + verify_by, exactly
like region packs. Kept deliberately small: a pack is form metadata plus a
list of income lines and expense lines, each naming the transaction
categories that roll up to it.
"""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict


class TaxLine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    line: str  # Schedule F line label, e.g. "17" or "24b"
    name: str
    categories: list[str] = []


class TaxFormPack(BaseModel):
    model_config = ConfigDict(extra="forbid")

    form: str
    tax_year: int
    version: str
    source_url: str
    last_verified: date
    verify_by: date
    notes: str | None = None
    income_lines: list[TaxLine] = []
    expense_lines: list[TaxLine] = []
