import type { LLMMessage, LLMRequest, LLMTool } from "../types.js";

// Per-provider tool count ceilings.
// Anthropic/OpenAI: 128 (documented). Others: conservative estimates from
// empirical testing — lower limits fail with cryptic 400/422 errors.
const PROVIDER_TOOL_LIMITS: Record<string, number> = {
  anthropic: 128,
  openai: 128,
  groq: 128,
  cerebras: 64,
  cloudflare: 100,
  nvidia: 64,
};

export const DEFAULT_TOOL_LIMIT = 128;

export function getProviderToolLimit(provider: string): number {
  return PROVIDER_TOOL_LIMITS[provider.toLowerCase()] ?? DEFAULT_TOOL_LIMIT;
}

export interface ToolTrimResult {
  request: LLMRequest;
  trimmed: number;
  originalCount: number;
}

/**
 * Trim tool list to fit the provider's maximum.
 * Prioritizes tools that appear in recent conversation history (most recently
 * called first), then fills remaining slots in declaration order.
 * Returns the original request unchanged if no trimming is needed.
 */
export function trimToolsForProvider(
  request: LLMRequest,
  provider: string,
  configLimit?: number,
): ToolTrimResult {
  const tools = request.tools;
  const limit = configLimit ?? getProviderToolLimit(provider);

  if (!tools || tools.length <= limit) {
    return { request, trimmed: 0, originalCount: tools?.length ?? 0 };
  }

  const originalCount = tools.length;
  const recentlyUsed = extractRecentlyUsedToolNames(request.messages);
  const toolByName = new Map<string, LLMTool>(tools.map((t) => [t.function.name, t]));
  const kept = new Set<string>();
  const result: LLMTool[] = [];

  // First pass: recently-used tools in recency order (most recent first)
  for (const name of recentlyUsed) {
    if (result.length >= limit) break;
    const tool = toolByName.get(name);
    if (tool && !kept.has(name)) {
      result.push(tool);
      kept.add(name);
    }
  }

  // Second pass: fill remaining slots in declaration order
  for (const tool of tools) {
    if (result.length >= limit) break;
    const name = tool.function.name;
    if (!kept.has(name)) {
      result.push(tool);
      kept.add(name);
    }
  }

  return {
    request: { ...request, tools: result },
    trimmed: originalCount - result.length,
    originalCount,
  };
}

// ─── Schema sanitization ──────────────────────────────────────────────────────

// Providers outside Anthropic enforce strict JSON Schema compliance.
// Anthropic silently tolerates schemas with dangling $ref pointers (referencing
// $defs entries that don't exist). When we forward to CF/Groq/Cerebras those
// schemas cause hard 400s. Repair: resolve all $refs inline; fall back to
// { type: "object" } for dangling ones; strip $defs once resolved.

type JsonSchema = Record<string, unknown>;

function resolveRefs(schema: JsonSchema, defs: Record<string, JsonSchema>): JsonSchema {
  if (typeof schema !== "object" || schema === null) return schema;

  if ("$ref" in schema && typeof schema["$ref"] === "string") {
    const ref = schema["$ref"] as string;
    const defName = ref.startsWith("#/$defs/") ? ref.slice(8) : null;
    if (defName && defs[defName]) {
      // Inline the referenced definition (one level deep — no circular-ref guard needed
      // for MCP tool schemas which are always finite trees)
      return resolveRefs({ ...defs[defName] } as JsonSchema, defs);
    }
    // Dangling ref — replace with permissive object
    return { type: "object" };
  }

  const result: JsonSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$defs") continue; // strip after resolving
    if (Array.isArray(v)) {
      result[k] = v.map((item) =>
        typeof item === "object" && item !== null ? resolveRefs(item as JsonSchema, defs) : item,
      );
    } else if (typeof v === "object" && v !== null) {
      result[k] = resolveRefs(v as JsonSchema, defs);
    } else {
      result[k] = v;
    }
  }
  return result;
}

function sanitizeToolSchema(params: JsonSchema): JsonSchema {
  const defs = (params["$defs"] as Record<string, JsonSchema> | undefined) ?? {};
  return resolveRefs(params, defs);
}

export interface SanitizeResult {
  request: LLMRequest;
  repairedTools: number;
}

/**
 * Sanitize tool schemas for providers that enforce strict JSON Schema compliance.
 * Resolves $ref pointers, replaces dangling refs with { type: "object" }, strips $defs.
 * Safe to apply to all providers — Anthropic handles the cleaned schemas fine too.
 */
export function sanitizeToolSchemas(request: LLMRequest): SanitizeResult {
  if (!request.tools?.length) return { request, repairedTools: 0 };

  let repairedTools = 0;
  const tools = request.tools.map((tool) => {
    const params = tool.function?.parameters as JsonSchema | undefined;
    if (!params || typeof params !== "object") return tool;

    const hasDanglingRef = JSON.stringify(params).includes("$ref");
    if (!hasDanglingRef) return tool;

    repairedTools++;
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: sanitizeToolSchema(params),
      },
    };
  });

  return {
    request: { ...request, tools } as LLMRequest,
    repairedTools,
  };
}

// ─── Message extraction ───────────────────────────────────────────────────────

/**
 * Walk messages in reverse order collecting tool names from tool_use blocks.
 * Returns names in reverse-chronological order (most recently called first).
 */
function extractRecentlyUsedToolNames(messages: LLMMessage[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg.content || typeof msg.content === "string") continue;

    const blocks = msg.content as Array<{ type?: string; name?: string }>;
    for (const block of blocks) {
      if (block.type === "tool_use" && typeof block.name === "string" && !seen.has(block.name)) {
        result.push(block.name);
        seen.add(block.name);
      }
    }
  }

  return result;
}
