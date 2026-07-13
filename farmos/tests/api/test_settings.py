"""Settings surface: farm-profile edit round-trip and the factory-reset guard.

NOTE: the api suite shares ONE session-scoped DB (see HANDOFF §4). A successful
factory reset TRUNCATEs every table, which would wipe sibling tests mid-run, so
this file only exercises the *guard* — the confirm-phrase check that runs BEFORE
any wipe. The happy path is validated on-box during release, not here.
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.db


def test_profile_edit_round_trip(client, auth_headers):
    # Editing the singleton profile is what the new Settings "Farm profile" card
    # does — the same fields onboarding collects, changeable after setup.
    r = client.put(
        "/api/v1/profile",
        headers=auth_headers,
        json={
            "operation_name": "Edited Acres",
            "county_ansi_code": "153",
            "tillage_system": "no-till",
            "practice_history": {"cover_crops": True, "enrolled_cover_crop_programs": ["EQIP"]},
        },
    )
    assert r.status_code == 200
    got = client.get("/api/v1/profile", headers=auth_headers).json()
    assert got["operation_name"] == "Edited Acres"
    assert got["county_ansi_code"] == "153"
    assert got["tillage_system"] == "no-till"
    assert got["practice_history"]["cover_crops"] is True


def test_factory_reset_requires_exact_confirm_phrase(client, auth_headers):
    # Wrong phrase → 400 and NOTHING is wiped (the check precedes the TRUNCATE).
    for bad in ["", "reset", "yes", "RESET please"]:
        r = client.post("/api/v1/system/factory-reset", headers=auth_headers, json={"confirm": bad})
        assert r.status_code == 400, f"expected guard to reject {bad!r}"

    # Proof the box was not reset: the profile edited above is still there.
    got = client.get("/api/v1/profile", headers=auth_headers).json()
    assert got.get("operation_name") == "Edited Acres"
