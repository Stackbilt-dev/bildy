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

test("anthropic adapter flattens cache_control system blocks to string — prevents CF 400", () => {
  // Claude Code sends system as content-block array when prompt caching is enabled.
  // CF Workers AI requires system as plain string; passing an array causes 400 AiError.
  const req = anthropicMessagesAdapter.toLLMRequest(
    {
      model: "claude-sonnet-4-6-20250618",
      system: [
        { type: "text", text: "You are concise.", cache_control: { type: "ephemeral" } },
        { type: "text", text: " Stay brief." },
      ] as unknown as string,
      messages: [{ role: "user", content: "ping" }],
    },
    context,
  );

  assert.equal(typeof req.system, "string", "system must be a string for non-Anthropic providers");
  assert.equal(req.system, "You are concise.\n Stay brief.");
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
