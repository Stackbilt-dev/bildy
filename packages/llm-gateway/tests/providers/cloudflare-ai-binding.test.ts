import assert from "node:assert/strict";
import test from "node:test";
import { createCloudflareAiBinding } from "../../src/providers/cloudflare-ai-binding.js";

test("Cloudflare AI binding routes chat requests through AI Gateway when configured", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | undefined;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify({
      success: true,
      result: { response: "ok" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const ai = createCloudflareAiBinding({
      accountId: "acct-123",
      apiToken: "token-123",
      apiBaseUrl: "https://api.cloudflare.test/client/v4/",
      gatewayId: "aegis",
    });

    await ai.run(
      "@cf/moonshotai/kimi-k2.6",
      { messages: [{ role: "user", content: "Plan a patch." }], max_tokens: 64 },
      {
        extraHeaders: { "x-session-affinity": "agent-session-123" },
        gateway: {
          id: "aegis",
          cacheKey: "planning:agent-session-123",
          cacheTtl: 300,
          collectLog: true,
          metadata: {
            app: "llm-gateway",
            routeClass: "planning",
            executor: "claude-code",
          },
        },
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(captured);
  assert.equal(captured.url, "https://api.cloudflare.test/client/v4/accounts/acct-123/ai/v1/chat/completions");
  assert.equal(captured.init.method, "POST");

  const headers = captured.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer token-123");
  assert.equal(headers["cf-aig-gateway-id"], "aegis");
  assert.equal(headers["cf-aig-cache-key"], "planning:agent-session-123");
  assert.equal(headers["cf-aig-cache-ttl"], "300");
  assert.equal(headers["cf-aig-collect-log"], "true");
  assert.equal(headers["x-session-affinity"], "agent-session-123");
  assert.deepEqual(JSON.parse(headers["cf-aig-metadata"]), {
    app: "llm-gateway",
    routeClass: "planning",
    executor: "claude-code",
  });

  assert.deepEqual(JSON.parse(String(captured.init.body)), {
    messages: [{ role: "user", content: "Plan a patch." }],
    max_tokens: 64,
    model: "@cf/moonshotai/kimi-k2.6",
  });
});

test("Cloudflare AI binding disables upstream streaming for local REST shim calls", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | undefined;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify({
      success: true,
      result: { response: "stream normalized" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const ai = createCloudflareAiBinding({
      accountId: "acct-123",
      apiToken: "token-123",
      apiBaseUrl: "https://api.cloudflare.test/client/v4/",
    });

    const result = await ai.run(
      "@cf/moonshotai/kimi-k2.6",
      { messages: [{ role: "user", content: "Reply ok." }], max_tokens: 64, stream: true },
    );

    assert.deepEqual(result, { response: "stream normalized" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(captured);
  assert.equal(captured.url, "https://api.cloudflare.test/client/v4/accounts/acct-123/ai/run/%40cf/moonshotai/kimi-k2.6");
  assert.deepEqual(JSON.parse(String(captured.init.body)), {
    messages: [{ role: "user", content: "Reply ok." }],
    max_tokens: 64,
    stream: false,
  });
});

test("Cloudflare AI binding preserves model path segments for direct Workers AI runs", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | undefined;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({
      success: true,
      result: { response: "ok" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const ai = createCloudflareAiBinding({
      accountId: "acct-123",
      apiToken: "token-123",
      apiBaseUrl: "https://api.cloudflare.test/client/v4/",
    });

    await ai.run("@cf/openai/gpt-oss-120b", { prompt: "Reply ok" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    capturedUrl,
    "https://api.cloudflare.test/client/v4/accounts/acct-123/ai/run/%40cf/openai/gpt-oss-120b",
  );
});
