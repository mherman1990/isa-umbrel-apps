"""Core data model.

Conventions:
- UUID primary keys, created_at/updated_at everywhere.
- client_id on client-creatable rows: generated on the device, UNIQUE here,
  so offline batch upload is idempotent by construction.
- Geometry SRID 4326.
- FSA-578 fields are first-class columns named to the CART/NIEM standard
  where one exists (FarmNumber, TractNumber, FieldNumber, CropYear,
  OriginalPlantedDate, IntendedUse, IrrigationPractice). A CropYear that
  cannot emit a valid 578 is an incomplete CropYear.
- capture_event rows and their artifacts are append-only and never deleted;
  every structured record links back to the capture it came from.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime

from geoalchemy2 import Geometry
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def uuid_pk():
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def created_at_col():
    return mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


def updated_at_col():
    return mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


# --------------------------------------------------------------------------- identity


class AppUser(Base):
    __tablename__ = "app_user"

    id: Mapped[uuid.UUID] = uuid_pk()
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(
        String(16), nullable=False, default="owner", server_default="owner"
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=text("true"))
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint("role IN ('owner','operator','advisor','readonly')", name="app_user_role_ck"),
    )


class DeviceToken(Base):
    __tablename__ = "device_token"

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("app_user.id", ondelete="CASCADE"), nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)  # sha256; plaintext never stored
    device_name: Mapped[str] = mapped_column(Text, nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()


class PairingCode(Base):
    __tablename__ = "pairing_code"

    code: Mapped[str] = mapped_column(String(6), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("app_user.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="operator", server_default="operator")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()


# --------------------------------------------------------------------------- farm structure


class RegionPackRow(Base):
    __tablename__ = "region_pack"

    id: Mapped[uuid.UUID] = uuid_pk()
    region_code: Mapped[str] = mapped_column(String(16), nullable=False)  # 'US-IA'
    version: Mapped[str] = mapped_column(String(32), nullable=False)  # '2026.1'
    source_path: Mapped[str] = mapped_column(Text, nullable=False)
    content_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    loaded_at: Mapped[datetime] = created_at_col()

    __table_args__ = (UniqueConstraint("region_code", "version", name="region_pack_version_uq"),)


class FarmProfile(Base):
    """Singleton — one operation per box. Every module reads from this."""

    __tablename__ = "farm_profile"

    id: Mapped[uuid.UUID] = uuid_pk()
    operation_name: Mapped[str] = mapped_column(Text, nullable=False)
    state_code: Mapped[str] = mapped_column(String(2), nullable=False, default="IA", server_default="IA")
    county_ansi_code: Mapped[str | None] = mapped_column(String(3))
    region_pack_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("region_pack.id"))
    entity_type: Mapped[str | None] = mapped_column(Text)  # sole prop / LLC / partnership
    crops: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    # e.g. {"corn": {"acres": 300, "storage_bu": 40000}, "soybeans": {"acres": 300, "storage_bu": 0}}
    tenure: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    tillage_system: Mapped[str | None] = mapped_column(Text)
    beginning_farmer: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    practice_history: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    # 5-question onboarding practice screen: cover_crops, no_till_since, nutrient_mgmt, hel_acres, enrolled_programs
    monthly_spend_cap_usd: Mapped[float] = mapped_column(Numeric(8, 2), nullable=False, default=20, server_default="20.00")
    anthropic_key_set: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    onboarding_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()


class Farm(Base):
    """An FSA farm (a profile can span several FSA farm numbers)."""

    __tablename__ = "farm"

    id: Mapped[uuid.UUID] = uuid_pk()
    farm_profile_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("farm_profile.id"), nullable=False)
    farm_number: Mapped[str] = mapped_column(Text, nullable=False)  # CART: FarmNumber
    state_ansi_code: Mapped[str] = mapped_column(String(2), nullable=False)
    county_ansi_code: Mapped[str] = mapped_column(String(3), nullable=False)
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        UniqueConstraint("state_ansi_code", "county_ansi_code", "farm_number", name="farm_fsa_uq"),
    )


class Field(Base):
    __tablename__ = "field"

    id: Mapped[uuid.UUID] = uuid_pk()
    farm_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("farm.id"), nullable=False)
    tract_number: Mapped[str] = mapped_column(Text, nullable=False)  # CART: TractNumber
    field_number: Mapped[str] = mapped_column(Text, nullable=False)  # CART: FieldNumber
    clu_identifier: Mapped[str | None] = mapped_column(Text)  # CLUID from farmers.gov export
    name: Mapped[str | None] = mapped_column(Text)  # farmer's nickname ("North 80")
    boundary = mapped_column(Geometry("MULTIPOLYGON", srid=4326), nullable=False)
    clu_calculated_acres: Mapped[float | None] = mapped_column(Numeric(10, 2))  # acres attr from export
    gis_acres: Mapped[float | None] = mapped_column(Numeric(10, 2))  # recomputed, sanity-check pair
    productivity_index: Mapped[float | None] = mapped_column(Numeric(6, 2))  # CSR2 in Iowa
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="clu_import", server_default="clu_import")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    __table_args__ = (
        UniqueConstraint("farm_id", "tract_number", "field_number", name="field_fsa_uq"),
        CheckConstraint("source IN ('clu_import','manual','geojson')", name="field_source_ck"),
        # spatial index: GeoAlchemy2 creates idx_field_boundary automatically
    )


class Lease(Base):
    __tablename__ = "lease"

    id: Mapped[uuid.UUID] = uuid_pk()
    field_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("field.id"), nullable=False)
    lease_type: Mapped[str] = mapped_column(String(16), nullable=False)
    landlord_name: Mapped[str | None] = mapped_column(Text)
    producer_share: Mapped[float | None] = mapped_column(Numeric(5, 4))  # 1.0 if owned
    rent_per_acre: Mapped[float | None] = mapped_column(Numeric(10, 2))
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date | None] = mapped_column(Date)
    document_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("document.id"))
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint("lease_type IN ('owned','cash_rent','crop_share','flex')", name="lease_type_ck"),
    )


# --------------------------------------------------------------------------- FSA-578 first-class


class CropYear(Base):
    __tablename__ = "crop_year"

    id: Mapped[uuid.UUID] = uuid_pk()
    field_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("field.id"), nullable=False)
    crop_year: Mapped[int] = mapped_column(SmallInteger, nullable=False)  # CART: CropYear
    crop_code: Mapped[str] = mapped_column(Text, nullable=False)  # FSA crop code ('0041' corn, '0081' soybeans)
    crop_name: Mapped[str] = mapped_column(Text, nullable=False)
    crop_type_code: Mapped[str | None] = mapped_column(Text)
    variety: Mapped[str | None] = mapped_column(Text)
    intended_use_code: Mapped[str] = mapped_column(String(4), nullable=False, default="GR", server_default="GR")
    reported_acres: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    boundary = mapped_column(Geometry("MULTIPOLYGON", srid=4326))  # subfield planting boundary; NULL = whole field
    original_planted_date: Mapped[date | None] = mapped_column(Date)  # CART: OriginalPlantedDate
    final_planted_date: Mapped[date | None] = mapped_column(Date)
    planting_pattern: Mapped[str | None] = mapped_column(Text)
    producer_share: Mapped[float] = mapped_column(Numeric(5, 4), nullable=False, default=1, server_default="1.0")
    irrigation_practice_code: Mapped[str] = mapped_column(String(1), nullable=False, default="N", server_default="N")
    prevented_planted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    failed_acres: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    __table_args__ = (
        UniqueConstraint("field_id", "crop_year", "crop_code", "intended_use_code", name="crop_year_uq"),
        CheckConstraint("irrigation_practice_code IN ('I','N','O')", name="crop_year_irrigation_ck"),
    )


# --------------------------------------------------------------------------- operations & inputs


class Product(Base):
    __tablename__ = "product"

    id: Mapped[uuid.UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(String(16), nullable=False)
    epa_reg_number: Mapped[str | None] = mapped_column(Text)  # restricted-use chem records
    default_unit: Mapped[str] = mapped_column(Text, nullable=False, default="unit", server_default="unit")
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        UniqueConstraint("name", "category", name="product_name_uq"),
        CheckConstraint(
            "category IN ('seed','herbicide','insecticide','fungicide','fertilizer','fuel','other')",
            name="product_category_ck",
        ),
    )


class InputInventory(Base):
    __tablename__ = "input_inventory"

    id: Mapped[uuid.UUID] = uuid_pk()
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("product.id"), nullable=False, unique=True)
    quantity: Mapped[float] = mapped_column(Numeric(12, 3), nullable=False, default=0, server_default="0")
    unit: Mapped[str] = mapped_column(Text, nullable=False)
    unit_cost: Mapped[float | None] = mapped_column(Numeric(10, 2))
    location: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = updated_at_col()


class FieldOperation(Base):
    __tablename__ = "field_operation"

    id: Mapped[uuid.UUID] = uuid_pk()
    client_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), unique=True)  # offline idempotency
    field_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("field.id"), nullable=False)
    crop_year_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("crop_year.id"))
    op_type: Mapped[str] = mapped_column(String(16), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    acres_covered: Mapped[float | None] = mapped_column(Numeric(10, 2))
    notes: Mapped[str | None] = mapped_column(Text)
    operator_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("app_user.id"))
    source_capture_event_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("capture_event.id"))
    details: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    # op-specific: rate, carrier gal/ac, wind mph + direction, temp, yield, moisture...
    weather: Mapped[dict | None] = mapped_column(JSONB)  # auto-attached at occurred_at (adapter, optional)
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    __table_args__ = (
        CheckConstraint(
            "op_type IN ('plant','spray','fertilize','till','harvest','scout','irrigate','other')",
            name="field_operation_type_ck",
        ),
        Index("field_operation_field_ix", "field_id", "occurred_at"),
    )


class OperationProduct(Base):
    """N products per operation — tank mixes."""

    __tablename__ = "operation_product"

    operation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("field_operation.id", ondelete="CASCADE"), primary_key=True
    )
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("product.id"), primary_key=True)
    rate: Mapped[float | None] = mapped_column(Numeric(12, 4))
    rate_unit: Mapped[str | None] = mapped_column(Text)  # 'oz/ac', 'lbs/ac', 'seeds/ac'
    total_quantity: Mapped[float | None] = mapped_column(Numeric(12, 3))
    unit: Mapped[str | None] = mapped_column(Text)


# --------------------------------------------------------------------------- capture pipeline

CAPTURE_STATUSES = (
    "recorded",
    "transcribing",
    "transcribed",
    "parsing",
    "parsed",
    "queued",
    "confirmed",
    "rejected",
    "failed",
)


class CaptureEvent(Base):
    """Append-only. The raw artifact is NEVER deleted (hard requirement)."""

    __tablename__ = "capture_event"

    id: Mapped[uuid.UUID] = uuid_pk()
    client_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("app_user.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    artifact_path: Mapped[str] = mapped_column(Text, nullable=False)  # relative to DATA_DIR
    artifact_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    mime_type: Mapped[str] = mapped_column(Text, nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)  # device clock
    uploaded_at: Mapped[datetime] = created_at_col()
    device_gps = mapped_column(Geometry("POINT", srid=4326))
    provenance: Mapped[str] = mapped_column(String(16), nullable=False, default="captured", server_default="captured")
    timestamp_proof: Mapped[dict | None] = mapped_column(JSONB)  # OpenTimestamps (Phase 2 batch fills this)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="recorded", server_default="recorded")
    status_detail: Mapped[str | None] = mapped_column(Text)
    transcript: Mapped[str | None] = mapped_column(Text)  # whisper output (voice only)

    __table_args__ = (
        CheckConstraint("kind IN ('voice','photo','file','text')", name="capture_kind_ck"),
        CheckConstraint("provenance IN ('captured','imported')", name="capture_provenance_ck"),
        CheckConstraint(
            "status IN " + repr(CAPTURE_STATUSES).replace('"', "'"),
            name="capture_status_ck",
        ),
        Index("capture_event_status_ix", "status"),
    )


PARSE_TARGET_TYPES = (
    "field_operation",
    "input_inventory",
    "equipment_issue",
    "crop_year",
    "document",
    "product",
    "note",
)


class ParseResult(Base):
    """One capture → N of these (multi-record extraction is the norm)."""

    __tablename__ = "parse_result"

    id: Mapped[uuid.UUID] = uuid_pk()
    capture_event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("capture_event.id"), nullable=False)
    seq: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    target_type: Mapped[str] = mapped_column(String(24), nullable=False)
    extracted: Mapped[dict] = mapped_column(JSONB, nullable=False)
    confidence: Mapped[float] = mapped_column(Numeric(4, 3), nullable=False)
    model_used: Mapped[str] = mapped_column(Text, nullable=False)
    prompt_version: Mapped[str] = mapped_column(Text, nullable=False)
    ambiguities: Mapped[list] = mapped_column(JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        UniqueConstraint("capture_event_id", "seq", name="parse_result_seq_uq"),
        CheckConstraint(
            "target_type IN " + repr(PARSE_TARGET_TYPES).replace('"', "'"),
            name="parse_target_ck",
        ),
    )


class ConfirmationQueueItem(Base):
    __tablename__ = "confirmation_queue_item"

    id: Mapped[uuid.UUID] = uuid_pk()
    parse_result_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("parse_result.id"), nullable=False, unique=True
    )
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="pending", server_default="pending")
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("app_user.id"))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    final_payload: Mapped[dict | None] = mapped_column(JSONB)  # payload after farmer edits
    created_record_type: Mapped[str | None] = mapped_column(Text)
    created_record_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint("state IN ('pending','confirmed','edited','rejected')", name="cqi_state_ck"),
        Index("cqi_state_ix", "state"),
    )


class Document(Base):
    """Routed photos/PDFs: receipts, leases, FSA letters, soil tests — the vault."""

    __tablename__ = "document"

    id: Mapped[uuid.UUID] = uuid_pk()
    capture_event_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("capture_event.id"))
    doc_type: Mapped[str] = mapped_column(String(24), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    extracted: Mapped[dict | None] = mapped_column(JSONB)  # OCR/LLM structured fields
    related_field_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("field.id"))
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint(
            "doc_type IN ('receipt','scale_ticket','seed_tag','applicator_record','lease',"
            "'fsa_form','insurance','soil_test','contract','other')",
            name="document_type_ck",
        ),
    )


# --------------------------------------------------------------------------- programs / region pack


class Program(Base):
    __tablename__ = "program"

    id: Mapped[uuid.UUID] = uuid_pk()
    region_pack_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("region_pack.id"), nullable=False)
    program_key: Mapped[str] = mapped_column(Text, nullable=False)  # 'eqip', 'idals-cover-crop', ...
    name: Mapped[str] = mapped_column(Text, nullable=False)
    agency: Mapped[str] = mapped_column(Text, nullable=False)  # FSA / NRCS / IDALS / RMA / private
    tier: Mapped[str] = mapped_column(String(16), nullable=False, default="state", server_default="state")
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    payment_rate: Mapped[str | None] = mapped_column(Text)  # human-readable; rates too varied for numeric
    payment_per_acre: Mapped[float | None] = mapped_column(Numeric(10, 2))  # representative $/ac where computable
    signup_deadline: Mapped[str | None] = mapped_column(Text)  # may be a window, not a date
    signup_deadline_date: Mapped[date | None] = mapped_column(Date)  # machine-readable, for nudges
    source_url: Mapped[str] = mapped_column(Text, nullable=False)
    last_verified: Mapped[date] = mapped_column(Date, nullable=False)
    verify_by: Mapped[date] = mapped_column(Date, nullable=False)
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        UniqueConstraint("region_pack_id", "program_key", name="program_key_uq"),
        CheckConstraint("tier IN ('federal','state','private')", name="program_tier_ck"),
    )


class EligibilityRule(Base):
    __tablename__ = "eligibility_rule"

    id: Mapped[uuid.UUID] = uuid_pk()
    program_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("program.id", ondelete="CASCADE"), nullable=False)
    rule_key: Mapped[str] = mapped_column(Text, nullable=False)
    predicate: Mapped[dict | None] = mapped_column(JSONB)  # machine-checkable where possible
    description: Mapped[str] = mapped_column(Text, nullable=False)
    citation: Mapped[str] = mapped_column(Text, nullable=False)
    source_url: Mapped[str] = mapped_column(Text, nullable=False)
    last_verified: Mapped[date] = mapped_column(Date, nullable=False)
    verify_by: Mapped[date] = mapped_column(Date, nullable=False)

    __table_args__ = (UniqueConstraint("program_id", "rule_key", name="eligibility_rule_uq"),)


# --------------------------------------------------------------------------- conservation (Phase 3)

PRACTICE_TYPES = (
    "tillage",  # attributes: {"class": "no-till|strip|reduced|conventional"}
    "cover_crop",  # {"species", "seeding_date", "termination_date", "termination_method"}
    "nutrient_mgmt",  # {"rate", "timing", "source", "inhibitor", "split"}
    "edge_of_field",  # {"structure": "bioreactor|saturated_buffer|wetland"}
    "buffer",
    "waterway",
    "terrace",
    "other",
)


class Practice(Base):
    """What was actually done on which acres, which is what programs pay
    for. Every practice carries its evidence (captures/documents), and via
    the capture layer, timestamp proofs."""

    __tablename__ = "practice"

    id: Mapped[uuid.UUID] = uuid_pk()
    field_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("field.id"), nullable=False)
    crop_year: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    practice_type: Mapped[str] = mapped_column(String(16), nullable=False)
    acres: Mapped[float | None] = mapped_column(Numeric(10, 2))  # NULL = whole field
    attributes: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    __table_args__ = (
        CheckConstraint("practice_type IN " + repr(PRACTICE_TYPES).replace('"', "'"), name="practice_type_ck"),
        Index("practice_field_year_ix", "field_id", "crop_year"),
    )


class PracticeEvidence(Base):
    __tablename__ = "practice_evidence"

    id: Mapped[uuid.UUID] = uuid_pk()
    practice_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("practice.id", ondelete="CASCADE"), nullable=False)
    capture_event_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("capture_event.id"))
    document_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("document.id"))
    field_operation_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("field_operation.id"))
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint(
            "capture_event_id IS NOT NULL OR document_id IS NOT NULL OR field_operation_id IS NOT NULL",
            name="practice_evidence_target_ck",
        ),
    )


class ProgramEnrollment(Base):
    """Which program the farm is in (or weighing) on which acres — the
    stacking checker's 'already enrolled' input."""

    __tablename__ = "program_enrollment"

    id: Mapped[uuid.UUID] = uuid_pk()
    program_key: Mapped[str] = mapped_column(Text, nullable=False)
    crop_year: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    field_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("field.id"))  # NULL = whole-operation
    acres: Mapped[float | None] = mapped_column(Numeric(10, 2))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="enrolled", server_default="enrolled")
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint("status IN ('enrolled','considering','declined')", name="program_enrollment_status_ck"),
    )


class EvidenceRequirement(Base):
    """What a program will DEMAND at verification — region-pack data.
    'SWOF wants a termination photo of the field between Apr 1 and May 15'
    is a row here; the MRV readiness report evaluates against it."""

    __tablename__ = "evidence_requirement"

    id: Mapped[uuid.UUID] = uuid_pk()
    program_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("program.id", ondelete="CASCADE"), nullable=False)
    req_key: Mapped[str] = mapped_column(Text, nullable=False)
    practice_type: Mapped[str] = mapped_column(String(16), nullable=False)  # which practice it attaches to
    artifact_kind: Mapped[str] = mapped_column(String(16), nullable=False)  # photo | document | operation | any
    subject: Mapped[str] = mapped_column(Text, nullable=False)  # 'establishment photo', 'seed receipt'...
    window_start_md: Mapped[str | None] = mapped_column(String(5))  # 'MM-DD', relative to crop_year + offset
    window_end_md: Mapped[str | None] = mapped_column(String(5))
    year_offset: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0, server_default="0")
    verifier_grade_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    description: Mapped[str] = mapped_column(Text, nullable=False)
    citation: Mapped[str] = mapped_column(Text, nullable=False)
    source_url: Mapped[str] = mapped_column(Text, nullable=False)
    last_verified: Mapped[date] = mapped_column(Date, nullable=False)
    verify_by: Mapped[date] = mapped_column(Date, nullable=False)

    __table_args__ = (
        UniqueConstraint("program_id", "req_key", name="evidence_requirement_uq"),
        CheckConstraint("artifact_kind IN ('photo','document','operation','any')", name="evidence_req_kind_ck"),
    )


class StackingRule(Base):
    """Whether two programs can pay on the same acres — encoded as data
    from the region pack, cited, and verify_by-dated like everything else."""

    __tablename__ = "stacking_rule"

    id: Mapped[uuid.UUID] = uuid_pk()
    region_pack_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("region_pack.id", ondelete="CASCADE"), nullable=False)
    rule_key: Mapped[str] = mapped_column(Text, nullable=False)
    program_a: Mapped[str] = mapped_column(Text, nullable=False)  # program_key
    program_b: Mapped[str] = mapped_column(Text, nullable=False)
    relation: Mapped[str] = mapped_column(String(16), nullable=False)  # exclusive | stackable
    description: Mapped[str] = mapped_column(Text, nullable=False)
    citation: Mapped[str] = mapped_column(Text, nullable=False)
    source_url: Mapped[str] = mapped_column(Text, nullable=False)
    last_verified: Mapped[date] = mapped_column(Date, nullable=False)
    verify_by: Mapped[date] = mapped_column(Date, nullable=False)

    __table_args__ = (
        UniqueConstraint("region_pack_id", "rule_key", name="stacking_rule_uq"),
        CheckConstraint("relation IN ('exclusive','stackable')", name="stacking_relation_ck"),
    )


# --------------------------------------------------------------------------- money & agronomy (Phase 2)


class MoneyTransaction(Base):
    """A farm transaction. Enterprise allocation (field/crop) is optional —
    unallocated is honest; fabricated allocation is not."""

    __tablename__ = "money_transaction"

    id: Mapped[uuid.UUID] = uuid_pk()
    client_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), unique=True)
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False, default="expense", server_default="expense")
    category: Mapped[str] = mapped_column(Text, nullable=False, default="other", server_default="other")
    amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)  # positive; kind carries direction
    crop: Mapped[str | None] = mapped_column(Text)  # enterprise: 'corn', 'soybeans'
    field_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("field.id"))
    crop_year: Mapped[int | None] = mapped_column(SmallInteger)
    document_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("document.id"))  # the receipt
    source: Mapped[dict | None] = mapped_column(JSONB)  # {workbook_sha, sheet, row} for imports
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint("kind IN ('expense','income')", name="money_transaction_kind_ck"),
        CheckConstraint("amount >= 0", name="money_transaction_amount_ck"),
        Index("money_transaction_date_ix", "occurred_on"),
    )


class BudgetLine(Base):
    __tablename__ = "budget_line"

    id: Mapped[uuid.UUID] = uuid_pk()
    crop_year: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    crop: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(Text, nullable=False)
    amount_per_acre: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    source: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (UniqueConstraint("crop_year", "crop", "category", name="budget_line_uq"),)


class OperatingLoan(Base):
    """An operating line of credit: its limit and its draw/paydown ledger.
    The cash-flow view shows outstanding balance vs. the projected need. The
    balance is DERIVED from the event ledger, never stored — records, not a
    fabricated figure."""

    __tablename__ = "operating_loan"

    id: Mapped[uuid.UUID] = uuid_pk()
    client_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), unique=True)  # offline idempotency
    name: Mapped[str] = mapped_column(Text, nullable=False)
    lender: Mapped[str | None] = mapped_column(Text)
    credit_limit_usd: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    interest_rate_pct: Mapped[float | None] = mapped_column(Numeric(6, 3))
    crop_year: Mapped[int | None] = mapped_column(SmallInteger)  # NULL = not tied to one year
    opened_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    __table_args__ = (CheckConstraint("credit_limit_usd >= 0", name="operating_loan_limit_ck"),)


class OperatingLoanEvent(Base):
    """A draw, paydown, or interest charge on an operating loan."""

    __tablename__ = "operating_loan_event"

    id: Mapped[uuid.UUID] = uuid_pk()
    client_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), unique=True)  # offline idempotency
    loan_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("operating_loan.id", ondelete="CASCADE"), nullable=False
    )
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    event_type: Mapped[str] = mapped_column(String(12), nullable=False)  # draw | paydown | interest
    amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)  # positive; type carries direction
    description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at_col()

    __table_args__ = (
        CheckConstraint("event_type IN ('draw','paydown','interest')", name="operating_loan_event_type_ck"),
        CheckConstraint("amount > 0", name="operating_loan_event_amount_ck"),
        Index("operating_loan_event_loan_ix", "loan_id", "occurred_on"),
    )


class SoilTest(Base):
    __tablename__ = "soil_test"

    id: Mapped[uuid.UUID] = uuid_pk()
    field_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("field.id"), nullable=False)
    sampled_on: Mapped[date | None] = mapped_column(Date)
    lab: Mapped[str | None] = mapped_column(Text)
    results: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    document_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("document.id"))
    created_at: Mapped[datetime] = created_at_col()


class WorkbookMapping(Base):
    """A workbook's confirmed tab/column mapping, keyed by content hash so
    re-importing next month's copy of the same book is one tap."""

    __tablename__ = "workbook_mapping"

    id: Mapped[uuid.UUID] = uuid_pk()
    filename: Mapped[str] = mapped_column(Text, nullable=False)
    content_sha256: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    proposal: Mapped[dict | None] = mapped_column(JSONB)  # model-proposed mapping
    mapping: Mapped[dict | None] = mapped_column(JSONB)  # farmer-confirmed mapping
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    imported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    import_result: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = created_at_col()


# --------------------------------------------------------------------------- grain marketing (Phase 4 records)


class GrainContract(Base):
    """A cash grain contract — a RECORD, not advice. The position ledger
    derives contracted/priced/unpriced from these."""

    __tablename__ = "grain_contract"

    id: Mapped[uuid.UUID] = uuid_pk()
    client_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), unique=True)
    crop: Mapped[str] = mapped_column(Text, nullable=False)  # 'corn', 'soybeans'
    crop_year: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    contract_type: Mapped[str] = mapped_column(String(16), nullable=False)  # cash | hta | basis | futures | options
    bushels: Mapped[float] = mapped_column(Numeric(12, 1), nullable=False)
    price_per_bu: Mapped[float | None] = mapped_column(Numeric(8, 4))  # NULL = unpriced leg (HTA/basis open)
    basis: Mapped[float | None] = mapped_column(Numeric(6, 4))
    elevator: Mapped[str | None] = mapped_column(Text)
    contract_number: Mapped[str | None] = mapped_column(Text)
    delivery_start: Mapped[date | None] = mapped_column(Date)
    delivery_end: Mapped[date | None] = mapped_column(Date)
    delivered_bushels: Mapped[float] = mapped_column(Numeric(12, 1), nullable=False, default=0, server_default="0")
    document_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("document.id"))  # the paper contract
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    __table_args__ = (
        CheckConstraint("contract_type IN ('cash','hta','basis','futures','options')", name="grain_contract_type_ck"),
        CheckConstraint("bushels > 0", name="grain_contract_bushels_ck"),
        Index("grain_contract_crop_ix", "crop", "crop_year"),
    )


class DailyBrief(Base):
    """The morning readout: composed nightly from actual records (nudges,
    grain position, inbox, spend) — never fabricated farm facts."""

    __tablename__ = "daily_brief"

    id: Mapped[uuid.UUID] = uuid_pk()
    brief_date: Mapped[date] = mapped_column(Date, nullable=False, unique=True)
    body_md: Mapped[str] = mapped_column(Text, nullable=False)
    inputs: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    model_used: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at_col()


# --------------------------------------------------------------------------- metering / audit


class ApiSpend(Base):
    __tablename__ = "api_spend"

    id: Mapped[uuid.UUID] = uuid_pk()
    occurred_at: Mapped[datetime] = created_at_col()
    purpose: Mapped[str] = mapped_column(Text, nullable=False)  # 'voice_parse','doc_route',...
    model: Mapped[str] = mapped_column(Text, nullable=False)
    input_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False)
    output_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False)
    cost_usd: Mapped[float] = mapped_column(Numeric(10, 6), nullable=False)
    capture_event_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("capture_event.id"))

    __table_args__ = (Index("api_spend_occurred_ix", "occurred_at"),)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = created_at_col()
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("app_user.id"))
    action: Mapped[str] = mapped_column(Text, nullable=False)  # 'field.create','inbox.confirm',...
    entity_type: Mapped[str | None] = mapped_column(Text)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    detail: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
