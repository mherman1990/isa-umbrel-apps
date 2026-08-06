// Minimal Server-Sent Events builder for stubbing a STREAMED Anthropic response in tests.
//
// generateMemo streams (a non-streaming request at the Analyst's 64k max_tokens can exceed the SDK's
// HTTP timeout), so a `fetch` stub that returns a plain JSON body no longer satisfies it — the SDK
// parses the stream and would hang or throw. This emits just enough of the wire format for
// `.finalMessage()` to reconstruct the same Message object the non-streaming path returned.
//
// Deliberately NOT a general SSE implementation: one text block is all these tests need, and a
// fuller fake would be more code to keep correct than the thing it is testing.

/** Build an SSE body for a single-text-block message. */
export function sseBody({ text, model = "claude-opus-4-8", stopReason = "end_turn", inputTokens = 100, outputTokens = 50 }) {
  const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    ev("message_start", {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } }),
    ev("message_stop", { type: "message_stop" }),
  ].join("");
}

/**
 * One response for a stubbed `fetch`, choosing the wire format from the REQUEST — streamed requests
 * get SSE, everything else gets JSON. Both shapes are needed in the same test: the Analyst note is
 * streamed, while the thesis and challenge calls that follow it are not.
 */
export function modelResponse(requestBody, text, { stopReason = "end_turn" } = {}) {
  const model = requestBody.model;
  if (requestBody.stream) {
    return new Response(sseBody({ text, model, stopReason }), {
      status: 200,
      headers: { "content-type": "text/event-stream", "request-id": "req_test" },
    });
  }
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: stopReason,
    }),
    { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } }
  );
}
