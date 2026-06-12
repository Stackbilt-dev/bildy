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
