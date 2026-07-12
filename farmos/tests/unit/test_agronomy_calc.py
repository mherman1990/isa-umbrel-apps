"""Agronomy pack sections + N-rate (MRTN) math — pure logic, no DB."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / "backend"))

from app.region_packs import loader
from app.services import agronomy


def test_pack_carries_cited_mrtn_flagged_unverified():
    pack, _ = loader.read_pack(loader.default_pack_path())
    assert pack.mrtn is not None
    m = pack.mrtn
    assert m.source_url.startswith("https://") and m.citation
    assert m.verify_by > m.last_verified
    assert m.unverified is True  # coefficients approximated — must be human-verified
    assert {"corn_after_soybean", "corn_after_corn"} <= set(m.rotations)


def test_mrtn_economic_optimum_is_deterministic():
    r = agronomy.n_rate(None, corn_price=5.0, n_price_per_lb=0.50, rotation="corn_after_soybean")
    assert r["mrtn_rate_lb_n"] == 134  # (0.85 - 0.10) / (2*0.0028)
    assert r["profitable_range_lb_n"] == [125, 142]
    assert r["agronomic_max_lb_n"] == 152
    assert r["net_return_over_zero_n_per_ac"] > 0
    assert r["unverified"] is True


def test_higher_n_price_lowers_the_rate():
    cheap = agronomy.n_rate(None, corn_price=5.0, n_price_per_lb=0.40, rotation="corn_after_soybean")
    dear = agronomy.n_rate(None, corn_price=5.0, n_price_per_lb=0.90, rotation="corn_after_soybean")
    assert dear["mrtn_rate_lb_n"] < cheap["mrtn_rate_lb_n"]


def test_corn_after_corn_needs_more_n_than_after_soybean():
    soy = agronomy.n_rate(None, corn_price=5.0, n_price_per_lb=0.50, rotation="corn_after_soybean")
    corn = agronomy.n_rate(None, corn_price=5.0, n_price_per_lb=0.50, rotation="corn_after_corn")
    assert corn["mrtn_rate_lb_n"] > soy["mrtn_rate_lb_n"]


def test_unknown_rotation_is_a_gap_not_a_guess():
    r = agronomy.n_rate(None, corn_price=5.0, n_price_per_lb=0.50, rotation="wheat")
    assert r["mrtn_rate_lb_n"] is None
    assert r["gaps"] and "wheat" in r["gaps"][0]
    assert "corn_after_soybean" in r["available_rotations"]


def test_applied_n_comparison_flags_over_application():
    r = agronomy.n_rate(None, corn_price=5.0, n_price_per_lb=0.50,
                        rotation="corn_after_soybean", applied_n=170)
    c = r["comparison"]
    assert c["applied_n_lb"] == 170.0 and c["source"] == "provided"
    assert c["delta_vs_mrtn_lb"] > 0  # over the optimum
    assert c["net_left_on_table_per_ac"] > 0
    assert c["within_profitable_range"] is False


def test_fungicide_pack_cited_and_roi_math():
    pack, _ = loader.read_pack(loader.default_pack_path())
    assert pack.fungicide_roi is not None and pack.fungicide_roi.unverified is True
    r = agronomy.fungicide_roi(crop="corn", grain_price=4.5, product_cost_per_ac=28,
                               application_cost_per_ac=8, pressure="high")
    assert r["cost_per_ac"] == 36.0
    assert r["breakeven_response_bu"] == 8.0  # 36 / 4.5
    assert r["expected_net_roi_per_ac"] == 18.0  # 12 bu * 4.5 - 36
    assert r["scenarios"][0]["pressure"] == "low"  # dict order preserved
    assert any(s["pressure"] == "high" and s["pays_for_itself"] for s in r["scenarios"])
    # at moderate pressure the pass does NOT pay — honest, not massaged
    assert next(s for s in r["scenarios"] if s["pressure"] == "moderate")["pays_for_itself"] is False


def test_fungicide_unknown_crop_is_a_gap():
    r = agronomy.fungicide_roi(crop="wheat", grain_price=6.0, product_cost_per_ac=20)
    assert r["expected_net_roi_per_ac"] is None
    assert r["gaps"] and "wheat" in r["gaps"][0]
