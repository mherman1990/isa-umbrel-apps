"""Model router, cost math, JSON extraction, and parse post-processing."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "backend"))

from app import llm
from app.capture.parse import validate_records


def test_cost_math():
    # haiku: $1/MTok in, $5/MTok out
    assert llm.cost_usd("claude-haiku-4-5", 1_000_000, 0) == 1.0
    assert llm.cost_usd("claude-haiku-4-5", 0, 1_000_000) == 5.0
    assert llm.cost_usd("claude-haiku-4-5", 2000, 500) == pytest.approx(0.0045)


def test_unknown_model_priced_conservatively():
    # unknown models assume reasoning-tier pricing, so the meter over-counts
    # rather than under-counts
    assert llm.cost_usd("claude-future-9", 1_000_000, 0) == 3.0


def test_routes_cover_cheap_and_reasoning_tiers():
    assert llm.ROUTES["voice_parse"] == "model_cheap"
    assert llm.ROUTES["program_reasoning"] == "model_reasoning"


def test_extract_json_plain_and_fenced():
    assert llm.extract_json('[{"a": 1}]') == [{"a": 1}]
    assert llm.extract_json('Here you go:\n```json\n[{"a": 1}]\n```\nanything after') == [{"a": 1}]
    assert llm.extract_json('{"a": 1} trailing prose') == {"a": 1}
    with pytest.raises(ValueError):
        llm.extract_json("no json here")


def test_validate_records_drops_malformed_entries():
    raw = [
        {"target_type": "field_operation", "confidence": 0.9, "payload": {"op_type": "spray"}},
        {"target_type": "not_a_type", "confidence": 0.9, "payload": {}},  # bad type
        {"target_type": "note", "confidence": 1.5, "payload": {}},  # bad confidence
        {"target_type": "note", "confidence": 0.5, "payload": "not-a-dict"},  # bad payload
        "garbage",
    ]
    valid = validate_records(raw)
    assert len(valid) == 1
    assert valid[0]["target_type"] == "field_operation"


def test_validate_records_wraps_single_object():
    valid = validate_records({"target_type": "note", "confidence": 0.8, "payload": {"text": "x"}})
    assert len(valid) == 1
