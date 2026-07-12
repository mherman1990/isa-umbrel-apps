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


class PackStackingRule(BaseModel):
    """Whether program_a and program_b can pay on the same acres."""

    rule_key: str
    program_a: str
    program_b: str
    relation: str = Field(pattern="^(exclusive|stackable)$")
    description: str
    citation: str
    source_url: str
    last_verified: date
    verify_by: date


class PackEvidenceRequirement(BaseModel):
    """A specific artifact the program will demand at verification."""

    req_key: str
    practice_type: str
    artifact_kind: str = Field(pattern="^(photo|document|operation|any)$")
    subject: str
    window_start_md: str | None = None  # 'MM-DD' relative to crop_year + year_offset
    window_end_md: str | None = None
    year_offset: int = 0  # 0 = fall before the crop year's spring crop... state explicitly per program
    verifier_grade_required: bool = False
    description: str
    citation: str
    source_url: str
    last_verified: date
    verify_by: date


class PackProgram(BaseModel):
    program_key: str
    name: str
    agency: str
    tier: str = Field(pattern="^(federal|state|private)$")
    summary: str
    payment_rate: str | None = None
    payment_per_acre: float | None = None  # representative $/ac where honestly computable
    signup_deadline: str | None = None
    signup_deadline_date: date | None = None  # machine-readable, drives deadline nudges
    source_url: str
    last_verified: date
    verify_by: date
    unverified: bool = False  # explicit flag for seed data we could not confirm
    rules: list[PackRule] = []
    evidence_requirements: list[PackEvidenceRequirement] = []


class PackCompliance(BaseModel):
    """Legal recordkeeping requirements for the region (RUP records etc.)."""

    rup_retention_years: int
    rup_required_fields: list[str]  # keys the compliance checker looks for
    citation: str
    source_url: str
    last_verified: date
    verify_by: date


# --------------------------------------------------------------------------- agronomy
# Agronomic decision-support DATA (N-rate/MRTN, fungicide ROI, practice costs).
# Like `compliance`, these sections are READ AT COMPUTE TIME from the pack file
# (never loaded into DB tables) — so they carry their own citation/verify_by and
# the engine degrades them to "unverified" past verify_by, exactly like programs.


class PackMrtnRotation(BaseModel):
    """Quadratic-plateau corn N response for one rotation.

    delta_yield(N) = b1*N - b2*N^2 (bu/ac over zero N), plateauing at the
    agronomic maximum N = b1/(2*b2). The economic optimum (EONR / MRTN) is
    derived from prices at compute time.
    """

    label: str
    marginal_bu_per_lb: float = Field(gt=0)  # b1: bu/ac gain per lb N at low N
    curvature: float = Field(gt=0)  # b2: quadratic term (>0)
    agronomic_max_lb: float | None = None  # plateau join; defaults to b1/(2*b2)


class PackMrtn(BaseModel):
    crop: str = "corn"
    unit: str = "lb N/ac"
    citation: str
    source_url: str
    last_verified: date
    verify_by: date
    unverified: bool = False  # coefficients approximated from published MRTN — confirm at source_url
    rotations: dict[str, PackMrtnRotation]


class PackFungicideCrop(BaseModel):
    unit: str = "bu/ac"
    responses: dict[str, float]  # disease-pressure level -> expected yield response


class PackFungicideRoi(BaseModel):
    citation: str
    source_url: str
    last_verified: date
    verify_by: date
    unverified: bool = False
    crops: dict[str, PackFungicideCrop]


class PackPracticeCosts(BaseModel):
    citation: str
    source_url: str
    last_verified: date
    verify_by: date
    unverified: bool = False
    costs: dict[str, float]  # practice_type -> typical annual cost $/ac


class RegionPackFile(BaseModel):
    region_code: str  # 'US-IA'
    version: str  # '2026.1'
    description: str = ""
    programs: list[PackProgram]
    stacking_rules: list[PackStackingRule] = []
    compliance: PackCompliance | None = None
    mrtn: PackMrtn | None = None
    fungicide_roi: PackFungicideRoi | None = None
    practice_costs: PackPracticeCosts | None = None
