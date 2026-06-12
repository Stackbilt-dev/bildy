# bildy

> **Platform note:** Works on macOS and Linux. Windows: use WSL2 or submit a PR.
> Built for my own solodev workflow. If it breaks your shell, you keep both pieces.

One command that connects Claude Code (or Codex) to your own API keys and routes cheap turns to Cloudflare Workers AI, Groq, or Cerebras — keeping Claude in reserve for what only Claude can do.

```bash
bildy
```

Picks the tool. Starts the gateway if needed. Sets the environment. You get the shell back when the session exits.

---

## Why

Every Claude Code session has turns that don't need frontier intelligence — "summarize this file", "draft this function", "plan the next step". These turns cost the same as the ones where Claude actually has to reason across a tool loop.

bildy intercepts each request, classifies the cognitive load, and routes:

- **planning / code_draft / summary** → Cloudflare Workers AI, Groq, or Cerebras (fast, cheap)
- **tool_loop / long_context** → Anthropic (Claude for the hard parts)

**Shadow mode** is on by default. The gateway logs what *would* route while sending everything to Anthropic. After a real session, check `/shadow/stats` to see projected savings before you go live.

---

## Setup

### Recommended: manual env (bulletproof)

```bash
# 1. Clone and install
git clone https://github.com/Stackbilt-dev/bildy.git
cd bildy
npm install

# 2. Add at least one provider key
export GROQ_API_KEY=gsk_...          # free tier, fast — start here
export CEREBRAS_API_KEY=csk-...      # optional
export ANTHROPIC_API_KEY=sk-ant-...  # for fallback / tool-heavy turns

# 3. Point your AI tool at the gateway
export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_API_KEY=local-dev-key

# 4. Start the gateway + launch
npm run start &
claude
```

That's it. No shell magic, no PATH changes. If something breaks, the env var is the first thing to check.

### Alternative: interactive wizard

```bash
npm run install:global   # symlinks bildy + bildy-gw into ~/.local/bin
source ~/.bashrc         # or restart terminal
bildy init               # guided setup — local keys or remote URL
bildy                    # launch picker
```

The wizard writes keys to `.env` in this directory. If it fails to detect your shell profile, fall back to the manual path above and copy-paste the exports.

---

## Routing

| Route class | Signal | Default provider order |
|---|---|---|
| `tool_loop` | `tool_result` in message history | cloudflare, anthropic, openai, groq, cerebras |
| `long_context` | Estimated input >12k tokens | nvidia, groq, anthropic, openai, cloudflare |
| `planning` | Tools present, no tool loop yet | cloudflare, groq, cerebras, nvidia |
| `code_draft` | Code generation intent, no tool loop | cloudflare, groq, cerebras, nvidia |
| `summary` | Summarize / explain / extract | cloudflare, cerebras, groq |
| `fallback_safe` | Unknown | cloudflare, groq, cerebras |

Provider order matters — first compatible provider wins. The gateway picks the model from the provider's catalog by use case, not a hardcoded name.

### Extending routing

Route classes are the extension point. Map a class to your preferred provider order in `bildy.config.json`:

```json
{
  "routing": {
    "routes": {
      "planning":   ["groq", "cerebras"],
      "summary":    ["cerebras", "groq"]
    }
  }
}
```

Supported providers: `cloudflare`, `groq`, `cerebras`, `anthropic`, `openai`, `nvidia`. Do not add new providers by hardcoding them — if you need a provider not on this list, open an issue or map it to a route class in your local config. This keeps the routing surface predictable and the maintainer sane.

---

## Shadow mode

Shadow mode is on by default. Everything routes to Anthropic; bildy records what it would have done.

```bash
curl http://localhost:8787/shadow/stats -H "x-api-key: local-dev-key"
```

```json
{
  "shadowMode": true,
  "totalRequests": 47,
  "shadowedRequests": 31,
  "totalProjectedSavingsUsd": 0.043,
  "byRoute": {
    "planning": { "count": 18, "projectedSavingsUsd": 0.024 },
    "summary":  { "count": 13, "projectedSavingsUsd": 0.019 }
  }
}
```

When you trust the numbers, disable in `bildy.config.json`:

```json
{ "routing": { "shadowMode": false } }
```

Go live on one class at a time:

```json
{
  "routing": {
    "shadowMode": true,
    "shadowRoutes": { "summary": false }
  }
}
```

---

## Configuration

Config loads in this order (later wins):

1. Defaults in `packages/llm-gateway/src/config.ts`
2. `bildy.config.json` or `gateway.config.json` in the working directory
3. CLI flags (`--port`)

**Budget cap** — stop routing when the estimate exceeds a USD threshold (returns 429):

```json
{ "budget": { "usd": 10.00 } }
```

**Cloudflare AI Gateway** — route Workers AI calls through CF's gateway for cache + telemetry:

```bash
export CLOUDFLARE_ACCOUNT_ID=your-account-id
export CLOUDFLARE_API_TOKEN=your-api-token
export AI_GATEWAY_ID=your-gateway-id
```

**Anthropic direct proxy** — bypass provider routing entirely, forward raw to Anthropic:

```json
{ "routing": { "anthropicDirectProxy": true } }
```

---

## Remote gateway

If you have a gateway running elsewhere:

```bash
bildy init    # choose "Remote" and paste the URL
```

Or directly:

```bash
export BILDY_GATEWAY_URL=https://gateway.example.com
bildy
```

---

## Observability

All endpoints except `/health` require `x-api-key: <your-key>` (default: `local-dev-key`).

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Service status |
| GET | `/health?live=1` | + live provider probe |
| GET | `/providers?live=1` | Provider health + circuit-breaker state |
| GET | `/metrics` | Aggregate counts, latency, cost estimate |
| GET | `/events/recent` | Last 100 request events with routing metadata |
| GET | `/shadow/stats` | Shadow routing summary + projected savings |
| POST | `/routes/inspect` | Route decision, model/provider selection, capability report |
| POST | `/v1/messages` | Anthropic Messages API (Claude Code) |
| POST | `/v1/responses` | OpenAI Responses API (Codex) |
| POST | `/v1/chat/completions` | OpenAI Chat Completions API |
| POST | `/v1/context/compact` | Distill a session transcript to structured facts |

### Context compaction

Distills a Claude Code session transcript into structured facts using the cheapest configured summary-route provider.

```bash
curl -X POST http://localhost:8787/v1/context/compact \
  -H "Content-Type: application/json" \
  -H "x-api-key: local-dev-key" \
  -d '{"messages": [{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}'
```

Returns `durable_facts`, `decisions_made`, `files_changed`, `open_questions`, `next_actions`.

---

## Gateway commands

```bash
bildy                   # launch picker (Claude Code or Codex)
bildy init              # first-time setup wizard

bildy-gw up             # start gateway
bildy-gw down           # stop gateway
bildy-gw restart        # restart
bildy-gw status         # up/down + pid/log path
bildy-gw logs           # tail gateway logs
bildy-gw doctor         # validate cli, tools, env, and provider setup
bildy-gw init           # interactive key setup
bildy-gw init --quick   # minimal setup (one key to start)
bildy-gw shell-init     # emit helper functions: claude-gw / codex-gw
bildy-gw claude         # explicit gateway launch for Claude Code
bildy-gw codex          # explicit gateway launch for Codex
```

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `BILDY_GATEWAY_URL` | — | Remote gateway URL — skips local startup when set |
| `BILDY_GATEWAY_PORT` | `8787` | Local gateway port |
| `BILDY_GATEWAY_KEY` | `local-dev-key` | Gateway auth key |
| `BILDY_GATEWAY_CACHE_DIR` | `.bildy/gateway` | Cache dir when default path is not writable |
| `ANTHROPIC_API_KEY` | — | Anthropic (Claude) |
| `GROQ_API_KEY` | — | Groq (Llama, fast free tier) |
| `CEREBRAS_API_KEY` | — | Cerebras (fast inference) |
| `OPENAI_API_KEY` | — | OpenAI |
| `NVIDIA_API_KEY` | — | NVIDIA NIM |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | — | Cloudflare Workers AI |
| `AI_GATEWAY_ID` | — | Cloudflare AI Gateway ID for Workers AI cache + observability |

---

## Troubleshooting

**`bildy: command not found`**
```bash
npm run install:global
source ~/.bashrc
```

**No providers configured**
```bash
bildy init
bildy-gw doctor
```

**Port already in use**
```bash
BILDY_GATEWAY_PORT=9000 bildy
```

**Gateway stuck or unhealthy**
```bash
bildy-gw status
bildy-gw logs
bildy-gw restart
```

If `status` reports `status=up` with `pid_state=healthy_unmanaged`, the HTTP gateway is healthy but the PID file is missing or stale. `bildy-gw down` will stop the process bound to the configured port.

In restricted environments where repo-local cache writes fail:
```bash
BILDY_GATEWAY_CACHE_DIR=/tmp/bildy-cache bildy-gw up
```

---

## Contributing

PRs welcome for bugs and the five supported providers. A few things this project will not accept:

- **New provider integrations** (Ollama, LM Studio, DeepSeek, Gemini, etc.) — use Route Classes to map to an existing provider in your local config instead
- **Windows-native support** — WSL2 works fine; a native Windows port is out of scope
- **Protocol changes** that break the Claude Code or Codex wire format — the fixture test suite (`npm run test:integration`) must pass

For anything larger, open an issue first.

---

## License

MIT
