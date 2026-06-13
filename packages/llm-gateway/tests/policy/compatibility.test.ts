import assert from "node:assert/strict";
import test from "node:test";
import { selectCompatibleProvider } from "../../src/policy/compatibility.js";
import type { LLMRequest } from "../../src/types.js";

const noToolsRequest: LLMRequest = { messages: [{ role: "user", content: "hello" }] };
const toolRequest: LLMRequest = {
  messages: [{ role: "user", content: "hello" }],
  tools: [{ type: "function", function: { name: "lookup", description: "look", parameters: { type: "object", properties: {} } } }],
};

test("prefers safe provider for claude-code even when experimentalModels=true", () => {
  // anthropic and cloudflare are claudeCodeSafe=true; groq is claudeCodeSafe="experimental"
  // With the old bug, experimentalModels=true returned candidates[0] immediately
  // bypassing the safe-first preference. Safe provider should win even when experimental is allowed.
  const result = selectCompatibleProvider(
    ["groq", "anthropic"],
    noToolsRequest,
    "claude-code",
    true,
  );
  assert.equal(result, "anthropic");
});

test("prefers safe provider for codex even when experimentalModels=true", () => {
  // openai and groq are codexSafe=true; cerebras is codexSafe="experimental"
  const result = selectCompatibleProvider(
    ["cerebras", "openai"],
    noToolsRequest,
    "codex",
    true,
  );
  assert.equal(result, "openai");
});

test("falls back to experimental provider for claude-code when experimentalModels=true and no safe candidate", () => {
  // groq and cerebras are both claudeCodeSafe="experimental" — no safe provider available
  const result = selectCompatibleProvider(
    ["groq", "cerebras"],
    noToolsRequest,
    "claude-code",
    true,
  );
  assert.ok(["groq", "cerebras"].includes(result), `expected experimental provider, got ${result}`);
});

test("does not use experimental provider for claude-code when experimentalModels=false and safe candidate exists", () => {
  // groq is experimental, anthropic is safe — safe candidate must win regardless of order
  const result = selectCompatibleProvider(
    ["groq", "anthropic"],
    noToolsRequest,
    "claude-code",
    false,
  );
  assert.equal(result, "anthropic");
});

test("does not use experimental provider for claude-code when experimentalModels=false and only safe candidate present", () => {
  const result = selectCompatibleProvider(
    ["anthropic"],
    noToolsRequest,
    "claude-code",
    false,
  );
  assert.equal(result, "anthropic");
});

test("returns anthropic as last resort when candidates list is empty and tools required", () => {
  const result = selectCompatibleProvider(
    [],
    toolRequest,
    "claude-code",
    false,
  );
  assert.equal(result, "anthropic");
});

test("returns first candidate as last resort when list is empty and no tools required", () => {
  const result = selectCompatibleProvider(
    [],
    noToolsRequest,
    "claude-code",
    false,
  );
  assert.equal(result, "anthropic");
});

test("filters out candidates without tool support when request has tools", () => {
  // All known providers in the registry support tools=true, so this tests the
  // filter path with an unknown provider that has no registry entry.
  const result = selectCompatibleProvider(
    ["unknown-provider", "anthropic"],
    toolRequest,
    "claude-code",
    false,
  );
  assert.equal(result, "anthropic");
});

test("stable safe-first order is preserved — first safe candidate wins, not last", () => {
  // Both anthropic and openai are safe for their respective clients.
  // For codex: openai is codexSafe=true, anthropic is codexSafe="experimental"
  // Given ["openai","anthropic"], openai should win.
  const result = selectCompatibleProvider(
    ["openai", "anthropic"],
    noToolsRequest,
    "codex",
    false,
  );
  assert.equal(result, "openai");
});
