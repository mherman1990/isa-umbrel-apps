"""Load a region-pack YAML into the database (idempotent by content hash)."""
from __future__ import annotations

import hashlib
from pathlib import Path

import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import EligibilityRule, Program, RegionPackRow, StackingRule
from .schema import RegionPackFile

PACKS_DIR = Path(__file__).parent / "packs"


def read_pack(path: Path) -> tuple[RegionPackFile, str]:
    raw = path.read_bytes()
    pack = RegionPackFile.model_validate(yaml.safe_load(raw))
    return pack, hashlib.sha256(raw).hexdigest()


def load_pack(session: Session, path: Path) -> RegionPackRow:
    pack, sha = read_pack(path)
    existing = session.scalar(
        select(RegionPackRow).where(
            RegionPackRow.region_code == pack.region_code, RegionPackRow.version == pack.version
        )
    )
    if existing is not None:
        if existing.content_sha256 == sha:
            return existing
        raise ValueError(
            f"pack {pack.region_code} {pack.version} already loaded with different content — bump the version"
        )

    row = RegionPackRow(
        region_code=pack.region_code,
        version=pack.version,
        source_path=str(path.name),
        content_sha256=sha,
    )
    session.add(row)
    session.flush()
    _retire_older_versions(session, row)
    for prog in pack.programs:
        p = Program(
            region_pack_id=row.id,
            program_key=prog.program_key,
            name=prog.name,
            agency=prog.agency,
            tier=prog.tier,
            summary=prog.summary,
            payment_rate=prog.payment_rate,
            signup_deadline=prog.signup_deadline,
            signup_deadline_date=prog.signup_deadline_date,
            payment_per_acre=prog.payment_per_acre,
            source_url=prog.source_url,
            last_verified=prog.last_verified,
            verify_by=prog.verify_by,
        )
        session.add(p)
        session.flush()
        for rule in prog.rules:
            session.add(
                EligibilityRule(
                    program_id=p.id,
                    rule_key=rule.rule_key,
                    predicate=rule.predicate,
                    description=rule.description,
                    citation=rule.citation,
                    source_url=rule.source_url,
                    last_verified=rule.last_verified,
                    verify_by=rule.verify_by,
                )
            )
    known_keys = {p.program_key for p in pack.programs}
    for rule in pack.stacking_rules:
        if rule.program_a not in known_keys or rule.program_b not in known_keys:
            raise ValueError(f"stacking rule {rule.rule_key} references an unknown program key")
        session.add(
            StackingRule(
                region_pack_id=row.id,
                rule_key=rule.rule_key,
                program_a=rule.program_a,
                program_b=rule.program_b,
                relation=rule.relation,
                description=rule.description,
                citation=rule.citation,
                source_url=rule.source_url,
                last_verified=rule.last_verified,
                verify_by=rule.verify_by,
            )
        )
    return row


def _retire_older_versions(session: Session, current: RegionPackRow) -> None:
    """One active pack per region: loading a newer version removes the
    older version's rule rows (the YAML files remain the source of truth
    and history; DB rows are just the loaded working set)."""
    from ..models import FarmProfile

    old_packs = session.scalars(
        select(RegionPackRow).where(
            RegionPackRow.region_code == current.region_code, RegionPackRow.id != current.id
        )
    ).all()
    if not old_packs:
        return
    old_ids = [p.id for p in old_packs]
    for profile in session.scalars(select(FarmProfile).where(FarmProfile.region_pack_id.in_(old_ids))):
        profile.region_pack_id = current.id
    for program in session.scalars(select(Program).where(Program.region_pack_id.in_(old_ids))):
        session.delete(program)  # eligibility rules cascade
    session.flush()
    for pack in old_packs:
        session.delete(pack)


def default_pack_path() -> Path | None:
    packs = sorted(PACKS_DIR.glob("*.yaml"))
    return packs[-1] if packs else None
