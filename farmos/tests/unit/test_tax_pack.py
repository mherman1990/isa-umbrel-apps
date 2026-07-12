"""Schedule F tax-pack: schema validity, citation metadata, classification."""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / "backend"))

from app.tax_packs.loader import PACKS_DIR, load_schedule_f


def test_schedule_f_pack_parses_and_is_cited():
    """Same discipline as region packs: source_url + last_verified + verify_by."""
    m = load_schedule_f(2025)
    p = m.pack
    assert p.form.startswith("Schedule F")
    assert p.source_url.startswith("https://")
    assert p.verify_by > p.last_verified
    assert p.income_lines and p.expense_lines


def test_no_category_maps_to_two_lines_within_a_section():
    """A category must be unambiguous within income (or within expense)."""
    for section in ("income_lines", "expense_lines"):
        seen: dict[str, str] = {}
        for tl in getattr(load_schedule_f(2025).pack, section):
            for cat in tl.categories:
                assert cat not in seen, f"'{cat}' maps to both line {seen[cat]} and {tl.line}"
                seen[cat] = tl.line


def test_classification_of_known_row_crop_categories():
    m = load_schedule_f(2025)
    assert m.classify("expense", "seed").line == "26"
    assert m.classify("expense", "herbicide").line == "11"
    assert m.classify("expense", "fungicide").line == "11"
    assert m.classify("expense", "fertilizer").line == "17"
    assert m.classify("expense", "custom_hire").line == "13"
    assert m.classify("expense", "cash_rent").line == "24b"
    assert m.classify("income", "grain").line == "2"
    assert m.classify("income", "corn").line == "2"
    assert m.classify("income", "custom_work").line == "7"


def test_normalization_is_case_and_separator_insensitive():
    m = load_schedule_f(2025)
    assert m.classify("expense", "Custom-Hire").line == "13"
    assert m.classify("expense", " FERTILIZER ").line == "17"


def test_unknown_and_default_other_are_uncategorized():
    m = load_schedule_f(2025)
    assert m.classify("expense", "widgets") is None
    assert m.classify("expense", "other") is None  # default category is NOT line 32
    assert m.classify("expense", None) is None
    assert m.classify("expense", "") is None


def test_year_selection_picks_best_fit_pack():
    packs = sorted(PACKS_DIR.glob("schedule-f-*.yaml"))
    assert packs, "at least one schedule-f pack must exist"
    # Far-future year -> the latest available pack; far-past -> earliest.
    assert load_schedule_f(2999).pack.tax_year == load_schedule_f(None).pack.tax_year
    assert load_schedule_f(1990).pack.tax_year >= 2025
