import assert from "node:assert/strict";
import test from "node:test";
import { classifyRequest } from "../../src/policy/classify.js";

test("classifies tool requests as planning when not in tool loop", () => {
  const route = classifyRequest({
    messages: [{ role: "user", content: "Use tools" }],
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup data",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });

  assert.equal(route, "planning");
});

test("classifies large payload as long_context", () => {
  const route = classifyRequest({
    messages: [{ role: "user", content: "x".repeat(50000) }],
  });

  assert.equal(route, "long_context");
});

test("classifies short requests as fallback_safe", () => {
  const route = classifyRequest({
    messages: [{ role: "user", content: "fix typo" }],
  });

  assert.equal(route, "fallback_safe");
});
