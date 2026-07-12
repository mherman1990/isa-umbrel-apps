"""Thin Program Finder (Phase 1 install-day hook).

From the farm profile + the 5-question practice-history screen, list
candidate programs from the active region pack with payment rates,
deadlines, and citations. Framed as "programs worth a look" — this makes
NO eligibility assertions (Hard Requirement #6): each rule is evaluated to
pass / fail / unknown, and anything past verify_by is labeled stale and
excluded from ranking. The full stacking engine deepens this in Phase 3.
"""
from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import EligibilityRule, FarmProfile, Program


def _profile_attrs(profile: FarmProfile) -> dict:
    attrs = {
        "state": profile.state_code,
        "county_ansi": profile.county_ansi_code,
        "beginning_farmer": profile.beginning_farmer,
        "tillage_system": profile.tillage_system,
        "crops": sorted((profile.crops or {}).keys()),
    }
    attrs.update(profile.practice_history or {})
    return attrs


def eval_predicate(predicate: dict | None, attrs: dict) -> str:
    """Returns 'pass' | 'fail' | 'unknown'. Missing data is unknown, never a guess."""
    if not predicate:
        return "unknown"
    attr, op, expected = predicate.get("attr"), predicate.get("op"), predicate.get("value")
    # An empty list is real data ("enrolled in zero programs"), not missing data.
    if attr not in attrs or attrs[attr] is None or attrs[attr] == "":
        return "unknown"
    actual = attrs[attr]
    try:
        if op == "eq":
            return "pass" if actual == expected else "fail"
        if op == "in":
            return "pass" if actual in expected else "fail"
        if op == "contains":
            return "pass" if expected in actual else "fail"
        if op == "gte":
            return "pass" if float(actual) >= float(expected) else "fail"
        if op == "lte":
            return "pass" if float(actual) <= float(expected) else "fail"
        if op == "truthy":
            return "pass" if bool(actual) == bool(expected) else "fail"
    except (TypeError, ValueError):
        return "unknown"
    return "unknown"


def find_programs(session: Session, profile: FarmProfile, today: date | None = None) -> list[dict]:
    today = today or date.today()
    attrs = _profile_attrs(profile)
    out: list[dict] = []
    for program in session.scalars(select(Program).order_by(Program.tier, Program.name)):
        rules = session.scalars(
            select(EligibilityRule).where(EligibilityRule.program_id == program.id)
        ).all()
        rule_views = []
        any_fail = False
        for r in rules:
            verdict = eval_predicate(r.predicate, attrs)
            stale = r.verify_by < today
            if verdict == "fail" and not stale:
                any_fail = True
            rule_views.append(
                {
                    "rule_key": r.rule_key,
                    "verdict": verdict,
                    "stale": stale,
                    "description": r.description,
                    "citation": r.citation,
                    "source_url": r.source_url,
                    "last_verified": r.last_verified.isoformat(),
                }
            )
        program_stale = program.verify_by < today
        out.append(
            {
                "program_key": program.program_key,
                "name": program.name,
                "agency": program.agency,
                "tier": program.tier,
                "summary": program.summary,
                "payment_rate": program.payment_rate,
                "signup_deadline": program.signup_deadline,
                "source_url": program.source_url,
                "last_verified": program.last_verified.isoformat(),
                "stale": program_stale,
                "excluded_by_rule": any_fail,
                "rules": rule_views,
            }
        )
    # Worth-a-look ordering: non-stale, non-excluded first; stale programs are
    # still shown but labeled and never ranked above verified ones.
    out.sort(key=lambda p: (p["excluded_by_rule"], p["stale"], p["tier"] != "state", p["name"]))
    return out


def pack_health(session: Session, today: date | None = None) -> dict:
    today = today or date.today()
    rules = session.scalars(select(EligibilityRule)).all()
    current = sum(1 for r in rules if r.verify_by >= today)
    return {"rules_total": len(rules), "rules_current": current}
