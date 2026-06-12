import assert from "node:assert/strict";
import test from "node:test";
import { openAIResponsesAdapter } from "../../src/adapters/openai-responses.js";
import { GatewayRequestContext, LLMResponse } from "../../src/types.js";

const context: GatewayRequestContext = {
  requestId: "req-2",
  protocol: "openai-responses",
  client: "codex",
  startTime: Date.now(),
  requestPath: "/v1/responses",
};

test("openai responses adapter accepts string input", () => {
  const req = openAIResponsesAdapter.toLLMRequest(
    {
      model: "gpt-5",
      input: "explain this function",
      max_output_tokens: 256,
      temperature: 0.1,
      stream: false,
    },
    context,
  );

  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, "user");
  assert.equal(req.messages[0].content, "explain this function");
  assert.equal(req.sampling?.maxTokens, 256);
});

test("openai responses adapter maps developer messages to system messages", () => {
  const req = openAIResponsesAdapter.toLLMRequest(
    {
      model: "stackbilt/code-fast",
      input: [
        {
          type: "message",
          role: "developer",
          content: "Always inspect files before proposing changes.",
        },
        {
          type: "message",
          role: "user",
          content: "Review issue direction.",
        },
      ],
    },
    context,
  );

  assert.match(req.system ?? "", /Always inspect files before proposing changes/);
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, "user");
});

test("openai responses adapter ignores built-in tools without function names", () => {
  const req = openAIResponsesAdapter.toLLMRequest(
    {
      model: "stackbilt/auto",
      input: "review https://github.com/Stackbilt-dev/stackbilt-web/issues/178",
      tools: [
        { type: "web_search_preview" },
        {
          type: "function",
          name: "shell_command",
          description: "Run a shell command",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
          },
        },
      ],
    },
    context,
  );

  assert.equal(req.tools?.length, 1);
  assert.equal(req.tools?.[0].function.name, "shell_command");
});

test("openai responses adapter does not synthesize unnamed tools", () => {
  const req = openAIResponsesAdapter.toLLMRequest(
    {
      model: "stackbilt/auto",
      input: "search the web",
      tools: [
        { type: "function", description: "Malformed function missing name", parameters: { type: "object" } },
      ],
    },
    context,
  );

  assert.equal(req.tools?.length, 0);
});

test("openai responses adapter renders output payload", () => {
  const llmResponse: LLMResponse = {
    id: "resp-1",
    provider: "openai",
    model: "gpt-5",
    outputText: "summary",
    usage: {
      inputTokens: 12,
      outputTokens: 7,
    },
    fallbackChain: ["openai"],
    routeClass: "summary",
    cacheHit: false,
  };

  const out = openAIResponsesAdapter.fromLLMResponse(llmResponse, context);
  assert.equal(out.object, "response");
  const message = out.output[0];
  assert.equal(message.type, "message");
  assert.equal(message.content[0].text, "summary");
  assert.equal(out.usage?.output_tokens, 7);
});

test("openai responses adapter renders function call output payload", () => {
  const llmResponse: LLMResponse = {
    id: "resp-tool",
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    outputText: "",
    toolCalls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "lookup_issue",
          arguments: "{\"number\":178}",
        },
      },
    ],
    usage: {
      inputTokens: 12,
      outputTokens: 7,
    },
    fallbackChain: ["groq"],
    routeClass: "planning",
    cacheHit: false,
  };

  const out = openAIResponsesAdapter.fromLLMResponse(llmResponse, context);
  assert.equal(out.output[0].type, "function_call");
  assert.equal(out.output[0].call_id, "call-1");
  assert.equal(out.output[0].name, "lookup_issue");
});

test("openai responses adapter parses function call outputs as tool results", () => {
  const req = openAIResponsesAdapter.toLLMRequest(
    {
      model: "gpt-5",
      input: [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "{\"title\":\"Issue 178\"}",
        },
      ],
    },
    context,
  );

  assert.equal(req.messages[0].role, "user");
  assert.equal(req.messages[0].toolResults?.[0].id, "call-1");
  assert.equal(req.messages[0].toolResults?.[0].output, "{\"title\":\"Issue 178\"}");
});

test("openai responses adapter streams function call events", async () => {
  const llmResponse: LLMResponse = {
    id: "resp-tool-stream",
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    outputText: "",
    toolCalls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "lookup_issue",
          arguments: "{\"number\":178}",
        },
      },
    ],
    fallbackChain: ["groq"],
    routeClass: "planning",
    cacheHit: false,
  };
  const stream = new ReadableStream<string>({
    start(controller) {
      controller.close();
    },
  });

  const out = openAIResponsesAdapter.fromLLMStream?.(stream, context, llmResponse);
  assert.ok(out);
  const payload = await new Response(out).text();
  assert.match(payload, /event: response.function_call_arguments.delta/);
  assert.match(payload, /event: response.function_call_arguments.done/);
  assert.match(payload, /event: response.completed/);
  assert.doesNotMatch(payload, /event: done/);
});
