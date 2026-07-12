"""Agronomic decision support: N rate (MRTN), fungicide ROI, practice economics.

Coefficients and cost ranges come from CITED region-pack sections read at
compute time (like `compliance`) — never fabricated, each carrying verify_by,
and degraded to "unverified/stale" by the engine. Per the owner's framing there
is no education-not-advice limit, so these give recommendations — but every
number is arithmetic on cited data and the farm's own prices/records, and any
missing input is surfaced as a gap, never guessed.
"""
from __future__ import annotations

import math
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import EvidenceRequirement, Practice, Program
from ..region_packs import loader


def _pack():
    path = loader.default_pack_path()
    if path is None:
        return None
    pack, _ = loader.read_pack(path)
    return pack


def _applied_n_from_records(session: Session, field_id, crop_year) -> tuple[float | None, str | None]:
    """Best-effort recorded N rate (lb N/ac) for a field-year: the `rate`
    attribute on a nutrient_mgmt practice. (Deriving N from arbitrary fertilize
    products needs per-product N analysis we don't model yet — a known gap.)"""
    p = session.scalar(
        select(Practice).where(
            Practice.practice_type == "nutrient_mgmt",
            Practice.field_id == field_id,
            Practice.crop_year == crop_year,
        )
    )
    rate = (p.attributes or {}).get("rate") if p else None
    if isinstance(rate, (int, float)):
        return float(rate), "nutrient_mgmt practice"
    return None, None


def n_rate(
    session: Session,
    *,
    corn_price: float,
    n_price_per_lb: float,
    rotation: str,
    applied_n: float | None = None,
    field_id=None,
    crop_year=None,
) -> dict:
    """Economically optimal corn N (MRTN approach) for the entered prices, with
    an optional comparison to the N actually applied."""
    pack = _pack()
    mrtn = pack.mrtn if pack else None
    if mrtn is None:
        return {"configured": False, "note": "the loaded region pack has no MRTN data"}
    rot = mrtn.rotations.get(rotation)
    if rot is None:
        return {
            "configured": True,
            "rotation": rotation,
            "mrtn_rate_lb_n": None,
            "available_rotations": sorted(mrtn.rotations),
            "gaps": [f"no MRTN response on file for rotation '{rotation}'"],
        }

    b1, b2 = rot.marginal_bu_per_lb, rot.curvature
    n_join = rot.agronomic_max_lb if rot.agronomic_max_lb is not None else b1 / (2 * b2)
    price_ratio = n_price_per_lb / corn_price  # bu/lb
    eonr = max(0.0, min((b1 - price_ratio) / (2 * b2), n_join))

    def delta_yield(n: float) -> float:  # bu/ac gained over zero N
        return b1 * n - b2 * n * n

    def net_over_zero(n: float) -> float:  # $/ac of N vs applying none
        return corn_price * delta_yield(n) - n_price_per_lb * n

    net_max = net_over_zero(eonr)
    half = math.sqrt(1.0 / (corn_price * b2))  # net within $1/ac of max
    range_low, range_high = max(0.0, eonr - half), min(n_join, eonr + half)

    if applied_n is None and field_id is not None and crop_year is not None:
        applied_n, applied_source = _applied_n_from_records(session, field_id, crop_year)
    else:
        applied_source = "provided" if applied_n is not None else None

    comparison, gaps = None, []
    if applied_n is not None:
        comparison = {
            "applied_n_lb": round(float(applied_n), 1),
            "source": applied_source,
            "delta_vs_mrtn_lb": round(float(applied_n) - eonr, 1),
            "net_left_on_table_per_ac": round(net_max - net_over_zero(float(applied_n)), 2),
            "within_profitable_range": range_low <= float(applied_n) <= range_high,
        }
    elif field_id is not None and crop_year is not None:
        gaps.append("no recorded N rate for this field-year to compare (add a nutrient_mgmt practice with a rate)")

    return {
        "configured": True,
        "crop": mrtn.crop,
        "rotation": rotation,
        "rotation_label": rot.label,
        "corn_price": corn_price,
        "n_price_per_lb": n_price_per_lb,
        "price_ratio_bu_per_lb": round(price_ratio, 4),
        "mrtn_rate_lb_n": round(eonr),
        "profitable_range_lb_n": [round(range_low), round(range_high)],
        "agronomic_max_lb_n": round(n_join),
        "expected_yield_gain_over_zero_n_bu": round(delta_yield(eonr), 1),
        "net_return_over_zero_n_per_ac": round(net_max, 2),
        "comparison": comparison,
        "citation": mrtn.citation,
        "source_url": mrtn.source_url,
        "last_verified": mrtn.last_verified.isoformat(),
        "stale": mrtn.verify_by < date.today(),
        "unverified": mrtn.unverified,
        "gaps": gaps or None,
        "note": (
            "Economically optimal N (MRTN approach) for the prices you entered. The response "
            "coefficients are approximate — confirm the rate at the ISU Corn Nitrogen Rate "
            "Calculator (source_url) before applying."
        ),
    }


def fungicide_roi(
    *,
    crop: str,
    grain_price: float,
    product_cost_per_ac: float,
    application_cost_per_ac: float = 0.0,
    pressure: str = "moderate",
) -> dict:
    """Expected-value ROI on a foliar fungicide pass, from cited response ranges."""
    pack = _pack()
    spec = pack.fungicide_roi if pack else None
    if spec is None:
        return {"configured": False, "note": "the loaded region pack has no fungicide ROI data"}
    crop_spec = spec.crops.get(crop.lower())
    if crop_spec is None:
        return {
            "configured": True,
            "crop": crop,
            "expected_net_roi_per_ac": None,
            "available_crops": sorted(spec.crops),
            "gaps": [f"no fungicide response on file for crop '{crop}'"],
        }

    total_cost = round(product_cost_per_ac + application_cost_per_ac, 2)
    responses = crop_spec.responses
    scenarios = [
        {
            "pressure": level,
            "response_bu": resp,
            "expected_revenue_per_ac": round(resp * grain_price, 2),
            "net_roi_per_ac": round(resp * grain_price - total_cost, 2),
            "pays_for_itself": resp * grain_price > total_cost,
        }
        for level, resp in responses.items()
    ]
    chosen = next((s for s in scenarios if s["pressure"] == pressure), None)
    gaps = None if chosen else [f"unknown pressure '{pressure}' — using none; pick one of {sorted(responses)}"]

    return {
        "configured": True,
        "crop": crop.lower(),
        "grain_price": grain_price,
        "cost_per_ac": total_cost,
        "breakeven_response_bu": round(total_cost / grain_price, 1) if grain_price else None,
        "pressure": pressure,
        "expected_response_bu": chosen["response_bu"] if chosen else None,
        "expected_net_roi_per_ac": chosen["net_roi_per_ac"] if chosen else None,
        "roi_ratio": round(chosen["expected_revenue_per_ac"] / total_cost, 2) if chosen and total_cost else None,
        "scenarios": scenarios,
        "citation": spec.citation,
        "source_url": spec.source_url,
        "last_verified": spec.last_verified.isoformat(),
        "stale": spec.verify_by < date.today(),
        "unverified": spec.unverified,
        "gaps": gaps,
        "note": (
            "Expected-value ROI on a fungicide pass. Response ranges are approximate and depend on "
            "hybrid/variety, disease, growth stage, and weather — confirm the scenario before spending."
        ),
    }


def _programs_for_practice(session: Session, practice_type: str) -> list[str]:
    """Program keys whose evidence spec names this practice_type — i.e. programs
    that pay for doing it."""
    keys = session.scalars(
        select(Program.program_key)
        .join(EvidenceRequirement, EvidenceRequirement.program_id == Program.id)
        .where(EvidenceRequirement.practice_type == practice_type)
        .distinct()
    ).all()
    return sorted(set(keys))


def practice_economics(session: Session, *, practice_type: str, acres: float,
                       program_keys: list[str] | None = None) -> dict:
    """Net $/ac of a conservation practice = best verified program payment
    (via the stacking engine) − the practice's typical cost."""
    from . import stacking

    pack = _pack()
    spec = pack.practice_costs if pack else None
    if spec is None:
        return {"configured": False, "note": "the loaded region pack has no practice-cost data"}

    gaps: list[str] = []
    cost_per_ac = spec.costs.get(practice_type)
    if cost_per_ac is None:
        gaps.append(f"no cost basis on file for practice '{practice_type}' (structural/cost-shared practices vary)")

    keys = program_keys or _programs_for_practice(session, practice_type)
    combo, payment_per_ac = None, 0.0
    if keys:
        result = stacking.check(session, keys, acres)
        best = result.get("best_verified_combo")
        if best:
            combo = {"programs": best["programs"], "per_acre_usd": best["per_acre_usd"], "total_usd": best["total_usd"]}
            payment_per_ac = best["per_acre_usd"]
        else:
            gaps.append("no fully-verified paying program combination among the programs considered")
    else:
        gaps.append(f"no program on file lists a {practice_type} evidence requirement")

    net_per_ac = round(payment_per_ac - cost_per_ac, 2) if cost_per_ac is not None else None
    return {
        "configured": True,
        "practice_type": practice_type,
        "acres": acres,
        "practice_cost_per_ac": cost_per_ac,
        "practice_cost_total": round(cost_per_ac * acres, 2) if cost_per_ac is not None else None,
        "programs_considered": keys,
        "best_program_combo": combo,
        "program_payment_per_ac": round(payment_per_ac, 2),
        "net_per_ac": net_per_ac,
        "net_total": round(net_per_ac * acres, 2) if net_per_ac is not None else None,
        "cost_citation": spec.citation,
        "cost_source_url": spec.source_url,
        "cost_last_verified": spec.last_verified.isoformat(),
        "cost_stale": spec.verify_by < date.today(),
        "cost_unverified": spec.unverified,
        "gaps": gaps or None,
        "note": (
            "Net $/ac = best VERIFIED program payment (from the stacking engine) − typical practice "
            "cost. Program $ is cited; costs are typical and approximate. Structural practices whose "
            "cost is capital/cost-shared show no cost basis rather than a made-up number."
        ),
    }
