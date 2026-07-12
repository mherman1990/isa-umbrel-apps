"""Sandbox demo farm — dummy data only, clearly labeled.

`python -m app.manage seed-demo` builds "Demo Farm (Sandbox)": fields with
Iowa-shaped boundaries, two crop years, operations with yields and tank
mixes, inventory, transactions + budget, contracts, scale tickets,
practices with evidence, an enrollment, and a capture sitting in the
confirmation inbox — everything the UI and API need to be exercised
without real farm data or an API key. Idempotent.
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings

DEMO_NAME = "Demo Farm (Sandbox)"


def _poly(lon: float, lat: float, w: float = 0.009, h: float = 0.009) -> str:
    return (f"SRID=4326;MULTIPOLYGON((({lon} {lat},{lon + w} {lat},{lon + w} {lat + h},"
            f"{lon} {lat + h},{lon} {lat})))")


def seed(session: Session) -> dict:
    from . import auth
    from .models import (
        AppUser, BudgetLine, CaptureEvent, ConfirmationQueueItem, CropYear, DailyBrief,
        Document, Farm, FarmProfile, Field, FieldOperation, GrainContract, InputInventory,
        Lease, MoneyTransaction, OperatingLoan, OperatingLoanEvent, OperationProduct, ParseResult,
        Practice, PracticeEvidence, Product, ProgramEnrollment,
    )

    existing = session.scalar(select(FarmProfile).where(FarmProfile.operation_name == DEMO_NAME))
    if existing is not None:
        return {"seeded": False, "note": "demo farm already present"}

    today = date.today()
    year = today.year

    profile = FarmProfile(
        operation_name=DEMO_NAME, state_code="IA", county_ansi_code="153",
        crops={"corn": {"acres": 320, "storage_bu": 40000}, "soybeans": {"acres": 300, "storage_bu": 0}},
        tillage_system="no-till", beginning_farmer=True,
        practice_history={"cover_crops": True, "enrolled_cover_crop_programs": []},
        onboarding_completed_at=datetime.now(timezone.utc),
    )
    session.add(profile)
    session.flush()

    owner = AppUser(id=uuid.uuid4(), display_name="Demo Farmer", role="owner")
    session.add(owner)
    session.flush()
    token = auth.mint_token(session, owner, "sandbox seed device")

    farm = Farm(farm_profile_id=profile.id, farm_number="4321", state_ansi_code="19", county_ansi_code="153")
    session.add(farm)
    session.flush()

    field_specs = [
        ("Home 80", "0101", "1", 80, -93.62, 42.02),
        ("North 40", "0101", "2", 40, -93.62, 42.04),
        ("Miller Place", "0102", "1", 160, -93.60, 42.02),
        ("Creek Bottom", "0102", "2", 60, -93.60, 42.05),
        ("School Section", "0103", "1", 120, -93.58, 42.03),
        ("East 80", "0103", "2", 80, -93.56, 42.02),
    ]
    fields: dict[str, Field] = {}
    for name, tract, fno, acres, lon, lat in field_specs:
        f = Field(farm_id=farm.id, tract_number=tract, field_number=fno, name=name,
                  clu_identifier=f"demo-clu-{tract}-{fno}", boundary=_poly(lon, lat),
                  clu_calculated_acres=acres, gis_acres=acres, source="clu_import")
        session.add(f)
        fields[name] = f
    session.flush()

    # rotation: corn/beans alternating across two years
    for i, (name, f) in enumerate(fields.items()):
        for yr, flip in ((year - 1, 0), (year, 1)):
            corn = (i + flip) % 2 == 0
            session.add(CropYear(
                field_id=f.id, crop_year=yr,
                crop_code="0041" if corn else "0081", crop_name="corn" if corn else "soybeans",
                reported_acres=float(f.gis_acres),
                original_planted_date=date(yr, 4, 28 if corn else 12) if yr <= year else None,
                producer_share=1.0,
            ))

    products = {}
    for name, cat, epa, unit in (
        ("Enlist One", "herbicide", None, "gal"),
        ("Roundup PowerMax", "herbicide", None, "gal"),
        ("Atrazine 4L", "herbicide", "100-497", "gal"),
        ("DKC62-89", "seed", None, "units"),
        ("P28T08X", "seed", None, "units"),
        ("UAN 32%", "fertilizer", None, "gal"),
        ("Cereal Rye", "seed", None, "bu"),
    ):
        p = Product(name=name, category=cat, epa_reg_number=epa, default_unit=unit)
        session.add(p)
        products[name] = p
    session.flush()
    session.add(InputInventory(product_id=products["Enlist One"].id, quantity=4, unit="jugs"))
    session.add(InputInventory(product_id=products["Cereal Rye"].id, quantity=120, unit="bu"))

    def op(field, op_type, when, details=None, acres=None, prods=()):
        row = FieldOperation(field_id=fields[field].id, op_type=op_type,
                             occurred_at=when, acres_covered=acres or float(fields[field].gis_acres),
                             operator_user_id=owner.id, details=details or {})
        session.add(row)
        session.flush()
        for pname, rate, unit, total in prods:
            session.add(OperationProduct(operation_id=row.id, product_id=products[pname].id,
                                         rate=rate, rate_unit=unit, total_quantity=total, unit=None))
        return row

    tz = timezone.utc
    op("Home 80", "plant", datetime(year, 4, 28, 14, 0, tzinfo=tz),
       {"variety": "DKC62-89", "population": 34000, "crop": "corn"},
       prods=[("DKC62-89", 34000, "seeds/ac", None)])
    op("North 40", "plant", datetime(year, 5, 12, 9, 0, tzinfo=tz),
       {"variety": "P28T08X", "population": 140000, "crop": "soybeans"},
       prods=[("P28T08X", 140000, "seeds/ac", None)])
    op("Home 80", "spray", datetime(year, 6, 8, 10, 30, tzinfo=tz),
       {"carrier_gal_per_ac": 15, "wind": "S 7 mph", "temp_f": 74, "crop": "corn",
        "applicator": "Demo Farmer", "applicator_certification": "IA-PA-00000"},
       prods=[("Atrazine 4L", 2, "qt/ac", 40), ("Roundup PowerMax", 32, "oz/ac", None)])
    op("North 40", "spray", datetime(year, 6, 20, 16, 0, tzinfo=tz),
       {"carrier_gal_per_ac": 20, "wind": "NW 9 mph", "crop": "soybeans"},
       prods=[("Enlist One", 32, "oz/ac", 10)])
    op("Miller Place", "scout", datetime(year, 6, 25, 8, 0, tzinfo=tz),
       {"crop": "corn"}, acres=None)
    # last year's harvests → position + breakeven have history
    op("Home 80", "harvest", datetime(year - 1, 10, 14, 18, 0, tzinfo=tz),
       {"yield_bu_per_ac": 214, "moisture_pct": 16.1, "crop": "corn"})
    op("North 40", "harvest", datetime(year - 1, 10, 2, 17, 0, tzinfo=tz),
       {"yield_bu_per_ac": 61.5, "moisture_pct": 12.4, "crop": "soybeans"})

    # money
    for when, desc, kind, cat, amount, crop in (
        (date(year, 3, 10), "Seed corn — co-op", "expense", "seed", 21400, "corn"),
        (date(year, 3, 10), "Bean seed", "expense", "seed", 9800, "soybeans"),
        (date(year, 4, 2), "Spring NH3 + UAN", "expense", "fertilizer", 28900, "corn"),
        (date(year, 5, 30), "Herbicide program", "expense", "herbicide", 11200, None),
        (date(year - 1, 11, 5), "Corn sale — 8,000 bu", "income", "grain", 36400, "corn"),
    ):
        session.add(MoneyTransaction(occurred_on=when, description=desc, kind=kind,
                                     category=cat, amount=amount, crop=crop))
    for crop, cat, per_ac in (("corn", "seed", 128), ("corn", "fertilizer", 205), ("corn", "chem", 62),
                              ("soybeans", "seed", 64), ("soybeans", "chem", 55)):
        session.add(BudgetLine(crop_year=year, crop=crop, category=cat, amount_per_acre=per_ac))

    session.add(GrainContract(crop="corn", crop_year=year, contract_type="cash", bushels=15000,
                              price_per_bu=4.62, elevator="Heartland Co-op", contract_number="C-1188",
                              delivery_start=date(year, 10, 1), delivery_end=date(year, 11, 15)))
    session.add(GrainContract(crop="soybeans", crop_year=year, contract_type="hta", bushels=8000,
                              elevator="Heartland Co-op"))

    # operating line with a draw/paydown ledger (balance is derived, not stored)
    loan = OperatingLoan(name="Heartland FCS operating line", lender="Farm Credit Services",
                         credit_limit_usd=350000, interest_rate_pct=7.75, crop_year=year,
                         opened_on=date(year, 1, 15))
    session.add(loan)
    session.flush()
    for etype, amt, when in (("draw", 120000, date(year, 4, 5)), ("draw", 60000, date(year, 6, 10)),
                             ("paydown", 90000, date(year - 1, 11, 20))):
        session.add(OperatingLoanEvent(loan_id=loan.id, event_type=etype, amount=amt, occurred_on=when))

    # tenure: some ground owned, some rented — feeds operating-mode scenarios
    session.add(Lease(field_id=fields["North 40"].id, lease_type="cash_rent", landlord_name="Iverson Trust",
                      producer_share=1.0, rent_per_acre=285, start_date=date(year, 1, 1)))
    session.add(Lease(field_id=fields["Miller Place"].id, lease_type="crop_share", landlord_name="Bell Family",
                      producer_share=0.5, start_date=date(year, 1, 1)))

    # documents incl. a scale ticket that feeds the position ledger
    session.add(Document(doc_type="scale_ticket", title="Heartland ticket 5512 (demo)",
                         file_path="artifacts/demo/ticket.jpg",
                         extracted={"commodity": "corn", "net_bushels": 986.2,
                                    "moisture_pct": 15.8, "date": f"{year - 1}-10-15"}))
    session.add(Document(doc_type="seed_tag", title="Cereal rye seed tag (demo)",
                         file_path="artifacts/demo/tag.jpg",
                         extracted={"variety": "cereal rye VNS", "germination_pct": 92}))

    # practice + evidence + enrollment → readiness/stacking have real inputs
    rye = Practice(field_id=fields["Home 80"].id, crop_year=year + 1, practice_type="cover_crop",
                   attributes={"species": "cereal rye", "seeding_date": f"{year}-10-05"})
    session.add(rye)
    session.flush()
    estab_photo = CaptureEvent(
        client_id=uuid.uuid4(), user_id=owner.id, kind="photo",
        artifact_path="artifacts/demo/rye.jpg",
        artifact_sha256=hashlib.sha256(b"demo rye photo").hexdigest(),
        mime_type="image/jpeg", captured_at=datetime(year, 10, 20, 15, 0, tzinfo=tz),
        provenance="captured", status="confirmed",
        timestamp_proof={"ots_b64": "ZGVtbw==", "status": "attested"},
    )
    session.add(estab_photo)
    session.flush()
    session.add(PracticeEvidence(practice_id=rye.id, capture_event_id=estab_photo.id,
                                 note="establishment photo (demo)"))
    session.add(ProgramEnrollment(program_key="idals-rma-insurance-discount", crop_year=year + 1,
                                  status="considering", acres=80))

    # a voice capture waiting in the inbox, so Confirm/Fix/Discard is demoable
    artifact_dir = settings.data_dir / "artifacts" / "demo"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    (artifact_dir / "voice.webm").write_bytes(b"demo audio bytes")
    voice = CaptureEvent(
        client_id=uuid.uuid4(), user_id=owner.id, kind="voice",
        artifact_path="artifacts/demo/voice.webm",
        artifact_sha256=hashlib.sha256(b"demo audio bytes").hexdigest(),
        mime_type="audio/webm", captured_at=datetime.now(tz) - timedelta(hours=2),
        status="queued",
        transcript="Just finished spraying the home eighty, Enlist One at 32 ounces, "
                   "left boom's dripping again, and we're down to two jugs of Enlist.",
    )
    session.add(voice)
    session.flush()
    payloads = [
        ("field_operation", {"op_type": "spray", "field_name": "home eighty",
                             "products": [{"name": "Enlist One", "rate": 32, "rate_unit": "oz/ac"}]},
         [{"key": "field_id", "question": "Which field is 'the home eighty'?"}], 0.72),
        ("equipment_issue", {"equipment": "sprayer left boom", "issue": "dripping", "recurring": True}, [], 0.9),
        ("input_inventory", {"product_name": "Enlist One", "observation": "low", "quantity_hint": "two jugs"}, [], 0.88),
    ]
    for i, (ttype, payload, amb, conf) in enumerate(payloads):
        pr = ParseResult(capture_event_id=voice.id, seq=i, target_type=ttype, extracted=payload,
                         confidence=conf, model_used="demo-seed", prompt_version="demo", ambiguities=amb)
        session.add(pr)
        session.flush()
        session.add(ConfirmationQueueItem(parse_result_id=pr.id))

    session.add(DailyBrief(
        brief_date=today, model_used="demo-seed",
        body_md=("## Today (demo data)\n- 3 items in the inbox from last night's voice note.\n"
                 "- IDALS insurance discount signup window is worth a look before January.\n"
                 "- Corn position: contracted 15,000 bu of an estimated 17,120 produced."),
        inputs={"demo": True},
    ))

    return {"seeded": True, "owner_token": token, "fields": len(field_specs)}
