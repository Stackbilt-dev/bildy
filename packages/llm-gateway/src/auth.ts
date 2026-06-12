import type { Context, Next } from "hono";
import { GatewayConfig } from "./types.js";
import { AuthError } from "./errors.js";

function extractApiKey(c: Context): string | undefined {
  const headerKey = c.req.header("x-api-key") ?? c.req.header("X-API-Key");
  if (headerKey) return headerKey;

  const auth = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!auth) return undefined;
  if (!auth.toLowerCase().startsWith("bearer ")) return undefined;

  return auth.slice(7).trim();
}

export function authMiddleware(config: GatewayConfig) {
  return async (c: Context, next: Next) => {
    if (config.auth.mode === "none") {
      await next();
      return;
    }

    const apiKey = extractApiKey(c);
    if (!apiKey) {
      throw new AuthError();
    }
    // If specific keys are configured, validate against them.
    // Empty keys array = accept any non-empty token (allows Claude Code subscription sessions).
    if (config.auth.keys.length > 0 && !config.auth.keys.includes(apiKey)) {
      throw new AuthError();
    }

    await next();
  };
}
