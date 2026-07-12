"""Stacking / additionality checker — the crown jewel (spec §8).

Given candidate programs for the same acres, answer: which pairs are
mutually exclusive, which explicitly stack, which combinations are legal,
and which legal combination maximizes net dollars per acre.

Trust rules, enforced structurally:
- Every relation cites its rule and carries last_verified/verify_by.
- A pair with NO rule on file is 'unknown — confirm with the administering
  agencies', never assumed stackable (Hard Requirement #6).
- A stale rule (past verify_by) degrades to unknown and is excluded from
  the best-combo ranking — staleness is enforced by the engine, not by
  discipline.
- Programs without a computable $/ac still appear in combinations; their
  dollars show as 'not computable', and the ranking says so.
"""
from __future__ import annotations

from datetime import date
from itertools import combinations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Program, StackingRule

MAX_PROGRAMS = 10  # 2^10 subsets is the sane ceiling for exhaustive search


def _rule_map(session: Session, keys: set[str], today: date) -> dict[frozenset, dict]:
    rules = session.scalars(
        select(StackingRule).where(StackingRule.program_a.in_(keys) | StackingRule.program_b.in_(keys))
    ).all()
    out: dict[frozenset, dict] = {}
    for r in rules:
        pair = frozenset((r.program_a, r.program_b))
        if not pair <= keys or len(pair) != 2:
            continue
        stale = r.verify_by < today
        out[pair] = {
            "relation": "unknown" if stale else r.relation,
            "stale": stale,
            "rule_key": r.rule_key,
            "description": r.description,
            "citation": r.citation,
            "source_url": r.source_url,
            "last_verified": r.last_verified.isoformat(),
        }
    return out


def check(session: Session, program_keys: list[str], acres: float, today: date | None = None) -> dict:
    today = today or date.today()
    keys = list(dict.fromkeys(program_keys))  # dedupe, keep order
    if len(keys) > MAX_PROGRAMS:
        raise ValueError(f"at most {MAX_PROGRAMS} programs per check")

    programs = {
        p.program_key: p
        for p in session.scalars(select(Program).where(Program.program_key.in_(keys)))
    }
    missing = [k for k in keys if k not in programs]
    keys = [k for k in keys if k in programs]
    rules = _rule_map(session, set(keys), today)

    # pairwise matrix with citations
    pairs = []
    for a, b in combinations(keys, 2):
        rule = rules.get(frozenset((a, b)))
        if rule is None:
            pairs.append({
                "programs": [a, b],
                "relation": "unknown",
                "note": "no rule on file — confirm with the administering agencies before combining",
            })
        else:
            pairs.append({"programs": [a, b], **rule})

    def pair_relation(a: str, b: str) -> str:
        rule = rules.get(frozenset((a, b)))
        return rule["relation"] if rule else "unknown"

    # enumerate combinations
    combos = []
    for n in range(1, len(keys) + 1):
        for subset in combinations(keys, n):
            relations = [pair_relation(a, b) for a, b in combinations(subset, 2)]
            legal = all(r != "exclusive" for r in relations)
            unknown_pairs = [
                [a, b] for a, b in combinations(subset, 2) if pair_relation(a, b) == "unknown"
            ]
            computable = [programs[k] for k in subset if programs[k].payment_per_acre is not None]
            noncomputable = [k for k in subset if programs[k].payment_per_acre is None]
            per_acre = sum(float(p.payment_per_acre) for p in computable)
            combos.append({
                "programs": list(subset),
                "legal": legal,
                "fully_verified": legal and not unknown_pairs,
                "unknown_pairs": unknown_pairs,
                "per_acre_usd": round(per_acre, 2),
                "total_usd": round(per_acre * acres, 2),
                "not_computable": noncomputable,
            })

    combos.sort(key=lambda c: (-int(c["legal"]), -int(c["fully_verified"]), -c["per_acre_usd"]))
    # "maximizes net dollars" only ever names a fully verified, legal combo
    best = next((c for c in combos if c["legal"] and c["fully_verified"] and c["per_acre_usd"] > 0), None)

    return {
        "acres": acres,
        "programs": [
            {
                "program_key": k,
                "name": programs[k].name,
                "payment_per_acre": float(programs[k].payment_per_acre) if programs[k].payment_per_acre is not None else None,
                "payment_rate": programs[k].payment_rate,
            }
            for k in keys
        ],
        "unknown_program_keys": missing,
        "pairs": pairs,
        "combinations": combos,
        "best_verified_combo": best,
        "disclaimer": (
            "Ranking uses representative rates and only rules on file with "
            "citations. 'Unknown' pairs need confirmation with the agencies "
            "before you count the money."
        ),
    }
