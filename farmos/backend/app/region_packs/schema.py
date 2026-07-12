"""Region-pack file format.

Program rules ship as versioned DATA, never code (Hard Requirement /
Region packs). Every program and rule carries citation, source_url,
last_verified, and verify_by; past verify_by the engine auto-degrades the
entry to "unverified — confirm before acting" (staleness is enforced by
the engine, not by discipline).
"""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field, HttpUrl


class PackRule(BaseModel):
    rule_key: str
    description: str
    citation: str
    source_url: str
    last_verified: date
    verify_by: date
    # Machine-checkable predicate against the farm profile, or null for
    # rules that need human judgement. Ops: eq, in, gte, lte, truthy.
    predicate: dict | None = None


class PackProgram(BaseModel):
    program_key: str
    name: str
    agency: str
    tier: str = Field(pattern="^(federal|state|private)$")
    summary: str
    payment_rate: str | None = None
    signup_deadline: str | None = None
    signup_deadline_date: date | None = None  # machine-readable, drives deadline nudges
    source_url: str
    last_verified: date
    verify_by: date
    unverified: bool = False  # explicit flag for seed data we could not confirm
    rules: list[PackRule] = []


class RegionPackFile(BaseModel):
    region_code: str  # 'US-IA'
    version: str  # '2026.1'
    description: str = ""
    programs: list[PackProgram]
