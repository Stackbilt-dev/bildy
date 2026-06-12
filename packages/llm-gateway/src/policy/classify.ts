import { LLMRequest, RouteClass } from "../types.js";

const SUMMARY_SIGNALS = [
  "summarize", "summary", "explain", "what does", "describe",
  "what is this", "extract", "what are", "tell me about", "overview of",
];

const PLANNING_SIGNALS = [
  "how should", "what approach", "how would", "best way to",
  "plan", "strategy", "architecture", "design", "should we",
  "what's the best", "how do i", "how can i",
];

const CODE_SIGNALS = [
  "write a", "write the", "create a", "generate", "draft",
  "implement a", "implement the", "function that", "class that",
  "component that", "add a", "build a",
];

// 1 token ≈ 4 chars (rough). Exclude tool schemas — Claude Code sends 50+ tools
// on every request, inflating the estimate and falsely triggering long_context.
// We strip tools before forwarding to cheap providers anyway.
function estimateInputTokens(request: LLMRequest): number {
  const text = [
    request.system ?? "",
    ...request.messages.map((m) => m.content),
  ].join("\n");
  return Math.ceil(text.length / 4);
}

export function classifyRequest(request: LLMRequest): RouteClass {
  // Tool-loop: Claude is mid-execution — tool_result messages in history
  const hasToolResult = request.messages.some((m) => (m.toolResults?.length ?? 0) > 0);
  if (hasToolResult) return "tool_loop";

  // Large context: actual input is large. Do NOT use maxTokens — extended-thinking
  // requests always set high maxTokens even for short inputs, which would misclassify
  // every thinking-enabled request as long_context and send 50+ tools to Groq.
  const estimatedTokens = estimateInputTokens(request);
  if (estimatedTokens > 12_000) return "long_context";

  const userText = request.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.toLowerCase())
    .join("\n");

  if (SUMMARY_SIGNALS.some((s) => userText.includes(s))) return "summary";
  if (CODE_SIGNALS.some((s) => userText.includes(s))) return "code_draft";
  if (PLANNING_SIGNALS.some((s) => userText.includes(s))) return "planning";

  // Has tool schemas but not in a loop and no stronger signal → planning turn
  if (request.tools?.length) return "planning";

  return "fallback_safe";
}

export interface ShadowDecision {
  wouldRoute: RouteClass;
  wouldProvider: string;
  confidence: "high" | "medium" | "low";
  reason: string;
  projectedSavingsUsd: number;
}

export const ANTHROPIC_INPUT_COST_PER_TOKEN = 0.000003;  // Sonnet 4 — $3 / 1M tokens
export const ANTHROPIC_OUTPUT_COST_PER_TOKEN = 0.000015; // Sonnet 4 — $15 / 1M tokens
const CHEAP_COST_PER_TOKEN = 0.0000001;  // Cerebras / Groq approximate

const CHEAP_ROUTE_CLASSES = new Set<RouteClass>(["summary", "code_draft", "planning"]);

const CONFIDENCE: Record<RouteClass, "high" | "medium" | "low"> = {
  tool_loop: "high",
  long_context: "high",
  summary: "high",
  planning: "medium",
  code_draft: "medium",
  fallback_safe: "high",
};

export function computeShadowDecision(
  request: LLMRequest,
  wouldRoute: RouteClass,
  wouldProvider: string,
): ShadowDecision {
  const estimatedInput = estimateInputTokens(request);
  const estimatedOutput = Math.min(request.sampling?.maxTokens ?? 500, 800);

  let projectedSavingsUsd = 0;
  if (CHEAP_ROUTE_CLASSES.has(wouldRoute)) {
    const anthropicCost = estimatedInput * ANTHROPIC_INPUT_COST_PER_TOKEN + estimatedOutput * ANTHROPIC_OUTPUT_COST_PER_TOKEN;
    const cheapCost = (estimatedInput + estimatedOutput) * CHEAP_COST_PER_TOKEN;
    projectedSavingsUsd = Math.max(0, Math.round((anthropicCost - cheapCost) * 100000) / 100000);
  }

  return {
    wouldRoute,
    wouldProvider,
    confidence: CONFIDENCE[wouldRoute],
    reason: wouldRoute,
    projectedSavingsUsd,
  };
}
