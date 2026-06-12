import type {
  CanonicalDegradation,
  CanonicalFallbackHop,
  CanonicalLLMRequest,
  CanonicalMessage,
  CanonicalRoutingMetadata,
  CanonicalTool,
  ToolCall,
} from "@stackbilt/llm-providers";

export type RouteClass =
  | "tool_loop"     // has tool_result in messages — mid-execution, needs reliable tool calling
  | "long_context"  // large context — only frontier models handle reliably
  | "planning"      // thinking/reasoning turn, tools present but not in loop
  | "code_draft"    // code generation intent, no tool loop
  | "summary"       // summarize/extract/explain — cheapest cognitive load
  | "fallback_safe"; // unknown — route to Anthropic

export type ClientProtocol =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-chat";

export type ClientName = "claude-code" | "codex" | "unknown";

export interface GatewayRequestContext {
  requestId: string;
  protocol: ClientProtocol;
  client: ClientName;
  startTime: number;
  requestPath: string;
  sessionId?: string;
  repoPath?: string;
  evalRunId?: string;
}

export type LLMMessage = CanonicalMessage;

export type LLMTool = CanonicalTool;

export type LLMRequest = CanonicalLLMRequest;

export interface LLMResponse {
  id: string;
  provider: string;
  model: string;
  outputText: string;
  toolCalls?: ToolCall[];
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
  fallbackChain: string[];
  routing?: CanonicalRoutingMetadata;
  capabilityDegradations?: CanonicalDegradation[];
  routeClass: RouteClass;
  cacheHit: boolean;
  raw?: unknown;
}

export interface ModelCompatibility {
  provider: string;
  model: string;
  streaming: boolean;
  tools: boolean;
  vision?: boolean;
  claudeCodeSafe: boolean | "experimental";
  codexSafe: boolean | "experimental";
  notes?: string;
}

export interface GatewayRequestEvent {
  id: string;
  timestamp: string;
  client: ClientName;
  protocol: ClientProtocol;
  sessionId?: string;
  repoPath?: string;
  evalRunId?: string;
  routeClass: RouteClass;
  requestedModel?: string;
  selectedProvider?: string;
  selectedModel?: string;
  fallbackChain?: string[];
  routingFallbackChain?: CanonicalFallbackHop[];
  capabilityDegradations?: CanonicalDegradation[];
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costEstimateUsd?: number;
  latencyMs: number;
  cacheHit: boolean;
  status: "success" | "error" | "fallback_success";
  errorClass?: string;
  compatibilityFailure?: GatewayCompatibilityFailure;
  // Shadow routing fields — populated when shadowMode is on
  shadowRoute?: RouteClass;
  shadowProvider?: string;
  shadowConfidence?: "high" | "medium" | "low";
  projectedSavingsUsd?: number;
}

export type GatewayCompatibilityFailure =
  | "malformed_tool_call_json"
  | "empty_successful_output"
  | "unknown_model_retry"
  | "provider_circuit_open"
  | "all_providers_failed";

export interface RoutingConfig {
  default: "auto" | string;
  experimentalModels: boolean;
  shadowMode: boolean;
  shadowRoutes?: Partial<Record<RouteClass, boolean>>;
  anthropicDirectProxy?: boolean;
  routes: Record<RouteClass, string[]>;
}

export interface GatewayConfig {
  port: number;
  auth: {
    mode: "local-key" | "none";
    keys: string[];
  };
  routing: RoutingConfig;
  budget?: {
    usd: number;
  };
  cache: {
    enabled: boolean;
    storage: "sqlite";
    path: string;
    responseCache: boolean;
    responseTtlMs: number;
    maxEntries: number;
  };
  telemetry: {
    enabled: boolean;
    storePrompts: boolean;
    redactSecrets: boolean;
    path: string;
  };
}

export interface AdapterResult<T> {
  data: T;
  context: GatewayRequestContext;
}
