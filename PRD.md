# Product Requirements Document: bildy

## 1. Product Summary

**Product Name:** bildy
**Package Name:** `bildy`
**Status:** Concept → MVP Definition
**Primary User:** Independent AI developer, local agent-tool power user, AI engineering team, platform/governance operator
**Core Idea:** A local-first LLM gateway that lets Claude Code, OpenAI Codex, and future agent CLIs route through a lightweight localhost proxy before reaching external model providers.

bildy provides protocol-compatible local endpoints for AI coding tools, then delegates model selection, failover, cost optimization, cache hints, and provider abstraction to `@stackbilt/llm-providers`.

The gateway is not intended to be a full LiteLLM clone. It is a focused agent-dev control plane for reducing model spend, improving routing intelligence, and creating telemetry/governance hooks around local AI coding workflows.

---

## 2. Problem Statement

Modern AI coding tools such as Claude Code and Codex can become expensive because they repeatedly send large context payloads, tool schemas, repository instructions, and conversational history to high-cost frontier models.

Developers increasingly want to route these tools through local or self-hosted proxies so they can:

* Use cheaper models for simple requests.
* Reserve premium models for hard reasoning and tool-heavy tasks.
* Cache repeated prompt prefixes and static context.
* Track token usage and provider costs across tools.
* Avoid being locked into one provider.
* Experiment with Cloudflare Workers AI, Groq, Cerebras, OpenAI, Anthropic, and other providers behind one local interface.
* Add governance and observability around agent behavior.

Existing proxy solutions are either too generic, too provider-specific, or too focused on raw OpenAI compatibility. bildy is a gateway shaped specifically for local AI coding workflows and future governed agent orchestration.

---

## 3. Product Goals

### 3.1 MVP Goals

The MVP should allow a developer to run a local server that:

1. Accepts Claude Code requests through an Anthropic-compatible local endpoint.
2. Accepts Codex requests through OpenAI-compatible local endpoints.
3. Converts client-specific request formats into a normalized internal `LLMRequest`.
4. Routes requests through `@stackbilt/llm-providers`.
5. Supports streaming responses.
6. Applies simple routing policy based on request type, tool usage, cost, and provider health.
7. Provides local metrics for provider, model, token usage, latency, cost estimate, fallback path, and cache status.
8. Provides a safe default configuration that avoids breaking coding-agent workflows.

### 3.2 Strategic Goals

Over time, bildy should become:

* The local-first model-routing layer for agentic developer workflows.
* A practical bridge between Claude Code, Codex, Gemini CLI, OpenCode, Continue, and future coding agents.
* A cost-control layer for AI-assisted software development.
* A proving ground for model-routing heuristics before upstreaming to edge deployments.

---

## 4. Non-Goals

The MVP should **not** attempt to:

* Become a full replacement for LiteLLM.
* Support every provider protocol on day one.
* Provide a hosted multi-tenant SaaS gateway.
* Implement advanced semantic caching before basic prefix/request caching works.
* Rewrite the model-selection logic already present in `@stackbilt/llm-providers`.
* Automatically downgrade tool-heavy requests to weak models without compatibility testing.
* Support production enterprise auth, RBAC, or billing in the first version.
* Depend on Cloudflare Workers for the local MVP.

---

## 5. Target Users

### 5.1 Solo AI Developer

A developer using Claude Code, Codex, or similar tools locally who wants lower cost and better control over provider routing.

**Needs:**

* Easy local install.
* One command to start the gateway.
* Drop-in config for Claude Code and Codex.
* Sensible defaults.
* Cost and token visibility.

### 5.2 Agent Tool Builder

A developer building local or repo-specific agent workflows who wants to experiment with routing policies and model compatibility.

**Needs:**

* Adapter APIs.
* Request/response logs.
* Configurable routing rules.
* Provider health data.
* Easy integration with custom tools.

### 5.3 Governance / Platform Operator

A technical lead who wants visibility into how AI coding agents are being used across projects.

**Needs:**

* Structured telemetry.
* Audit-friendly event logs.
* Provider and model attribution.
* Cost estimates by project/session/tool.

---

## 6. User Stories

### 6.1 Claude Code Local Routing

As a developer, I want Claude Code to send requests to `localhost` first so that I can route some work to cheaper models while keeping Claude-compatible behavior.

**Acceptance Criteria:**

* User can set `ANTHROPIC_BASE_URL=http://localhost:8787`.
* User can start the gateway locally.
* Claude Code can complete a basic prompt through the gateway.
* Gateway returns Anthropic-compatible non-streaming responses.
* Gateway returns Anthropic-compatible streaming responses.
* Errors are translated into a format Claude Code can understand.

### 6.2 Codex Local Routing

As a developer, I want Codex to use bildy as a custom OpenAI-compatible provider.

**Acceptance Criteria:**

* User can configure Codex with a custom provider pointing at `http://localhost:8787/v1`.
* Gateway supports either `/v1/responses` or `/v1/chat/completions`.
* Codex can complete a basic coding prompt through the gateway.
* Streaming is supported where the client expects it.

### 6.3 Cost-Aware Routing

As a developer, I want cheap/simple requests routed to low-cost providers and complex/tool-heavy requests routed to safer premium models.

**Acceptance Criteria:**

* Gateway classifies requests into a small set of route classes.
* Gateway can prefer Cloudflare, Groq, or Cerebras for simple requests.
* Gateway can prefer Anthropic/OpenAI for high-risk tool-heavy requests.
* Routing decision is recorded in local telemetry.
* User can override routing policy in config.

### 6.4 Provider Failover

As a developer, I want failed, rate-limited, or degraded providers to fall back automatically.

**Acceptance Criteria:**

* Gateway uses `@stackbilt/llm-providers` circuit-breaker/fallback behavior.
* Provider failures do not crash the local server.
* Fallback chain is recorded in telemetry.
* Final response includes usage/provider metadata where possible.

### 6.5 Local Observability

As a developer, I want to see which tools, providers, and models are consuming tokens.

**Acceptance Criteria:**

* Gateway exposes `GET /health`.
* Gateway exposes `GET /metrics`.
* Gateway records per-request events locally.
* Metrics include client, route class, provider, model, latency, token usage, cost estimate, cache hit/miss, and fallback path.

---

## 7. Functional Requirements

## 7.1 Local Server

The gateway must run as a local development server.

### Requirements

* Provide CLI command:

```bash
npx bildy start --port 8787
```

* Default port: `8787`.
* Runtime: Node.js 18+.
* Optional future runtime: Bun.
* Must load provider keys from environment variables.
* Must load gateway config from `gateway.config.json`, `stackbilt.gateway.json`, or CLI flags.

### Example Environment

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GROQ_API_KEY=gsk_...
export CEREBRAS_API_KEY=csk-...
export BILDY_GATEWAY_KEY=local-dev-key
```

---

## 7.2 Anthropic Messages Adapter

The gateway must provide an Anthropic-compatible endpoint for Claude Code.

### Endpoint

```txt
POST /v1/messages
```

### Requirements

* Accept Anthropic Messages-style requests.
* Normalize request into internal `LLMRequest`.
* Preserve important fields:

  * `model`
  * `messages`
  * `system`
  * `max_tokens`
  * `temperature`
  * `tools`
  * `tool_choice`
  * `stream`
* Convert internal response back to Anthropic-compatible shape.
* Support streaming SSE.
* Translate provider errors into Anthropic-compatible error objects.

### Conservative Tool Rule

If a Claude Code request includes tools, the gateway must route only to models/providers marked as tool-compatible and Claude-Code-safe unless the user explicitly enables experimental routing.

---

## 7.3 OpenAI Responses Adapter

The gateway should provide an OpenAI Responses-compatible endpoint for Codex.

### Endpoint

```txt
POST /v1/responses
```

### Requirements

* Accept OpenAI Responses-style requests.
* Normalize input into internal `LLMRequest`.
* Support streaming where needed.
* Convert internal response into Responses API-compatible output.
* Preserve tool/function call fields where possible.

---

## 7.4 OpenAI Chat Completions Adapter

The gateway should optionally provide a Chat Completions-compatible endpoint for broader compatibility.

### Endpoint

```txt
POST /v1/chat/completions
```

### Requirements

* Accept OpenAI Chat Completions-style requests.
* Normalize messages into internal `LLMRequest`.
* Convert response into Chat Completions-compatible shape.
* Support streaming chunks.

---

## 7.5 Internal Adapter Interface

Each client protocol should be implemented as an adapter.

```ts
interface ClientAdapter<ClientRequest, ClientResponse> {
  toLLMRequest(input: ClientRequest, context: GatewayRequestContext): LLMRequest;
  fromLLMResponse(output: LLMResponse, context: GatewayRequestContext): ClientResponse;
  fromLLMStream?(
    stream: ReadableStream<string>,
    context: GatewayRequestContext
  ): ReadableStream<Uint8Array>;
}
```

### Supported Initial Adapters

* `anthropic-messages`
* `openai-responses`
* `openai-chat-completions`

### Future Adapters

* Gemini CLI
* Continue.dev
* OpenCode
* Aider
* Custom agent protocol

---

## 7.6 Routing Policy

The gateway should classify requests before routing.

### Initial Route Classes

```ts
type RouteClass =
  | 'cheap_edit'
  | 'fast_code'
  | 'deep_reasoning'
  | 'tool_heavy'
  | 'long_context'
  | 'fallback_safe';
```

### Default Routing Intent

| Route Class      | Description                             | Preferred Providers                               |
| ---------------- | --------------------------------------- | ------------------------------------------------- |
| `cheap_edit`     | Small edits, summaries, simple rewrites | Cloudflare, Groq, Cerebras                        |
| `fast_code`      | Normal coding/refactor tasks            | Groq, Cerebras, Cloudflare                        |
| `deep_reasoning` | Architecture, debugging, complex design | Anthropic, OpenAI, Cerebras                       |
| `tool_heavy`     | Tool/function-heavy agent work          | Anthropic, OpenAI, known-compatible Groq/Cerebras |
| `long_context`   | Large repo/context requests             | Anthropic, OpenAI                                 |
| `fallback_safe`  | Unknown or risky requests               | Anthropic, OpenAI                                 |

### Routing Requirements

* Must support `defaultProvider: 'auto'` through `@stackbilt/llm-providers`.
* Must allow user override by route class.
* Must record route decision and provider result.
* Must allow experimental providers behind config flags.

---

## 7.7 Model Compatibility Registry

The gateway must maintain model compatibility metadata separate from raw provider availability.

### Example

```ts
interface ModelCompatibility {
  provider: string;
  model: string;
  streaming: boolean;
  tools: boolean;
  vision?: boolean;
  claudeCodeSafe: boolean | 'experimental';
  codexSafe: boolean | 'experimental';
  notes?: string;
}
```

### Requirements

* Tool-heavy requests must check compatibility before routing.
* Experimental models must be opt-in.
* Compatibility failures should trigger fallback.
* Compatibility registry should be editable without changing core provider logic.

---

## 7.8 Caching

The MVP should include local caching, but avoid unsafe overreach.

### Cache Types

#### 1. Prompt Prefix Cache

Caches stable prompt sections such as:

* System prompts.
* Tool schemas.
* Repo instructions.
* Static agent policy blocks.

#### 2. Response Cache

Caches deterministic, read-only responses where safe.

Examples:

* Explain this file.
* Summarize this error.
* Classify this request.

Avoid caching:

* Tool execution results.
* File mutation requests.
* Commands that depend on current repo state.
* Anything with secrets.

#### 3. Provider Health Cache

Tracks recent provider latency, errors, rate-limit pressure, and circuit-breaker state.

### MVP Storage

Use SQLite for local MVP.

### Future Storage

For hosted/edge version:

* D1 for structured event ledger.
* KV for coarse cache lookups.
* R2 for large trace artifacts.
* Durable Objects for per-session state.

---

## 7.9 Telemetry and Metrics

Every request should produce a structured event.

### Request Event Fields

```ts
interface GatewayRequestEvent {
  id: string;
  timestamp: string;
  client: 'claude-code' | 'codex' | 'unknown';
  protocol: 'anthropic-messages' | 'openai-responses' | 'openai-chat';
  sessionId?: string;
  repoPath?: string;
  routeClass: RouteClass;
  requestedModel?: string;
  selectedProvider: string;
  selectedModel: string;
  fallbackChain: string[];
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costEstimateUsd?: number;
  latencyMs: number;
  cacheHit: boolean;
  status: 'success' | 'error' | 'fallback_success';
  errorClass?: string;
}
```

### Endpoints

```txt
GET /health
GET /metrics
GET /events/recent
```

### Requirements

* Metrics must be readable locally without external services.
* Logs must avoid storing full prompts by default.
* Full prompt tracing must be opt-in.
* Secret redaction must be applied before storing traces.

---

## 7.10 Configuration

### Example Config

```json
{
  "port": 8787,
  "auth": {
    "mode": "local-key",
    "keys": ["local-dev-key"]
  },
  "routing": {
    "default": "auto",
    "experimentalModels": false,
    "routes": {
      "cheap_edit": ["cloudflare", "groq", "cerebras"],
      "fast_code": ["groq", "cerebras", "cloudflare"],
      "deep_reasoning": ["anthropic", "openai", "cerebras"],
      "tool_heavy": ["anthropic", "openai"],
      "long_context": ["anthropic", "openai"],
      "fallback_safe": ["anthropic", "openai"]
    }
  },
  "cache": {
    "enabled": true,
    "storage": "sqlite",
    "path": ".bildy/gateway/cache.sqlite",
    "responseCache": false
  },
  "telemetry": {
    "enabled": true,
    "storePrompts": false,
    "redactSecrets": true,
    "path": ".bildy/gateway/events.sqlite"
  }
}
```

---

## 8. Technical Architecture

## 8.1 System Diagram

```txt
Claude Code / Codex / Agent CLI
        |
        v
Localhost Gateway Server
        |
        v
Protocol Adapter
  - Anthropic Messages
  - OpenAI Responses
  - OpenAI Chat
        |
        v
Request Classifier + Policy Layer
        |
        v
Cache Layer + Telemetry Layer
        |
        v
@stackbilt/llm-providers
        |
        v
Cloudflare Workers AI / Groq / Cerebras / Anthropic / OpenAI
```

---

## 8.2 Package Boundary

### `@stackbilt/llm-providers`

Responsible for:

* Provider abstraction.
* Model catalog.
* Circuit breakers.
* Retry/failover.
* Cost tracking.
* Provider-specific request/response handling.
* Streaming provider support.

### `bildy`

Responsible for:

* Local server.
* Client protocol compatibility.
* Request classification.
* Gateway-specific routing policy.
* Local caching.
* Local telemetry.
* CLI setup and config.

---

## 8.3 Suggested File Structure

```txt
packages/llm-gateway/
  src/
    cli.ts
    server.ts
    config.ts
    auth.ts
    policy/
      classify.ts
      routes.ts
      compatibility.ts
    adapters/
      anthropic-messages.ts
      openai-responses.ts
      openai-chat.ts
    cache/
      sqlite-cache.ts
      keys.ts
      redaction.ts
    telemetry/
      events.ts
      metrics.ts
      sqlite-events.ts
    errors.ts
    types.ts
  tests/
    adapters/
    policy/
    streaming/
  examples/
    claude-code.md
    codex.md
  package.json
  README.md
```

---

## 9. MVP Scope

### Must Have

* CLI start command.
* Local HTTP server.
* `/health` endpoint.
* Anthropic Messages endpoint.
* OpenAI Responses endpoint.
* Basic OpenAI Chat Completions endpoint.
* Non-streaming and streaming support.
* Basic request classification.
* Integration with `@stackbilt/llm-providers`.
* Local telemetry events.
* Safe default routing policy.
* Documentation for Claude Code setup.
* Documentation for Codex setup.

### Should Have

* SQLite event storage.
* Prefix cache.
* Config file support.
* Simple metrics endpoint.
* Compatibility registry.
* Secret redaction.
* Fallback-chain reporting.

### Could Have

* Response cache.
* Local dashboard.
* Web UI for metrics.
* Repo-aware routing.
* Token estimation before routing.

### Won't Have in MVP

* Multi-user hosted service.
* Hosted/edge deployment (future).
* Full RBAC.
* Billing.
* Advanced semantic cache.
* Automatic codebase indexing.
* Full enterprise audit UI.

---

## 10. Success Metrics

### MVP Success

The MVP is successful if:

* Claude Code can operate through the gateway for basic tasks.
* Codex can operate through the gateway for basic tasks.
* At least three provider backends can be used through one local server.
* Streaming works for both Anthropic-style and OpenAI-style clients.
* Tool-heavy requests are not accidentally routed to incompatible models by default.
* Per-request provider/model/token/cost telemetry is captured.
* A developer can install and test within 10 minutes.

### Product Success

Longer-term success means:

* Meaningful token/cost reduction compared to direct Claude/OpenAI usage.
* Reliable fallback under provider rate limits.
* Useful local analytics by project/session/tool.
* Reusable adapter pattern for additional agent CLIs.
* Governance telemetry can consume gateway events.

---

## 11. Risks and Mitigations

## 11.1 Protocol Drift

### Risk

Claude Code and Codex may change expected API behavior.

### Mitigation

* Keep protocol adapters isolated.
* Add fixture-based compatibility tests.
* Version adapters independently.
* Avoid hardcoding assumptions outside adapter files.

---

## 11.2 Tool Calling Breakage

### Risk

Agent coding tools rely on precise tool/function behavior. Incompatible models may break workflows.

### Mitigation

* Conservative default routing for tool-heavy requests.
* Model compatibility registry.
* Experimental routing opt-in.
* Fixture tests for tool-call request/response shapes.

---

## 11.3 False Economy

### Risk

Cheap models may produce lower-quality outputs that require retries, increasing total cost and frustration.

### Mitigation

* Use cheap models for low-risk classes only.
* Track fallback and retry rates.
* Escalate after failure or low-confidence patterns.
* Let users pin premium models per route class.

---

## 11.4 Unsafe Caching

### Risk

Caching mutable or sensitive requests can create stale, incorrect, or unsafe behavior.

### Mitigation

* Prefix cache on by default.
* Response cache off by default.
* Full prompt storage off by default.
* Secret redaction enabled by default.
* No caching for tool execution or file mutation requests.

---

## 11.5 Gateway Becomes Too Broad

### Risk

The product expands into a generic proxy and loses its developer-facing wedge.

### Mitigation

* Keep MVP focused on local coding agents.
* Treat provider routing as delegated to `@stackbilt/llm-providers`.
* Prioritize observability, governance readiness, and agent compatibility.

---

## 12. Phased Roadmap

## Phase 0: Spike

### Goal

Prove that Claude Code and Codex can hit a local gateway and receive valid responses.

### Deliverables

* Minimal Hono or Express server.
* Hardcoded Anthropic `/v1/messages` response.
* Hardcoded OpenAI `/v1/responses` or `/v1/chat/completions` response.
* Confirm client configuration.

---

## Phase 1: Functional MVP

### Goal

Real routing through `@stackbilt/llm-providers`.

### Deliverables

* Anthropic adapter.
* OpenAI Responses adapter.
* OpenAI Chat adapter.
* Streaming support.
* Basic request classifier.
* Provider routing through `LLMProviders.fromEnv()`.
* `/health` endpoint.
* Basic telemetry logs.

---

## Phase 2: Cost and Cache Layer

### Goal

Make the gateway economically useful.

### Deliverables

* SQLite event store.
* Prefix cache.
* Token/cost reporting.
* Fallback-chain reporting.
* Basic metrics endpoint.
* Configurable route classes.

---

## Phase 3: Compatibility Hardening

### Goal

Make the gateway safe for real coding-agent use.

### Deliverables

* Model compatibility registry.
* Tool-call compatibility tests.
* Client fixture tests.
* Redaction layer.
* Failure-mode tests.
* Experimental model flags.

---

## Phase 4: Edge / Team Gateway

### Goal

Deploy a shared gateway for team or cloud use.

### Deliverables

* Cloudflare Worker gateway mode.
* D1 event ledger.
* KV/R2-backed cache/trace storage.
* Durable Object session coordinator.
* API key auth.
* Usage limits.
* Team-level metrics.

---

## 13. Open Questions

1. Which Claude Code request/response fields are strictly required for stable operation?
2. Which Codex wire API should be prioritized first: Responses or Chat Completions?
3. Should the first MVP support tool calls end-to-end or initially route tool-heavy requests only to Anthropic/OpenAI?
4. Should `@stackbilt/llm-providers` expose additional gateway metadata hooks?
5. Should route classification live fully in `bildy`, or should some classifier helpers be added to `@stackbilt/llm-providers`?
6. Should local telemetry use SQLite directly, or a pluggable storage interface from the start?
7. Should this package be part of the existing monorepo or remain independent at first?

---

## 14. Recommended Initial Implementation

Build the first implementation as a separate package:

```txt
bildy
```

Use:

* Node.js 18+.
* Hono or Fastify.
* `@stackbilt/llm-providers` as the routing engine.
* SQLite for local event/cache storage.
* Isolated adapters for Anthropic and OpenAI protocols.

The first useful milestone should be:

```txt
Claude Code → localhost:8787/v1/messages → bildy → Groq/Cerebras/Anthropic fallback → valid streamed response
```

The second useful milestone should be:

```txt
Codex → localhost:8787/v1/responses → bildy → model-router → valid streamed response
```

Only after those two flows work should the project invest heavily in caching, dashboards, or governance integrations.

---

## 15. Product Positioning

### Short Positioning

bildy is a local-first AI coding gateway that routes Claude Code, Codex, and future agent CLIs across multiple LLM providers with cost controls, caching, fallback, and governance-ready telemetry.

### Developer-Facing Tagline

**A local model-routing gateway for serious AI coding workflows.**

### Longer Positioning

Most LLM proxies focus on raw provider compatibility. bildy focuses on agentic developer workflows: coding assistants, CLI agents, repo-aware sessions, model routing, cost pressure, fallback, and governance traces. It gives independent builders and engineering teams a lightweight control plane between their coding agents and the rapidly changing model provider ecosystem.

---

## 16. Appendix: Example Claude Code Setup

```bash
npm install -g bildy

export ANTHROPIC_API_KEY=sk-ant-...
export GROQ_API_KEY=gsk_...
export CEREBRAS_API_KEY=csk-...
export BILDY_GATEWAY_KEY=local-dev-key

bildy-gateway start --port 8787

export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_API_KEY=local-dev-key

claude
```

---

## 17. Appendix: Example Codex Setup

```toml
model_provider = "bildy"
model = "bildy-auto"

[model_providers.bildy]
name = "bildy"
base_url = "http://localhost:8787/v1"
env_key = "BILDY_GATEWAY_KEY"
wire_api = "responses"
```

```bash
export BILDY_GATEWAY_KEY=local-dev-key
codex
```

---

## 18. Appendix: MVP Endpoint List

```txt
GET  /health
GET  /metrics
GET  /events/recent
POST /v1/messages
POST /v1/responses
POST /v1/chat/completions
```

---

## 19. Final Recommendation

Proceed with a lean local-first MVP.

The product should start as a thin protocol adapter and policy layer over `@stackbilt/llm-providers`, not as a new provider abstraction system. Its differentiation should be:

* Agent-client compatibility.
* Cost-aware routing.
* Safe model downgrade rules.
* Local observability.
* Cache discipline.
* Future governance telemetry.

This gives developers a practical, developer-useful gateway today and a strong foundation for governed multi-agent orchestration later.
