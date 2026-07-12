"""Voice-parser eval harness.

Replay mode (default, CI): recorded model outputs → the REAL
post-processing (llm.extract_json + parse.validate_records) → scored
against expected records. Deterministic, zero API calls.

Live mode (`--live`, needs FARMOS_EVAL_API_KEY): sends each transcript to
the real model with the real prompt, re-records outputs into cases.yaml's
sidecar file, and prints score drift. Run whenever the prompt template or
model pin changes, and commit the refreshed recordings with that change.

Scoring: a predicted record matches an expected record if target_type
matches and every payload_match key matches (exact / contains / any).
Greedy 1:1 matching per case; precision/recall/F1 over all cases.
Gate: F1 >= 0.90 (exit 1 below).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent.parent / "backend"))

from app import llm  # noqa: E402
from app.capture import parse as parse_mod  # noqa: E402

F1_GATE = 0.90


def _value_matches(actual, spec) -> bool:
    if isinstance(spec, dict):
        if spec.get("any"):
            return actual not in (None, "", [], {})
        if "contains" in spec:
            return isinstance(actual, str) and spec["contains"].lower() in actual.lower()
    return actual == spec


def record_matches(predicted: dict, expected: dict) -> bool:
    if predicted.get("target_type") != expected["target_type"]:
        return False
    payload = predicted.get("payload", {})
    for key, spec in (expected.get("payload_match") or {}).items():
        if not _value_matches(payload.get(key), spec):
            return False
    if expected.get("require_ambiguity"):
        keys = {a.get("key") for a in predicted.get("ambiguities", [])}
        if expected["require_ambiguity"] not in keys:
            return False
    return True


def score_case(recorded_text: str, expected: list[dict]) -> tuple[int, int, int, list[str]]:
    """Returns (true_pos, predicted_count, expected_count, failures)."""
    failures: list[str] = []
    try:
        raw = llm.extract_json(recorded_text) if recorded_text.strip() not in ("[]", "") else []
    except ValueError as exc:
        return 0, 0, len(expected), [f"unparseable recorded output: {exc}"]
    predicted = parse_mod.validate_records(raw)

    matched_pred: set[int] = set()
    tp = 0
    for exp in expected:
        hit = next(
            (i for i, p in enumerate(predicted) if i not in matched_pred and record_matches(p, exp)),
            None,
        )
        if hit is None:
            failures.append(f"missing expected {exp['target_type']}: {exp.get('payload_match')}")
        else:
            matched_pred.add(hit)
            tp += 1
    for i, p in enumerate(predicted):
        if i not in matched_pred:
            failures.append(f"unexpected extra record: {p.get('target_type')}")
    return tp, len(predicted), len(expected), failures


def run_live(cases: list[dict]) -> None:
    import os

    key = os.environ.get("FARMOS_EVAL_API_KEY")
    if not key:
        print("FARMOS_EVAL_API_KEY not set", file=sys.stderr)
        raise SystemExit(2)
    import anthropic

    client = anthropic.Anthropic(api_key=key)
    system = parse_mod.PROMPT_PATH.read_text().replace(
        "{context}",
        "Fields (id | nickname | tract/field | acres):\n"
        "- 11111111-1111-1111-1111-111111111111 | Home 80 | T101/F1 | 80 ac\n"
        "- 22222222-2222-2222-2222-222222222222 | North 40 | T101/F2 | 40 ac\n"
        "- 33333333-3333-3333-3333-333333333333 | North 80 | T102/F1 | 80 ac\n",
    )
    recordings = {}
    for case in cases:
        resp = client.messages.create(
            model="claude-haiku-4-5",
            system=system,
            messages=[{"role": "user", "content": case["transcript"]}],
            max_tokens=2048,
        )
        recordings[case["id"]] = "".join(b.text for b in resp.content if b.type == "text")
        print(f"recorded {case['id']}")
    out = HERE / "recorded_live.json"
    out.write_text(json.dumps(recordings, indent=2))
    print(f"\nwrote {out} — review score drift, then move accepted outputs into cases.yaml")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="re-record model outputs via the API")
    args = ap.parse_args()

    cases = yaml.safe_load((HERE / "cases.yaml").read_text())["cases"]
    if args.live:
        run_live(cases)
        return

    total_tp = total_pred = total_exp = 0
    failed_cases = []
    for case in cases:
        tp, pred, exp, failures = score_case(case["recorded"], case.get("expected") or [])
        total_tp += tp
        total_pred += pred
        total_exp += exp
        if failures:
            failed_cases.append((case["id"], failures))

    precision = total_tp / total_pred if total_pred else 1.0
    recall = total_tp / total_exp if total_exp else 1.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0

    print(f"cases: {len(cases)}  records expected: {total_exp}  predicted: {total_pred}")
    print(f"precision: {precision:.3f}  recall: {recall:.3f}  F1: {f1:.3f}  (gate {F1_GATE})")
    for case_id, failures in failed_cases:
        print(f"\n{case_id}:")
        for f in failures:
            print(f"  - {f}")
    if f1 < F1_GATE:
        print(f"\nFAIL: F1 {f1:.3f} < {F1_GATE}", file=sys.stderr)
        raise SystemExit(1)
    print("\nPASS")


if __name__ == "__main__":
    main()
