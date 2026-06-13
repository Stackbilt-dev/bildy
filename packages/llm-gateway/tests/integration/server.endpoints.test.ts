import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "../../src/server.js";
import { GatewayError } from "../../src/errors.js";
import { GatewayConfig, LLMRequest, LLMResponse, RouteClass } from "../../src/types.js";
import { ProviderClient, ProviderHealthSnapshot, ProviderRouteResult } from "../../src/providers/llm-providers.js";

const TEST_DB_DIR = mkdtempSync(path.join(tmpdir(), "llm-gateway-tests-"));

function uniqueDbPath(filePrefix: string): string {
  return path.join(TEST_DB_DIR, `${filePrefix}-${crypto.randomUUID()}.sqlite`);
}

function buildConfig(): GatewayConfig {
  return {
    port: 8787,
    auth: {
      mode: "local-key",
      keys: ["test-key"],
    },
    routing: {
      default: "auto",
      experimentalModels: false,
      shadowMode: false,
      routes: {
        planning: ["groq", "cerebras", "cloudflare"],
        code_draft: ["groq", "cerebras", "cloudflare"],
        summary: ["cerebras", "groq", "cloudflare"],
        tool_loop: ["anthropic", "openai"],
        long_context: ["groq", "anthropic", "openai"],
        fallback_safe: ["anthropic", "openai"],
      },
    },
    cache: {
      enabled: true,
      storage: "sqlite",
      path: uniqueDbPath("cache"),
      responseCache: false,
      responseTtlMs: 600000,
      maxEntries: 1000,
    },
    telemetry: {
      enabled: true,
      storePrompts: false,
      redactSecrets: true,
      path: uniqueDbPath("events"),
    },
  };
}

class MockProviderClient implements ProviderClient {
  constructor(
    private readonly availableProviders = ["anthropic", "openai"],
    private readonly options: { invalidToolCall?: boolean; emptyOutput?: boolean; routeError?: GatewayError } = {},
  ) {}

  public readonly calls: Array<{
    request: LLMRequest;
    routeClass: RouteClass;
    preferredProvider: string;
    requestId: string;
    modelOverride?: string;
  }> = [];

  async route(
    request: LLMRequest,
    routeClass: RouteClass,
    preferredProvider: string,
    requestId: string,
    modelOverride?: string,
    _allowedProviders?: ReadonlySet<string>,
  ): Promise<ProviderRouteResult> {
    this.calls.push({ request, routeClass, preferredProvider, requestId, modelOverride });
    if (this.options.routeError) throw this.options.routeError;

    const response: LLMResponse = {
      id: requestId,
      provider: preferredProvider,
      model: modelOverride ?? request.model ?? "mock-model",
      outputText: this.options.emptyOutput ? "" : request.tools?.length ? "" : "mock-output",
      toolCalls: request.tools?.length
        ? [
            {
              id: "call-1",
              type: "function",
              function: {
                name: this.options.invalidToolCall ? "list_mcp_resource_templates:{}" : request.tools[0].function.name,
                arguments: "{\"number\":178}",
              },
            },
          ]
        : undefined,
      usage: {
        inputTokens: 11,
        outputTokens: 4,
      },
      fallbackChain: [preferredProvider],
      routeClass,
      cacheHit: false,
    };

    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("mock-");
        controller.enqueue("output");
        controller.close();
      },
    });

    return { response, textStream };
  }

  async getHealthSnapshot(options?: { live?: boolean }): Promise<ProviderHealthSnapshot> {
    return {
      configured: true,
      availableProviders: this.availableProviders,
      status: options?.live ? "degraded" : "ok",
      healthyProviders: this.availableProviders.slice(0, 1),
      unhealthyProviders: options?.live ? this.availableProviders.slice(1) : [],
    };
  }
}

function authHeaders() {
  return {
    "content-type": "application/json",
    "x-api-key": "test-key",
  };
}

function assertSsePayload(payload: string, eventName: string) {
  assert.match(payload, new RegExp(`event: ${eventName}`));
  assert.match(payload, /mock-/);
  assert.match(payload, /output/);
}

function parseSseEvents(payload: string) {
  return payload.trim().split("\n\n").map((chunk) => {
    const eventLine = chunk.split("\n").find((line) => line.startsWith("event: "));
    const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(eventLine);
    assert.ok(dataLine);
    return {
      event: eventLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length)) as {
        type: string;
        sequence_number: number;
        delta?: string;
        arguments?: string;
        text?: string;
        response?: { status: string; output: Array<{ type: string; content?: Array<{ text: string }>; name?: string }> };
      },
    };
  });
}

test("health includes provider snapshot and supports live query", async () => {
  const providerClient = new MockProviderClient();
  const { app } = createServer(buildConfig(), { providerClient });

  const basic = await app.request("http://localhost/health");
  assert.equal(basic.status, 200);
  const basicJson = (await basic.json()) as { status: string; providers: ProviderHealthSnapshot };
  assert.equal(basicJson.status, "up");
  assert.equal(basicJson.providers.status, "ok");

  const live = await app.request("http://localhost/health?live=1");
  assert.equal(live.status, 200);
  const liveJson = (await live.json()) as { status: string; providers: ProviderHealthSnapshot };
  assert.equal(liveJson.status, "degraded");
  assert.deepEqual(liveJson.providers.unhealthyProviders, ["openai"]);
});

test("providers endpoint returns provider health snapshot and requires auth", async () => {
  const providerClient = new MockProviderClient();
  const { app } = createServer(buildConfig(), { providerClient });

  const unauthenticated = await app.request("http://localhost/providers");
  assert.equal(unauthenticated.status, 401);

  const response = await app.request("http://localhost/providers?live=1", {
    headers: { "x-api-key": "test-key" },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { providers: ProviderHealthSnapshot };
  assert.equal(body.providers.status, "degraded");
  assert.deepEqual(body.providers.availableProviders, ["anthropic", "openai"]);
});

test("models endpoints expose OpenAI-compatible and gateway-native aliases", async () => {
  const providerClient = new MockProviderClient(["groq", "cerebras", "cloudflare"]);
  const { app } = createServer(buildConfig(), { providerClient });

  const openAIResponse = await app.request("http://localhost/v1/models", {
    headers: { "x-api-key": "test-key" },
  });
  assert.equal(openAIResponse.status, 200);
  const openAIModels = (await openAIResponse.json()) as {
    object: string;
    data: Array<{ id: string; object: string; owned_by: string }>;
  };
  assert.equal(openAIModels.object, "list");
  assert.ok(openAIModels.data.some((model) => model.id === "stackbilt/auto"));
  assert.ok(openAIModels.data.some((model) => model.id === "stackbilt/planning"));
  assert.ok(openAIModels.data.some((model) => model.id === "groq/llama-3.3-70b-versatile"));
  assert.ok(openAIModels.data.some((model) => model.id === "cerebras/openai/gpt-oss-120b"));

  const gatewayResponse = await app.request("http://localhost/models", {
    headers: { "x-api-key": "test-key" },
  });
  assert.equal(gatewayResponse.status, 200);
  const gatewayModels = (await gatewayResponse.json()) as {
    providers: string[];
    aliases: Array<{ id: string; routeClass?: string; provider?: string; providerModel?: string }>;
  };
  assert.deepEqual(gatewayModels.providers, ["groq", "cerebras", "cloudflare"]);
  assert.ok(gatewayModels.aliases.some((alias) => alias.id === "stackbilt/code-fast" && alias.routeClass === "code_draft"));
  assert.ok(gatewayModels.aliases.some((alias) => alias.id === "groq/llama-3.3-70b-versatile" && alias.provider === "groq"));
});

test("responses endpoint maps protocol and records metrics/events", async () => {
  const providerClient = new MockProviderClient();
  const { app } = createServer(buildConfig(), { providerClient });

  const response = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "gpt-5",
      input: "explain this code",
      stream: false,
    }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    object: string;
    output: Array<{ content: Array<{ text: string }> }>;
  };
  assert.equal(body.object, "response");
  assert.equal(body.output[0].content[0].text, "mock-output");
  assert.equal(providerClient.calls.length, 1);
  assert.equal(providerClient.calls[0].routeClass, "summary");

  const metricsResponse = await app.request("http://localhost/metrics", {
    headers: { "x-api-key": "test-key" },
  });
  const metrics = (await metricsResponse.json()) as { totalRequests: number; byProvider: Record<string, number> };
  assert.equal(metrics.totalRequests, 1);
  assert.equal(metrics.byProvider.groq, 1);

  const eventsResponse = await app.request("http://localhost/events/recent", {
    headers: { "x-api-key": "test-key" },
  });
  const events = (await eventsResponse.json()) as {
    events: Array<{ protocol: string; selectedProvider: string }>;
  };
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].protocol, "openai-responses");
  assert.equal(events.events[0].selectedProvider, "groq");
});

test("metrics and recent events can filter by eval run id", async () => {
  const providerClient = new MockProviderClient();
  const { app } = createServer(buildConfig(), { providerClient });

  const untagged = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "stackbilt/code-fast",
      input: "Summarize this",
      stream: false,
    }),
  });
  assert.equal(untagged.status, 200);

  const tagged = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: { ...authHeaders(), "x-eval-run-id": "eval-run-123" },
    body: JSON.stringify({
      model: "stackbilt/code-fast",
      input: "Review this implementation",
      stream: false,
    }),
  });
  assert.equal(tagged.status, 200);

  const allMetricsResponse = await app.request("http://localhost/metrics", {
    headers: { "x-api-key": "test-key" },
  });
  const allMetrics = (await allMetricsResponse.json()) as { totalRequests: number };
  assert.equal(allMetrics.totalRequests, 2);

  const runMetricsResponse = await app.request("http://localhost/metrics?evalRunId=eval-run-123", {
    headers: { "x-api-key": "test-key" },
  });
  const runMetrics = (await runMetricsResponse.json()) as { totalRequests: number; byProvider: Record<string, number> };
  assert.equal(runMetrics.totalRequests, 1);
  assert.equal(runMetrics.byProvider.groq, 1);

  const eventsResponse = await app.request("http://localhost/events/recent?evalRunId=eval-run-123", {
    headers: { "x-api-key": "test-key" },
  });
  const events = (await eventsResponse.json()) as {
    events: Array<{ evalRunId?: string; selectedProvider: string }>;
  };
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].evalRunId, "eval-run-123");
  assert.equal(events.events[0].selectedProvider, "groq");
});

test("metrics classify empty successful provider output", async () => {
  const providerClient = new MockProviderClient(["groq"], { emptyOutput: true });
  const { app } = createServer(buildConfig(), { providerClient });

  const response = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "stackbilt/code-fast",
      input: "Review this patch",
      stream: false,
    }),
  });

  assert.equal(response.status, 200);

  const metricsResponse = await app.request("http://localhost/metrics", {
    headers: { "x-api-key": "test-key" },
  });
  const metrics = (await metricsResponse.json()) as {
    totalRequests: number;
    byCompatibilityFailure: Record<string, number>;
  };
  assert.equal(metrics.totalRequests, 1);
  assert.equal(metrics.byCompatibilityFailure.empty_successful_output, 1);

  const eventsResponse = await app.request("http://localhost/events/recent", {
    headers: { "x-api-key": "test-key" },
  });
  const events = (await eventsResponse.json()) as {
    events: Array<{ compatibilityFailure?: string }>;
  };
  assert.equal(events.events[0].compatibilityFailure, "empty_successful_output");
});

test("metrics classify malformed tool call argument failures", async () => {
  const providerClient = new MockProviderClient(["groq"], {
    routeError: new GatewayError("Failed to parse tool call arguments as JSON", "INVALID_REQUEST", 400),
  });
  const { app } = createServer(buildConfig(), { providerClient });

  const response = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "groq/openai/gpt-oss-120b",
      input: "Use the lookup tool",
      stream: false,
      tools: [
        {
          type: "function",
          name: "lookup_issue",
          description: "Fetch a GitHub issue",
          parameters: {
            type: "object",
            properties: { number: { type: "number" } },
            required: ["number"],
          },
        },
      ],
      tool_choice: "auto",
    }),
  });

  assert.equal(response.status, 400);

  const metricsResponse = await app.request("http://localhost/metrics", {
    headers: { "x-api-key": "test-key" },
  });
  const metrics = (await metricsResponse.json()) as {
    totalRequests: number;
    errorCount: number;
    byCompatibilityFailure: Record<string, number>;
  };
  assert.equal(metrics.totalRequests, 1);
  assert.equal(metrics.errorCount, 1);
  assert.equal(metrics.byCompatibilityFailure.malformed_tool_call_json, 1);
});

test("anthropic messages with tools route via tool-safe provider", async () => {
  const providerClient = new MockProviderClient();
  const { app } = createServer(buildConfig(), { providerClient });

  const response = await app.request("http://localhost/v1/messages", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "claude-sonnet-4-6-20250618",
      messages: [{ role: "user", content: "Use a tool to fetch info" }],
      tools: [
        {
          name: "lookup",
          description: "Lookup data",
          input_schema: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
          },
        },
      ],
      stream: false,
    }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    role: string;
    content: Array<{ type: string; name?: string; input?: unknown }>;
    stop_reason: string | null;
  };
  assert.equal(body.role, "assistant");
  assert.equal(body.content[0].type, "tool_use");
  assert.equal(body.content[0].name, "lookup");
  assert.deepEqual(body.content[0].input, { number: 178 });
  assert.equal(body.stop_reason, "tool_use");
  assert.equal(providerClient.calls[0].routeClass, "planning");
  // cloudflare is claudeCodeSafe=true and first in the default planning route
  assert.equal(providerClient.calls[0].preferredProvider, "cloudflare");
});

test("routes inspect returns routing decision without provider execution", async () => {
  const providerClient = new MockProviderClient();
  const { app } = createServer(buildConfig(), { providerClient });

  const response = await app.request("http://localhost/routes/inspect", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      protocol: "openai-responses",
      client: "codex",
      body: {
        model: "gpt-5",
        input: "summarize this diff",
      },
    }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    routeClass: string;
    providerCandidates: string[];
    selectedProvider: string;
    selectedModel: string;
    fallbackChain: string[];
    capabilityDegradations: unknown[];
    workload: string;
    routePlan: {
      useCase: string;
      requirements: {
        streaming: boolean;
        toolCalling: boolean;
        structuredOutput: boolean;
      };
      capabilities: {
        supportsStreaming: boolean;
      };
      degradations: unknown[];
      warnings: string[];
    };
  };
  assert.equal(body.routeClass, "summary");
  assert.deepEqual(body.providerCandidates, ["cerebras", "groq", "cloudflare"]);
  assert.equal(body.selectedProvider, "groq");
  assert.equal(body.workload, "COST_EFFECTIVE");
  assert.equal(body.capabilityDegradations.length, 0);
  assert.equal(body.routePlan.useCase, "COST_EFFECTIVE");
  assert.equal(body.routePlan.requirements.streaming, false);
  assert.equal(body.routePlan.requirements.toolCalling, false);
  assert.equal(body.routePlan.requirements.structuredOutput, false);
  assert.equal(body.routePlan.capabilities.supportsStreaming, true);
  assert.equal(body.routePlan.degradations.length, 0);
  assert.equal(providerClient.calls.length, 0);
});

test("routes inspect exposes route-plan cache and capability details for canonical requests", async () => {
  const providerClient = new MockProviderClient(["groq", "cerebras", "cloudflare"]);
  const { app } = createServer(buildConfig(), { providerClient });

  const response = await app.request("http://localhost/routes/inspect", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      routeClass: "planning",
      messages: [{ role: "user", content: "Call this tool and return JSON." }],
      stream: true,
      output: { kind: "json_object" },
      tools: [{
        type: "function",
        function: {
          name: "lookup_issue",
          description: "Look up an issue",
          parameters: {
            type: "object",
            properties: { number: { type: "number" } },
            required: ["number"],
          },
        },
      }],
      metadata: {
        cache: {
          strategy: "both",
          key: "route-plan-test",
          ttl: 300,
          sessionId: "agent-session",
        },
      },
    }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    routeClass: string;
    selectedProvider: string;
    routePlan: {
      requirements: {
        streaming: boolean;
        toolCalling: boolean;
        structuredOutput: boolean;
      };
      capabilities: {
        supportsTools: boolean;
        supportsPromptCache: boolean;
      };
      cache: {
        strategy: string;
        responseCache: boolean;
        providerPromptCache: boolean;
        key: string;
        ttl: number;
        sessionId: string;
      };
    };
  };

  assert.equal(body.routeClass, "planning");
  assert.equal(body.selectedProvider, "groq");
  assert.equal(body.routePlan.requirements.streaming, true);
  assert.equal(body.routePlan.requirements.toolCalling, true);
  assert.equal(body.routePlan.requirements.structuredOutput, true);
  assert.equal(body.routePlan.capabilities.supportsTools, true);
  assert.equal(body.routePlan.cache.strategy, "both");
  assert.equal(body.routePlan.cache.responseCache, true);
  assert.equal(body.routePlan.cache.key, "route-plan-test");
  assert.equal(body.routePlan.cache.ttl, 300);
  assert.equal(body.routePlan.cache.sessionId, "agent-session");
  assert.equal(providerClient.calls.length, 0);
});

test("routes inspect selects Cloudflare when planning is configured Cloudflare-first", async () => {
  const providerClient = new MockProviderClient(["cloudflare", "groq", "cerebras"]);
  const config = buildConfig();
  config.routing.experimentalModels = true;
  config.routing.routes.planning = ["cloudflare", "groq", "cerebras"];
  const { app } = createServer(config, { providerClient });

  const response = await app.request("http://localhost/routes/inspect", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      protocol: "anthropic-messages",
      client: "claude-code",
      body: {
        model: "claude-sonnet-4-6-20250618",
        messages: [{ role: "user", content: "Plan a small refactor and call the lookup tool if needed." }],
        tools: [{
          name: "lookup_issue",
          description: "Look up an issue",
          input_schema: {
            type: "object",
            properties: { number: { type: "number" } },
            required: ["number"],
          },
        }],
      },
    }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    routeClass: string;
    providerCandidates: string[];
    selectedProvider: string;
    routePlan: {
      requirements: {
        toolCalling: boolean;
      };
    };
  };

  assert.equal(body.routeClass, "planning");
  assert.deepEqual(body.providerCandidates, ["cloudflare", "groq", "cerebras"]);
  assert.equal(body.selectedProvider, "cloudflare");
  assert.equal(body.routePlan.requirements.toolCalling, true);
  assert.equal(providerClient.calls.length, 0);
});

test("routes inspect resolves StackBilt and provider aliases", async () => {
  const providerClient = new MockProviderClient(["groq", "cerebras", "cloudflare"]);
  const { app } = createServer(buildConfig(), { providerClient });

  const stackbiltResponse = await app.request("http://localhost/routes/inspect", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      protocol: "openai-responses",
      client: "codex",
      body: {
        model: "stackbilt/code-fast",
        input: "fix this function",
      },
    }),
  });

  assert.equal(stackbiltResponse.status, 200);
  const stackbilt = (await stackbiltResponse.json()) as {
    routeClass: string;
    selectedProvider: string;
    selectedModel: string;
    modelResolution: { kind: string; alias: string; routeClass: string };
  };
  assert.equal(stackbilt.routeClass, "code_draft");
  assert.equal(stackbilt.selectedProvider, "groq");
  assert.equal(stackbilt.selectedModel, "llama-3.3-70b-versatile");
  assert.equal(stackbilt.modelResolution.kind, "gateway_alias");
  assert.equal(stackbilt.modelResolution.alias, "stackbilt/code-fast");

  const providerResponse = await app.request("http://localhost/routes/inspect", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      protocol: "openai-responses",
      client: "codex",
      body: {
        model: "groq/llama-3.3-70b-versatile",
        input: "summarize this",
      },
    }),
  });

  assert.equal(providerResponse.status, 200);
  const provider = (await providerResponse.json()) as {
    selectedProvider: string;
    selectedModel: string;
    modelResolution: { kind: string; alias: string; provider: string; model: string };
  };
  assert.equal(provider.selectedProvider, "groq");
  assert.equal(provider.selectedModel, "llama-3.3-70b-versatile");
  assert.equal(provider.modelResolution.kind, "provider_alias");
  assert.equal(provider.modelResolution.alias, "groq/llama-3.3-70b-versatile");
});

test("codex inspect prefers safe provider over list order when experimental routing is enabled", async () => {
  // groq is codexSafe=true; cerebras is codexSafe="experimental".
  // Even when experimentalModels=true and cerebras is listed first, groq should be
  // selected because safe-first preference is unconditional.
  const providerClient = new MockProviderClient(["cerebras", "groq", "cloudflare"]);
  const config = buildConfig();
  config.routing.experimentalModels = true;
  config.routing.routes.code_draft = ["cerebras", "groq", "cloudflare"];
  const { app } = createServer(config, { providerClient });

  const response = await app.request("http://localhost/routes/inspect", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      protocol: "openai-responses",
      client: "codex",
      body: {
        model: "stackbilt/code-fast",
        input: "Review this repository and propose a small patch.",
      },
    }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    selectedProvider: string;
    selectedModel: string;
    fallbackChain: string[];
  };
  assert.equal(body.selectedProvider, "groq");
  assert.equal(body.selectedModel, "llama-3.3-70b-versatile");
  assert.deepEqual(body.fallbackChain, ["groq", "cloudflare"]);
  assert.equal(providerClient.calls.length, 0);
});

test("unknown native model labels keep auto-routing without upstream model override", async () => {
  const providerClient = new MockProviderClient(["groq", "cerebras", "cloudflare"]);
  const { app } = createServer(buildConfig(), { providerClient });

  const response = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "gpt-5.5",
      input: "summarize this code",
      stream: false,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(providerClient.calls.length, 1);
  assert.equal(providerClient.calls[0].routeClass, "summary");
  assert.equal(providerClient.calls[0].preferredProvider, "groq");
  assert.equal(providerClient.calls[0].request.model, undefined);
  assert.equal(providerClient.calls[0].modelOverride, undefined);
  assert.deepEqual(providerClient.calls[0].request.metadata?.custom?.modelResolution, {
    kind: "auto_hidden",
    requestedModel: "gpt-5.5",
  });
});

test("codex unknown model sentinel is treated as gateway auto-routing", async () => {
  const providerClient = new MockProviderClient(["groq", "cerebras", "cloudflare"]);
  const { app } = createServer(buildConfig(), { providerClient });

  const response = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "unknown",
      input: "implement a tiny helper function",
      stream: false,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(providerClient.calls.length, 1);
  assert.equal(providerClient.calls[0].routeClass, "code_draft");
  assert.equal(providerClient.calls[0].preferredProvider, "groq");
  assert.equal(providerClient.calls[0].request.model, undefined);
  assert.equal(providerClient.calls[0].modelOverride, undefined);
  assert.deepEqual(providerClient.calls[0].request.metadata?.custom?.modelResolution, { kind: "none" });
});

test("provider aliases force provider and concrete model override", async () => {
  const providerClient = new MockProviderClient(["groq", "cerebras", "cloudflare"]);
  const { app } = createServer(buildConfig(), { providerClient });

  const response = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "groq/llama-3.3-70b-versatile",
      input: "summarize this code",
      stream: false,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(providerClient.calls.length, 1);
  assert.equal(providerClient.calls[0].preferredProvider, "groq");
  assert.equal(providerClient.calls[0].modelOverride, "llama-3.3-70b-versatile");
  assert.equal(providerClient.calls[0].request.model, "llama-3.3-70b-versatile");
});

test("shadow mode forces provider aliases through Anthropic without model override and records would-route telemetry", async () => {
  const providerClient = new MockProviderClient(["anthropic", "cerebras", "groq", "cloudflare"]);
  const config = buildConfig();
  config.routing.shadowMode = true;
  const { app } = createServer(config, { providerClient });

  const response = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "cerebras/openai/gpt-oss-120b",
      input: "summarize this code",
      stream: false,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(providerClient.calls.length, 1);
  assert.equal(providerClient.calls[0].routeClass, "summary");
  assert.equal(providerClient.calls[0].preferredProvider, "anthropic");
  assert.equal(providerClient.calls[0].modelOverride, undefined);
  assert.equal(providerClient.calls[0].request.model, "openai/gpt-oss-120b");
  assert.deepEqual(providerClient.calls[0].request.metadata?.custom?.modelResolution, {
    kind: "provider_alias",
    requestedModel: "cerebras/openai/gpt-oss-120b",
    alias: "cerebras/openai/gpt-oss-120b",
    provider: "cerebras",
    model: "openai/gpt-oss-120b",
  });

  const metricsResponse = await app.request("http://localhost/metrics", {
    headers: { "x-api-key": "test-key" },
  });
  const metrics = (await metricsResponse.json()) as { byProvider: Record<string, number> };
  assert.equal(metrics.byProvider.anthropic, 1);
  assert.equal(metrics.byProvider.cerebras, undefined);

  const eventsResponse = await app.request("http://localhost/events/recent", {
    headers: { "x-api-key": "test-key" },
  });
  const events = (await eventsResponse.json()) as {
    events: Array<{
      selectedProvider: string;
      routeClass: string;
      shadowRoute?: string;
      shadowProvider?: string;
      shadowConfidence?: string;
    }>;
  };
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].selectedProvider, "anthropic");
  assert.equal(events.events[0].routeClass, "summary");
  assert.equal(events.events[0].shadowRoute, "summary");
  assert.equal(events.events[0].shadowProvider, "cerebras");
  assert.equal(events.events[0].shadowConfidence, "high");
});

test("routes inspect keeps provider aliases shadowed when shadow mode is on", async () => {
  const providerClient = new MockProviderClient(["anthropic", "cerebras", "groq", "cloudflare"]);
  const config = buildConfig();
  config.routing.shadowMode = true;
  const { app } = createServer(config, { providerClient });

  const response = await app.request("http://localhost/routes/inspect", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      protocol: "openai-responses",
      client: "codex",
      body: {
        model: "cerebras/openai/gpt-oss-120b",
        input: "summarize this code",
      },
    }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    selectedProvider: string;
    selectedModel: string;
    shadowMode: boolean;
  };
  assert.equal(body.shadowMode, true);
  assert.equal(body.selectedProvider, "anthropic");
  assert.notEqual(body.selectedModel, "openai/gpt-oss-120b");
  assert.equal(providerClient.calls.length, 0);
});

test("streaming is exposed as SSE for all protocol endpoints", async () => {
  const providerClient = new MockProviderClient();
  const { app } = createServer(buildConfig(), { providerClient });

  const anthropicStream = await app.request("http://localhost/v1/messages", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "claude-sonnet-4-6-20250618",
      messages: [{ role: "user", content: "stream please" }],
      stream: true,
    }),
  });
  assert.equal(anthropicStream.status, 200);
  assert.match(anthropicStream.headers.get("content-type") ?? "", /^text\/event-stream/);
  assertSsePayload(await anthropicStream.text(), "message");

  const responsesStream = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "gpt-5",
      input: "stream this",
      stream: true,
    }),
  });
  assert.equal(responsesStream.status, 200);
  assert.match(responsesStream.headers.get("content-type") ?? "", /^text\/event-stream/);
  const responsesPayload = await responsesStream.text();
  assertSsePayload(responsesPayload, "response.output_text.delta");

  const responsesEvents = parseSseEvents(responsesPayload);
  assert.deepEqual(
    responsesEvents.map((event) => event.event),
    [
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ],
  );
  assert.deepEqual(
    responsesEvents.map((event) => event.data.sequence_number),
    responsesEvents.map((_, index) => index),
  );
  assert.equal(responsesEvents[3].data.type, "response.output_text.delta");
  assert.equal(responsesEvents[3].data.delta, "mock-");
  assert.equal(responsesEvents[4].data.delta, "output");
  assert.equal(responsesEvents.at(-1)?.data.type, "response.completed");
  assert.equal(responsesEvents.at(-1)?.data.response?.status, "completed");
  const completedTextOutput = responsesEvents.at(-1)?.data.response?.output[0];
  assert.equal(completedTextOutput?.type, "message");
  assert.equal(completedTextOutput?.content?.[0].text, "mock-output");
  assert.doesNotMatch(responsesPayload, /event: done/);
  assert.doesNotMatch(responsesPayload, /\[DONE\]/);

  const chatStream = await app.request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "gpt-5",
      messages: [{ role: "user", content: "stream chat" }],
      stream: true,
    }),
  });
  assert.equal(chatStream.status, 200);
  assert.match(chatStream.headers.get("content-type") ?? "", /^text\/event-stream/);
  assertSsePayload(await chatStream.text(), "chat.completion.chunk");
});

test("codex responses preserve tool schemas on planning routes and stream function calls", async () => {
  const providerClient = new MockProviderClient(["groq", "cerebras"]);
  const { app } = createServer(buildConfig(), { providerClient });

  const responsesStream = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "stackbilt/auto",
      input: "review issue 178",
      stream: true,
      tools: [
        {
          type: "function",
          name: "lookup_issue",
          description: "Fetch a GitHub issue",
          parameters: {
            type: "object",
            properties: { number: { type: "number" } },
            required: ["number"],
          },
        },
      ],
      tool_choice: "auto",
    }),
  });

  assert.equal(responsesStream.status, 200);
  const responsesPayload = await responsesStream.text();
  const responsesEvents = parseSseEvents(responsesPayload);

  assert.equal(providerClient.calls[0].routeClass, "planning");
  assert.equal(providerClient.calls[0].preferredProvider, "groq");
  assert.equal(providerClient.calls[0].request.stream, false);
  assert.equal(providerClient.calls[0].request.tools?.[0].function.name, "lookup_issue");
  assert.ok(responsesEvents.some((event) => event.event === "response.function_call_arguments.delta"));
  assert.ok(responsesEvents.some((event) => event.event === "response.function_call_arguments.done"));
  assert.equal(responsesEvents.at(-1)?.event, "response.completed");
  assert.equal(responsesEvents.at(-1)?.data.response?.output[0].type, "function_call");
  assert.equal(responsesEvents.at(-1)?.data.response?.output[0].name, "lookup_issue");
});

test("codex responses drops provider tool calls that were not requested", async () => {
  const providerClient = new MockProviderClient(["groq", "cerebras"], { invalidToolCall: true });
  const { app } = createServer(buildConfig(), { providerClient });

  const response = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "stackbilt/auto",
      input: "review issue 178",
      stream: false,
      tools: [
        {
          type: "function",
          name: "lookup_issue",
          description: "Fetch a GitHub issue",
          parameters: {
            type: "object",
            properties: { number: { type: "number" } },
            required: ["number"],
          },
        },
      ],
      tool_choice: "auto",
    }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    output: Array<{ type: string; name?: string; content?: Array<{ text: string }> }>;
  };
  assert.equal(body.output[0].type, "message");
  assert.match(body.output[0].content?.[0].text ?? "", /unsupported tool call/);
  assert.equal(body.output.some((item) => item.type === "function_call"), false);
});
