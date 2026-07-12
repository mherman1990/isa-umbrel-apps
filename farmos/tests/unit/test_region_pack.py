"""Region-pack loader schema validation + Program Finder predicate logic."""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / "backend"))

from app.region_packs.loader import PACKS_DIR, default_pack_path as loader_default_pack, read_pack
from app.services.program_finder import eval_predicate


def test_iowa_pack_parses_and_has_enough_programs():
    pack, sha = read_pack(loader_default_pack())
    assert pack.region_code == "US-IA"
    assert len(pack.programs) >= 5, "Phase 1 acceptance: >=5 Iowa programs"
    assert len(sha) == 64


def test_every_program_and_rule_carries_citation_metadata():
    """Hard Requirement #6: never assert eligibility without citation + last_verified."""
    pack, _ = read_pack(loader_default_pack())
    for prog in pack.programs:
        assert prog.source_url, prog.program_key
        assert prog.last_verified, prog.program_key
        assert prog.verify_by >= prog.last_verified, prog.program_key
        for rule in prog.rules:
            assert rule.citation, f"{prog.program_key}/{rule.rule_key}"
            assert rule.source_url, f"{prog.program_key}/{rule.rule_key}"


def test_stacking_exclusion_rule_is_present():
    """The IDALS insurance-discount exclusion is the canonical stacking rule."""
    pack, _ = read_pack(loader_default_pack())
    discount = next(p for p in pack.programs if p.program_key == "idals-rma-insurance-discount")
    keys = {r.rule_key for r in discount.rules}
    assert "no_other_cover_crop_program" in keys


def test_predicate_ops():
    attrs = {"state": "IA", "beginning_farmer": True, "acres": 300, "enrolled_cover_crop_programs": []}
    assert eval_predicate({"attr": "state", "op": "eq", "value": "IA"}, attrs) == "pass"
    assert eval_predicate({"attr": "state", "op": "eq", "value": "IL"}, attrs) == "fail"
    assert eval_predicate({"attr": "beginning_farmer", "op": "truthy", "value": True}, attrs) == "pass"
    assert eval_predicate({"attr": "acres", "op": "gte", "value": 100}, attrs) == "pass"
    assert eval_predicate({"attr": "acres", "op": "lte", "value": 100}, attrs) == "fail"
    assert eval_predicate({"attr": "enrolled_cover_crop_programs", "op": "eq", "value": []}, attrs) == "pass"


def test_predicate_missing_data_is_unknown_never_a_guess():
    """Hard Requirement #5 in miniature: missing data -> unknown, not pass/fail."""
    assert eval_predicate({"attr": "county_ansi", "op": "eq", "value": "153"}, {}) == "unknown"
    assert eval_predicate(None, {"anything": 1}) == "unknown"
    assert eval_predicate({"attr": "acres", "op": "gte", "value": "not-a-number"}, {"acres": "abc"}) == "unknown"
