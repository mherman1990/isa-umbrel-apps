"""Cash-flow timing pack: schema validity, weight sums, even fallback."""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "backend"))

from app.cashflow_packs.loader import load_cashflow_timing
from app.cashflow_packs.schema import CashflowPack


def test_pack_parses_is_cited_and_weights_sum_to_one():
    t = load_cashflow_timing()
    assert t.pack.source_url.startswith("https://")
    assert t.pack.verify_by > t.pack.last_verified
    for category, dist in t.pack.expense_timing.items():
        assert abs(sum(dist.values()) - 1.0) < 0.001, category
        assert all(1 <= m <= 12 for m in dist)


def test_known_category_and_even_fallback():
    t = load_cashflow_timing()
    seed, even = t.weights("seed")
    assert not even and abs(sum(seed.values()) - 1.0) < 1e-9
    unknown, is_even = t.weights("all-in")
    assert is_even and abs(sum(unknown.values()) - 1.0) < 1e-3
    assert t.weights("Custom-Hire")[0] == t.weights("custom_hire")[0]  # normalization


def test_schema_rejects_bad_weight_sum():
    with pytest.raises(ValueError):
        CashflowPack.model_validate(
            {
                "region_code": "US-XX",
                "version": "1",
                "source_url": "https://x",
                "last_verified": date(2026, 1, 1),
                "verify_by": date(2027, 1, 1),
                "expense_timing": {"seed": {3: 0.5, 4: 0.4}},  # sums to 0.9
            }
        )
