import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { GatewayConfig } from "./types.js";

const defaultConfig: GatewayConfig = {
  port: 8787,
  auth: {
    mode: "local-key",
    keys: [], // empty = accept any non-empty auth token; add specific keys to lock down
  },
  routing: {
    default: "auto",
    experimentalModels: false,
    shadowMode: true, // log would-route but always route to Anthropic until validated
    anthropicDirectProxy: false,
    routes: {
      tool_loop: ["cloudflare", "anthropic", "openai", "groq", "cerebras"],
      long_context: ["nvidia", "groq", "anthropic", "openai", "cloudflare"],
      planning: ["cloudflare", "groq", "cerebras", "nvidia"],
      code_draft: ["cloudflare", "groq", "cerebras", "nvidia"],
      summary: ["cloudflare", "cerebras", "groq"],
      fallback_safe: ["cloudflare", "groq", "cerebras"],
    },
  },
  cache: {
    enabled: true,
    storage: "sqlite",
    path: ".bildy/gateway/cache.sqlite",
    responseCache: false,
    responseTtlMs: 600000,
    maxEntries: 1000,
  },
  telemetry: {
    enabled: true,
    storePrompts: false,
    redactSecrets: true,
    path: ".bildy/gateway/events.sqlite",
  },
};

function loadConfigFile(cwd: string): Partial<GatewayConfig> {
  const candidates = ["bildy.config.json", "gateway.config.json", "stackbilt.gateway.json"];

  for (const file of candidates) {
    const fullPath = path.join(cwd, file);
    if (!existsSync(fullPath)) continue;
    const text = readFileSync(fullPath, "utf8");
    return JSON.parse(text) as Partial<GatewayConfig>;
  }

  return {};
}

function cachePathFromEnv(): string | undefined {
  const cacheDir = process.env.BILDY_GATEWAY_CACHE_DIR?.trim();
  if (!cacheDir) return undefined;
  return path.join(cacheDir, "cache.sqlite");
}

// Zero-dollar mode: disable shadow, pin cheap routes to CF Workers AI free tier.
// Activated via BILDY_FREE_MODE=1 env var or options.freeMode.
const FREE_MODE_ROUTES: GatewayConfig["routing"]["routes"] = {
  tool_loop:    ["anthropic", "openai", "groq"],       // keep reliable — never send tool loops to CF alone
  long_context: ["groq", "nvidia", "anthropic"],       // groq has 128k, cheap
  planning:     ["cloudflare"],
  code_draft:   ["cloudflare"],
  summary:      ["cloudflare"],
  fallback_safe:["cloudflare", "groq"],
};

export function resolveConfig(options?: { port?: number; cwd?: string; freeMode?: boolean }): GatewayConfig {
  const cwd = options?.cwd ?? process.cwd();
  const fileConfig = loadConfigFile(cwd);
  const envKey = process.env.BILDY_GATEWAY_KEY;
  const envCachePath = cachePathFromEnv();

  const merged: GatewayConfig = {
    ...defaultConfig,
    ...fileConfig,
    budget: fileConfig.budget ?? defaultConfig.budget,
    auth: {
      ...defaultConfig.auth,
      ...fileConfig.auth,
      // Only use explicit keys from config file. BILDY_GATEWAY_KEY is the key
      // bildy uses to communicate but does not restrict access (gateway is localhost-only).
      // Subscription-authenticated clients (Claude Code Max) send OAuth tokens that
      // won't match any static key — empty keys array accepts any non-empty token.
      keys: fileConfig.auth?.keys ?? defaultConfig.auth.keys,
    },
    routing: {
      ...defaultConfig.routing,
      ...fileConfig.routing,
      routes: {
        ...defaultConfig.routing.routes,
        ...fileConfig.routing?.routes,
      },
      shadowMode: fileConfig.routing?.shadowMode ?? defaultConfig.routing.shadowMode,
      shadowRoutes: { ...defaultConfig.routing.shadowRoutes, ...fileConfig.routing?.shadowRoutes },
      anthropicDirectProxy: fileConfig.routing?.anthropicDirectProxy ?? defaultConfig.routing.anthropicDirectProxy,
      maxTools: fileConfig.routing?.maxTools ?? defaultConfig.routing.maxTools,
    },
    cache: {
      ...defaultConfig.cache,
      ...fileConfig.cache,
      ...(envCachePath ? { path: envCachePath } : {}),
    },
    telemetry: {
      ...defaultConfig.telemetry,
      ...fileConfig.telemetry,
    },
    port: options?.port ?? fileConfig.port ?? defaultConfig.port,
  };

  const freeMode = options?.freeMode ?? process.env.BILDY_FREE_MODE === "1";
  const shadowOnly = process.env.BILDY_SHADOW_ONLY === "1";

  if (freeMode && !shadowOnly) {
    // Legacy proxy mode: reroute cheap classes to CF Workers AI.
    // Disabled when BILDY_SHADOW_ONLY=1 (delegate mode).
    merged.routing.shadowMode = false;
    merged.routing.shadowRoutes = {};
    merged.routing.routes = { ...merged.routing.routes, ...FREE_MODE_ROUTES };
  }
  // In delegate mode (freeMode + shadowOnly), keep shadowMode=true — gateway
  // observes and logs shadow decisions but never reroutes traffic.

  return merged;
}
