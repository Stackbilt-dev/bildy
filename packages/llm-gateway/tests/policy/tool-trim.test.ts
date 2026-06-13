import assert from "node:assert/strict";
import test from "node:test";
import type { LLMRequest } from "../../src/types.js";
import {
  flattenMessageContent,
  sanitizeToolSchemas,
  trimToolsForProvider,
  getProviderToolLimit,
} from "../../src/policy/tool-trim.js";

// ─── flattenMessageContent ───────────────────────────────────────────────────

test("flattenMessageContent: string content is returned unchanged", () => {
  const req = {
    messages: [{ role: "user" as const, content: "hello" }],
  } as unknown as LLMRequest;

  const result = flattenMessageContent(req);
  assert.equal(result.flattened, 0);
  assert.strictEqual(result.request, req);
});

test("flattenMessageContent: array of text blocks flattened to string", () => {
  const req = {
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text", text: "What is 2+2?" },
          { type: "text", text: " Answer briefly." },
        ],
      },
    ],
  } as unknown as LLMRequest;

  const result = flattenMessageContent(req);
  assert.equal(result.flattened, 1);
  assert.equal(typeof result.request.messages[0].content, "string");
  assert.equal(result.request.messages[0].content, "What is 2+2?\n Answer briefly.");
});

test("flattenMessageContent: non-text blocks (tool_use, image) are dropped", () => {
  const req = {
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text", text: "Some context." },
          { type: "tool_use", id: "t1", name: "some_tool", input: {} },
          { type: "text", text: " More text." },
        ],
      },
    ],
  } as unknown as LLMRequest;

  const result = flattenMessageContent(req);
  assert.equal(result.flattened, 1);
  assert.equal(result.request.messages[0].content, "Some context.\n More text.");
});

test("flattenMessageContent: empty text blocks produce empty string, not counted", () => {
  const req = {
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "tool_use", id: "t1", name: "tool", input: {} },
        ],
      },
    ],
  } as unknown as LLMRequest;

  // No text blocks → empty flatten → should NOT replace (empty string is not meaningful)
  const result = flattenMessageContent(req);
  // The function skips if no text to flatten
  assert.equal(result.flattened, 0);
});

test("flattenMessageContent: mixed string and array messages handled correctly", () => {
  const req = {
    messages: [
      { role: "user" as const, content: "plain string" },
      {
        role: "assistant" as const,
        content: [{ type: "text", text: "array response" }],
      },
    ],
  } as unknown as LLMRequest;

  const result = flattenMessageContent(req);
  assert.equal(result.flattened, 1);
  assert.equal(result.request.messages[0].content, "plain string");
  assert.equal(result.request.messages[1].content, "array response");
});

// ─── sanitizeToolSchemas ─────────────────────────────────────────────────────

test("sanitizeToolSchemas: request with no tools returned unchanged", () => {
  const req = {
    messages: [{ role: "user" as const, content: "hi" }],
  } as unknown as LLMRequest;

  const result = sanitizeToolSchemas(req);
  assert.equal(result.repairedTools, 0);
  assert.strictEqual(result.request, req);
});

test("sanitizeToolSchemas: clean schemas are returned unchanged", () => {
  const req = {
    messages: [],
    tools: [
      {
        type: "function" as const,
        function: {
          name: "clean_tool",
          description: "No refs",
          parameters: {
            type: "object",
            properties: { name: { type: "string" } },
          },
        },
      },
    ],
  } as unknown as LLMRequest;

  const result = sanitizeToolSchemas(req);
  assert.equal(result.repairedTools, 0);
});

test("sanitizeToolSchemas: resolves $ref to $defs inline", () => {
  const req = {
    messages: [],
    tools: [
      {
        type: "function" as const,
        function: {
          name: "attach_tool",
          description: "Has $defs",
          parameters: {
            type: "object",
            $defs: {
              Attachment: { type: "object", properties: { filename: { type: "string" } } },
            },
            properties: {
              attachment: { $ref: "#/$defs/Attachment" },
            },
          },
        },
      },
    ],
  } as unknown as LLMRequest;

  const result = sanitizeToolSchemas(req);
  assert.equal(result.repairedTools, 1);

  const params = result.request.tools![0].function.parameters as Record<string, unknown>;
  // $defs should be stripped
  assert.equal("$defs" in params, false);
  // $ref should be resolved to the inlined definition
  const attachment = (params.properties as Record<string, unknown>).attachment as Record<string, unknown>;
  assert.equal(attachment.$ref, undefined);
  assert.equal(attachment.type, "object");
});

test("sanitizeToolSchemas: dangling $ref (no matching $defs entry) becomes { type: object }", () => {
  const req = {
    messages: [],
    tools: [
      {
        type: "function" as const,
        function: {
          name: "gmail_tool",
          description: "Gmail with dangling ref",
          parameters: {
            type: "object",
            properties: {
              attachment: { $ref: "#/$defs/Attachment" }, // Attachment not in $defs
            },
          },
        },
      },
    ],
  } as unknown as LLMRequest;

  const result = sanitizeToolSchemas(req);
  assert.equal(result.repairedTools, 1);

  const params = result.request.tools![0].function.parameters as Record<string, unknown>;
  const attachment = (params.properties as Record<string, unknown>).attachment as Record<string, unknown>;
  assert.deepEqual(attachment, { type: "object" });
});

// ─── trimToolsForProvider ────────────────────────────────────────────────────

test("trimToolsForProvider: no trimming when under limit", () => {
  const tools = Array.from({ length: 10 }, (_, i) => ({
    type: "function" as const,
    function: { name: `tool_${i}`, description: "", parameters: { type: "object", properties: {} } },
  }));

  const req = { messages: [], tools } as unknown as LLMRequest;
  const result = trimToolsForProvider(req, "anthropic");

  assert.equal(result.trimmed, 0);
  assert.strictEqual(result.request, req);
});

test("trimToolsForProvider: trims to provider limit", () => {
  // Cerebras has a 64-tool limit
  const tools = Array.from({ length: 80 }, (_, i) => ({
    type: "function" as const,
    function: { name: `tool_${i}`, description: "", parameters: { type: "object", properties: {} } },
  }));

  const req = { messages: [], tools } as unknown as LLMRequest;
  const result = trimToolsForProvider(req, "cerebras");

  assert.equal(result.trimmed, 16);
  assert.equal(result.request.tools!.length, 64);
});

test("trimToolsForProvider: recently-used tools survive the cut", () => {
  // Create 130 tools (over the 128 anthropic limit)
  const tools = Array.from({ length: 130 }, (_, i) => ({
    type: "function" as const,
    function: { name: `tool_${i}`, description: "", parameters: { type: "object", properties: {} } },
  }));

  // Simulate that tool_128 and tool_129 were recently used (they'd be cut by declaration order)
  const messages = [
    {
      role: "assistant" as const,
      content: [
        { type: "tool_use", name: "tool_129", id: "t1", input: {} },
        { type: "tool_use", name: "tool_128", id: "t2", input: {} },
      ],
    },
  ];

  const req = { messages, tools } as unknown as LLMRequest;
  const result = trimToolsForProvider(req, "anthropic");

  assert.equal(result.trimmed, 2);
  assert.equal(result.request.tools!.length, 128);

  const keptNames = result.request.tools!.map((t) => t.function.name);
  // Recently-used tools should be kept despite being at the end of the declaration list
  assert.ok(keptNames.includes("tool_128"), "tool_128 (recently used) should survive");
  assert.ok(keptNames.includes("tool_129"), "tool_129 (recently used) should survive");
});

test("getProviderToolLimit: returns known limits", () => {
  assert.equal(getProviderToolLimit("anthropic"), 128);
  assert.equal(getProviderToolLimit("cloudflare"), 100);
  assert.equal(getProviderToolLimit("cerebras"), 64);
  assert.equal(getProviderToolLimit("groq"), 128);
  assert.equal(getProviderToolLimit("ANTHROPIC"), 128); // case-insensitive
  assert.equal(getProviderToolLimit("unknown_provider"), 128); // defaults to safe max
});
