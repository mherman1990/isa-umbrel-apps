"""Assistant chat: snapshot grounding, history passthrough, metering."""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.db


def test_chat_is_grounded_in_snapshot(client, auth_headers, app_and_engine):
    from app import llm

    seen = {}

    def transport(*, model, system, messages, max_tokens):
        seen["system"] = system
        seen["messages"] = messages
        return "You sprayed Enlist One at 32 oz/ac [operation]. ", 4000, 150

    llm.set_transport(transport)
    try:
        r = client.post(
            "/api/v1/assistant/chat",
            json={"question": "What did we spray on the home eighty?",
                  "history": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]},
            headers=auth_headers,
        )
    finally:
        llm.set_transport(None)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "Enlist One" in body["answer"]
    assert body["cost_usd"] > 0  # metered like everything else

    # the model saw the farm snapshot and the strict no-fabrication rules
    assert "FARM RECORD SNAPSHOT" in seen["system"]
    assert "I don't have that recorded" in seen["system"]
    assert "NO recommendations" in seen["system"]
    # history + question passed through, client-held
    assert [m["role"] for m in seen["messages"]] == ["user", "assistant", "user"]
    assert seen["messages"][-1]["content"].startswith("What did we spray")
