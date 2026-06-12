import assert from "node:assert/strict";
import test from "node:test";
import { buildResponseCacheKey } from "../../src/cache/keys.js";
import type { LLMRequest } from "../../src/types.js";

const baseRequest: LLMRequest = {
  model: "claude-sonnet-4",
  messages: [{ role: "user", content: "hello world" }],
  sampling: { maxTokens: 512, temperature: 0 },
};

test("buildResponseCacheKey is deterministic for identical inputs", () => {
  const key1 = buildResponseCacheKey(baseRequest);
  const key2 = buildResponseCacheKey(baseRequest);
  assert.equal(key1, key2);
});

test("buildResponseCacheKey produces a response: prefixed hex string", () => {
  const key = buildResponseCacheKey(baseRequest);
  assert.match(key, /^response:[0-9a-f]{32}$/);
});

test("buildResponseCacheKey differs when model differs", () => {
  const key1 = buildResponseCacheKey({ ...baseRequest, model: "claude-sonnet-4" });
  const key2 = buildResponseCacheKey({ ...baseRequest, model: "gpt-4o" });
  assert.notEqual(key1, key2);
});

test("buildResponseCacheKey differs when message content differs", () => {
  const key1 = buildResponseCacheKey(baseRequest);
  const key2 = buildResponseCacheKey({
    ...baseRequest,
    messages: [{ role: "user", content: "different content" }],
  });
  assert.notEqual(key1, key2);
});

test("buildResponseCacheKey differs when temperature differs", () => {
  const key1 = buildResponseCacheKey({ ...baseRequest, sampling: { maxTokens: 512, temperature: 0 } });
  const key2 = buildResponseCacheKey({ ...baseRequest, sampling: { maxTokens: 512, temperature: 0.7 } });
  assert.notEqual(key1, key2);
});

test("buildResponseCacheKey is stable across requests with undefined sampling", () => {
  const req: LLMRequest = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(buildResponseCacheKey(req), buildResponseCacheKey(req));
});

test("buildResponseCacheKey excludes tools and system — cache hit is model+messages+sampling only", () => {
  const withExtras: LLMRequest = {
    ...baseRequest,
    tools: [{ type: "function", function: { name: "lookup", description: "look up", parameters: { type: "object", properties: {} } } }],
    system: "You are an assistant",
  };
  // tools and system are intentionally excluded from the response cache key.
  // The response cache only applies on the summary route where tool calling is irrelevant.
  assert.equal(buildResponseCacheKey(baseRequest), buildResponseCacheKey(withExtras));
});
