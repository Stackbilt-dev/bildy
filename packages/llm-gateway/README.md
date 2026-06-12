# @stackbilt/llm-gateway

Local-first LLM routing gateway for Claude Code, Codex, and OpenAI-compatible clients.

See the [root README](../../README.md) for user setup and configuration.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Service status + provider availability |
| GET | `/health?live=1` | none | + live provider probe |
| GET | `/providers` | key | Provider health snapshot |
| GET | `/providers?live=1` | key | Live provider health + circuit-breaker state |
| GET | `/metrics` | key | Aggregate counts, latency, cost estimate |
| GET | `/events/recent` | key | Last 100 request events |
| GET | `/shadow/stats` | key | Shadow routing summary + projected savings + catalog snapshot |
| POST | `/routes/inspect` | key | Route decision, model/provider selection, cache plan, capability report, degradations, warnings |
| POST | `/v1/messages` | key | Anthropic Messages API (Claude Code) |
| POST | `/v1/responses` | key | OpenAI Responses API (Codex) |
| POST | `/v1/chat/completions` | key | OpenAI Chat Completions API |
| POST | `/v1/context/compact` | key | Distill session transcript to structured facts |

Auth: `x-api-key: <STACKBILT_GATEWAY_KEY>` on all keyed endpoints.

## Architecture

- **`src/server.ts`** — Hono server, request classification, shadow-mode enforcement, routing
- **`src/policy/classify.ts`** — `classifyRequest()` assigns a `RouteClass` from signal heuristics
- **`src/policy/compatibility.ts`** — `selectCompatibleProvider()` walks the route candidates, preferring providers rated safe for the client, then experimentally-rated providers if `experimentalModels` is enabled
- **`src/policy/use-case.ts`** — `ROUTE_TO_USE_CASE` maps each `RouteClass` to a `ModelRecommendationUseCase` for catalog-driven model selection
- **`src/providers/llm-providers.ts`** — `GatewayProviderClient` wraps `@stackbilt/llm-providers`, applies cache hints, handles fallback tracking
- **`src/cache/sqlite-cache.ts`** — JSON file-backed response cache; `src/telemetry/sqlite-events.ts` — JSONL event sink
- **`src/config.ts`** — Config loading and merge (defaults → file → CLI flags)
- **`src/types.ts`** — Shared types: `RouteClass`, `LLMRequest`, `LLMResponse`, `GatewayConfig`, etc.
- **`src/adapters/`** — Protocol adapters: Anthropic Messages, OpenAI Responses, OpenAI Chat

## Providers

| Provider | Key env var | Route classes |
|---|---|---|
| anthropic | `ANTHROPIC_API_KEY` | tool_loop, long_context, fallback_safe |
| openai | `OPENAI_API_KEY` | tool_loop, fallback_safe |
| groq | `GROQ_API_KEY` | planning, code_draft, summary, long_context |
| cerebras | `CEREBRAS_API_KEY` | planning, code_draft, summary |
| nvidia | `NVIDIA_API_KEY` | planning, code_draft, long_context |
| cloudflare | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | any |

Model selection is catalog-driven via `rankModels(useCase, [provider])` and route inspection uses `getGatewayRoutePlan()` from `@stackbilt/llm-providers` — not hardcoded model names.

## Shadow mode

When `routing.shadowMode: true` (default), the gateway forces all traffic to Anthropic regardless of classification, and records `shadowRoute` + `projectedSavingsUsd` on each event. Flip to `false` to route live.

Per-route override via `routing.shadowRoutes: { summary: false }`.

## Config

Loads in order (later wins): defaults in `src/config.ts` → `gateway.config.json` / `stackbilt.gateway.json` → CLI flags.

## Development

```bash
npm run build          # tsc
npm test               # run test suite
npm run typecheck      # tsc --noEmit
```
