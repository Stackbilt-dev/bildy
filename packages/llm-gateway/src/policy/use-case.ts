import type { ModelRecommendationUseCase } from "@stackbilt/llm-providers";
import { RouteClass } from "../types.js";

export const ROUTE_TO_USE_CASE: Record<RouteClass, ModelRecommendationUseCase> = {
  tool_loop: "TOOL_CALLING",
  long_context: "LONG_CONTEXT",
  planning: "TOOL_CALLING",
  code_draft: "TOOL_CALLING",
  summary: "COST_EFFECTIVE",
  fallback_safe: "TOOL_CALLING",
};
