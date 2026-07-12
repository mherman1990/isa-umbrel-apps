"""Validation schema for cash-flow timing packs.

A pack maps expense categories to a per-month weight distribution (weights
summing to ~1.0), carrying source_url + verify_by like every other pack.
"""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict, field_validator, model_validator


class CashflowPack(BaseModel):
    model_config = ConfigDict(extra="forbid")

    region_code: str
    version: str
    source_url: str
    last_verified: date
    verify_by: date
    notes: str | None = None
    expense_timing: dict[str, dict[int, float]]

    @field_validator("expense_timing")
    @classmethod
    def _months_and_weights(cls, timing: dict[str, dict[int, float]]) -> dict[str, dict[int, float]]:
        for category, dist in timing.items():
            for month in dist:
                if not 1 <= month <= 12:
                    raise ValueError(f"{category}: month {month} out of range 1-12")
            total = sum(dist.values())
            if abs(total - 1.0) > 0.001:
                raise ValueError(f"{category}: weights sum to {total}, must be 1.0")
        return timing

    @model_validator(mode="after")
    def _verify_by_after(self):
        if self.verify_by <= self.last_verified:
            raise ValueError("verify_by must be after last_verified")
        return self
