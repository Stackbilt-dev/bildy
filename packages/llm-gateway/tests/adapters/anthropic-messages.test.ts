import assert from "node:assert/strict";
import test from "node:test";
import { anthropicMessagesAdapter } from "../../src/adapters/anthropic-messages.js";
import { GatewayRequestContext, LLMResponse } from "../../src/types.js";

const context: GatewayRequestContext = {
  requestId: "req-1",
  protocol: "anthropic-messages",
  client: "claude-code",
  startTime: Date.now(),
  requestPath: "/v1/messages",
};

test("anthropic adapter normalizes request", () => {
  const req = anthropicMessagesAdapter.toLLMRequest(
    {
      model: "claude-sonnet-4-6-20250618",
      system: "You are concise.",
      messages: [
        { role: "user", content: "ping" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "pong" },
            { type: "image" },
          ],
        },
      ],
      max_tokens: 120,
      temperature: 0.2,
      tools: [
        {
          name: "lookup",
          description: "Lookup key",
          input_schema: { type: "object", properties: { key: { type: "string" } } },
        },
      ],
      tool_choice: "auto",
      stream: true,
    },
    context,
  );

  assert.equal(req.model, "claude-sonnet-4-6-20250618");
  assert.equal(req.system, "You are concise.");
  assert.equal(req.messages[1].content, "pong");
  assert.equal(req.sampling?.maxTokens, 120);
  assert.equal(req.stream, true);
  assert.equal(req.tools?.[0].function.name, "lookup");
  assert.equal(req.toolMode, "auto");
});

test("anthropic adapter renders response shape", () => {
  const llmResponse: LLMResponse = {
    id: "abc123",
    provider: "anthropic",
    model: "claude-sonnet-4-6-20250618",
    outputText: "done",
    stopReason: "stop",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 3,
    },
    fallbackChain: ["anthropic"],
    routeClass: "code_draft",
    cacheHit: true,
  };

  const out = anthropicMessagesAdapter.fromLLMResponse(llmResponse, context);
  assert.equal(out.id, "abc123");
  assert.equal(out.role, "assistant");
  assert.equal(out.content[0].type, "text");
  assert.equal(out.content[0].text, "done");
  assert.equal(out.usage?.input_tokens, 10);
  assert.equal(out.usage?.cache_read_input_tokens, 3);
});
