import type { GatewayCompatibilityFailure, LLMResponse, RouteClass } from "../types.js";

export function classifyGatewayFailure(input: {
  errorClass?: string;
  message?: string;
}): GatewayCompatibilityFailure | undefined {
  const text = `${input.errorClass ?? ""} ${input.message ?? ""}`.toLowerCase();

  if (/failed to parse tool call arguments as json|tool call arguments.*json/.test(text)) {
    return "malformed_tool_call_json";
  }
  if (/model ['"]?unknown['"]? not found|model.*unknown/.test(text)) {
    return "unknown_model_retry";
  }
  if (/circuit breaker rejected|circuit[_ -]?breaker[_ -]?open/.test(text)) {
    return "provider_circuit_open";
  }
  if (/all providers failed/.test(text)) {
    return "all_providers_failed";
  }

  return undefined;
}

export function classifyGatewayResponse(input: {
  response: LLMResponse;
  routeClass: RouteClass;
}): GatewayCompatibilityFailure | undefined {
  const hasText = input.response.outputText.trim().length > 0;
  const hasToolCalls = Boolean(input.response.toolCalls?.length);
  if (hasText || hasToolCalls) return undefined;

  if (input.routeClass === "code_draft" || input.routeClass === "planning" || input.routeClass === "summary") {
    return "empty_successful_output";
  }

  return undefined;
}
