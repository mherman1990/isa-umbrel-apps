"""LLM access: model router + metered client + hard spend cap.

Every call in the app goes through `complete()`. There is no other path to
the Anthropic SDK — that is what makes the spend meter trustworthy. The
router maps a task class to a model tier; callers say WHAT they're doing,
not which model they want.

The transport is injectable so the parser eval harness can replay recorded
responses in CI with zero API calls.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Callable, Protocol

from sqlalchemy.orm import Session

from .config import settings
from .models import ApiSpend

# $/MTok (input, output). Checked against docs when the model pins change.
PRICES: dict[str, tuple[float, float]] = {
    "claude-haiku-4-5": (1.00, 5.00),
    "claude-sonnet-5": (3.00, 15.00),
}

# task class → settings attr holding the model name
ROUTES: dict[str, str] = {
    "voice_parse": "model_cheap",
    "photo_classify": "model_cheap",
    "doc_structure": "model_cheap",
    "spreadsheet_mapping": "model_reasoning",
    "program_reasoning": "model_reasoning",
    "chat": "model_reasoning",
}


class SpendCapExceeded(Exception):
    pass


@dataclass
class LLMResult:
    text: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float


class Transport(Protocol):
    def __call__(self, *, model: str, system: str, messages: list[dict], max_tokens: int) -> tuple[str, int, int]:
        """Returns (text, input_tokens, output_tokens)."""


def _anthropic_transport(*, model: str, system: str, messages: list[dict], max_tokens: int) -> tuple[str, int, int]:
    import anthropic

    key = settings.anthropic_key()
    if not key:
        raise RuntimeError("no Anthropic API key configured")
    client = anthropic.Anthropic(api_key=key)
    resp = client.messages.create(model=model, system=system, messages=messages, max_tokens=max_tokens)
    text = "".join(block.text for block in resp.content if block.type == "text")
    return text, resp.usage.input_tokens, resp.usage.output_tokens


_transport: Transport = _anthropic_transport


def set_transport(t: Transport | None) -> None:
    """Test/eval hook — inject a replay transport."""
    global _transport
    _transport = t or _anthropic_transport


def cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    inp, outp = PRICES.get(model, (3.00, 15.00))  # unknown model: assume reasoning-tier pricing
    return round(input_tokens / 1e6 * inp + output_tokens / 1e6 * outp, 6)


def month_spend_usd(session: Session) -> float:
    from sqlalchemy import func, select

    total = session.scalar(
        select(func.coalesce(func.sum(ApiSpend.cost_usd), 0)).where(
            func.date_trunc("month", ApiSpend.occurred_at) == func.date_trunc("month", func.now())
        )
    )
    return float(total or 0)


def check_cap(session: Session, cap_usd: float) -> None:
    if month_spend_usd(session) >= cap_usd:
        raise SpendCapExceeded(f"monthly LLM spend cap (${cap_usd:.2f}) reached")


def complete(
    session: Session,
    *,
    purpose: str,
    system: str,
    messages: list[dict],
    max_tokens: int = 2048,
    cap_usd: float | None = None,
    capture_event_id=None,
) -> LLMResult:
    """The single LLM entry point: route, cap-check, call, meter."""
    model = getattr(settings, ROUTES.get(purpose, "model_cheap"))
    if cap_usd is not None:
        check_cap(session, cap_usd)
    text, in_tok, out_tok = _transport(model=model, system=system, messages=messages, max_tokens=max_tokens)
    cost = cost_usd(model, in_tok, out_tok)
    session.add(
        ApiSpend(
            purpose=purpose,
            model=model,
            input_tokens=in_tok,
            output_tokens=out_tok,
            cost_usd=cost,
            capture_event_id=capture_event_id,
        )
    )
    return LLMResult(text=text, model=model, input_tokens=in_tok, output_tokens=out_tok, cost_usd=cost)


def extract_json(text: str):
    """Parse the first JSON value out of a model reply (tolerates code fences)."""
    s = text.strip()
    if s.startswith("```"):
        s = s.split("```")[1]
        if s.startswith("json"):
            s = s[4:]
    start = min((i for i in (s.find("["), s.find("{")) if i >= 0), default=-1)
    if start < 0:
        raise ValueError("no JSON in model reply")
    decoder = json.JSONDecoder()
    value, _ = decoder.raw_decode(s[start:])
    return value
