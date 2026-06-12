import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getGatewayRoutePlan, type ProviderName } from "@stackbilt/llm-providers";
import { authMiddleware } from "./auth.js";
import { resolveConfig } from "./config.js";
import { GatewayError, ValidationError } from "./errors.js";
import { anthropicMessagesAdapter } from "./adapters/anthropic-messages.js";
import { openAIChatCompletionsAdapter } from "./adapters/openai-chat.js";
import { openAIResponsesAdapter } from "./adapters/openai-responses.js";
import { buildResponseCacheKey } from "./cache/keys.js";
import { FileCache } from "./cache/sqlite-cache.js";
import { ANTHROPIC_INPUT_COST_PER_TOKEN, ANTHROPIC_OUTPUT_COST_PER_TOKEN, classifyRequest, computeShadowDecision, type ShadowDecision } from "./policy/classify.js";
import { trimToolsForProvider } from "./policy/tool-trim.js";
import { defaultCompatibilityRegistry, selectCompatibleProvider } from "./policy/compatibility.js";
import {
  buildGatewayModelAliases,
  configuredRouteProviders,
  resolveModelAlias,
  type GatewayModelAlias,
  type ModelResolution,
} from "./policy/model-aliases.js";
import { routeCandidates } from "./policy/routes.js";
import { ROUTE_TO_USE_CASE } from "./policy/use-case.js";
import { createProviderClient, getModelCatalog, getProviderClient, rankModelsForRoutes, type ProviderClient } from "./providers/llm-providers.js";
import { EventStore } from "./telemetry/events.js";
import { classifyGatewayFailure, classifyGatewayResponse } from "./telemetry/failures.js";
import { buildMetrics } from "./telemetry/metrics.js";
import { JsonlEventSink } from "./telemetry/sqlite-events.js";
import {
  ClientName,
  GatewayConfig,
  GatewayRequestContext,
  GatewayRequestEvent,
  LLMRequest,
  LLMResponse,
  RouteClass,
} from "./types.js";

interface RouteOutput {
  response: LLMResponse;
  textStream: ReadableStream<string>;
  routeClass: RouteClass;
  shadow?: ShadowDecision;
  modelResolution?: ModelResolution;
}

interface ServerDependencies {
  providerClient?: ProviderClient;
}

interface UpstreamAnthropicAuth {
  apiKey?: string;
  bearerToken?: string;
}

const PROVIDER_NAMES = new Set<ProviderName>(["openai", "anthropic", "cloudflare", "cerebras", "groq", "nvidia"]);

function asJsonError(message: string, type = "invalid_request_error") {
  return {
    error: {
      type,
      message,
    },
  };
}

function toProviderNames(providers: string[]): ProviderName[] {
  return providers.filter((provider): provider is ProviderName => PROVIDER_NAMES.has(provider as ProviderName));
}

function sanitizeResponseForClient(response: LLMResponse, request: LLMRequest): LLMResponse {
  if (!response.toolCalls?.length) return response;
  const allowedToolNames = new Set(request.tools?.map((tool) => tool.function.name) ?? []);
  if (allowedToolNames.size === 0) {
    return {
      ...response,
      outputText: response.outputText || "Provider returned tool calls, but this request did not expose callable tools.",
      toolCalls: undefined,
    };
  }

  const validToolCalls = response.toolCalls.filter((toolCall) => allowedToolNames.has(toolCall.function.name));
  if (validToolCalls.length === response.toolCalls.length) return response;

  const rejectedNames = response.toolCalls
    .filter((toolCall) => !allowedToolNames.has(toolCall.function.name))
    .map((toolCall) => toolCall.function.name);

  return {
    ...response,
    outputText: response.outputText || `Provider returned unsupported tool call(s): ${rejectedNames.join(", ")}.`,
    toolCalls: validToolCalls.length ? validToolCalls : undefined,
  };
}

async function routeViaProviders(
  request: LLMRequest,
  routeClass: RouteClass,
  provider: string,
  requestId: string,
  providerClient: ProviderClient,
  modelOverride?: string,
): Promise<RouteOutput> {
  const result = await providerClient.route(request, routeClass, provider, requestId, modelOverride);
  return { ...result, response: sanitizeResponseForClient(result.response, request), routeClass };
}

function extractBearerToken(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  if (!headerValue.toLowerCase().startsWith("bearer ")) return undefined;
  const token = headerValue.slice(7).trim();
  return token || undefined;
}

// Direct Anthropic proxy: forward the raw request body verbatim so tool_use blocks,
// thinking params, and anthropic-beta features are preserved end-to-end.
async function directAnthropicProxy(
  rawBody: string,
  requestHeaders: { header: (k: string) => string | undefined },
  context: GatewayRequestContext,
  auth: UpstreamAnthropicAuth,
  events: EventStore,
  eventSink: JsonlEventSink,
  config: GatewayConfig,
): Promise<Response> {
  const fwdHeaders: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": requestHeaders.header("anthropic-version") ?? "2023-06-01",
  };
  if (auth.bearerToken) {
    fwdHeaders.authorization = `Bearer ${auth.bearerToken}`;
  } else if (auth.apiKey) {
    fwdHeaders["x-api-key"] = auth.apiKey;
  } else {
    throw new ValidationError("Missing upstream Anthropic credentials");
  }
  const beta = requestHeaders.header("anthropic-beta");
  if (beta) fwdHeaders["anthropic-beta"] = beta;

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: fwdHeaders,
    body: rawBody,
  });

  try {
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    const llmReq = anthropicMessagesAdapter.toLLMRequest(body as never, context);
    const routeClass = classifyRequest(llmReq);
    const shadow = config.routing.shadowMode
      ? computeShadowDecision(llmReq, routeClass, selectCompatibleProvider(routeCandidates(routeClass, config), llmReq, context.client, config.routing.experimentalModels))
      : undefined;
    const event: GatewayRequestEvent = {
      id: context.requestId,
      timestamp: new Date().toISOString(),
      client: context.client,
      protocol: context.protocol,
      evalRunId: context.evalRunId,
      routeClass,
      selectedProvider: "anthropic",
      selectedModel: String(body.model ?? "unknown"),
      latencyMs: Date.now() - context.startTime,
      cacheHit: false,
      status: upstream.ok ? "success" : "error",
      costEstimateUsd: 0,
      shadowRoute: shadow?.wouldRoute,
      shadowProvider: shadow?.wouldProvider,
      shadowConfidence: shadow?.confidence,
      projectedSavingsUsd: shadow?.projectedSavingsUsd,
    };
    events.append(event);
    eventSink.write(event);
    console.log(`[gateway] ${context.requestId} → ${routeClass} anthropic/direct upstream=${upstream.status}`);
  } catch { /* best-effort telemetry */ }

  const contentType = upstream.headers.get("content-type") ?? "application/json";
  const isStream = contentType.includes("event-stream");
  const respHeaders: Record<string, string> = { "content-type": contentType };
  if (isStream) { respHeaders["cache-control"] = "no-cache"; respHeaders["connection"] = "keep-alive"; }
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

function estimateCost(event: Pick<GatewayRequestEvent, "inputTokens" | "outputTokens">): number {
  // Uses Anthropic Sonnet 4 pricing as a consistent baseline. Requests routed to
  // cheaper providers will show higher estimates than actual cost — intentional so
  // shadow-mode savings comparisons use the same price anchor.
  const inCost = (event.inputTokens ?? 0) * ANTHROPIC_INPUT_COST_PER_TOKEN;
  const outCost = (event.outputTokens ?? 0) * ANTHROPIC_OUTPUT_COST_PER_TOKEN;
  return Math.round((inCost + outCost) * 100000) / 100000;
}

function normalizeEvalRunId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 128);
}

function evalRunIdFromRequest(req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined }): string | undefined {
  return normalizeEvalRunId(req.header("x-eval-run-id") ?? req.query("evalRunId"));
}

function buildContext(pathname: string, evalRunId?: string): GatewayRequestContext {
  let protocol: GatewayRequestContext["protocol"] = "openai-responses";
  let client: GatewayRequestContext["client"] = "unknown";

  if (pathname === "/v1/messages") {
    protocol = "anthropic-messages";
    client = "claude-code";
  } else if (pathname === "/v1/responses") {
    protocol = "openai-responses";
    client = "codex";
  } else if (pathname === "/v1/chat/completions") {
    protocol = "openai-chat";
    client = "codex";
  }

  return {
    requestId: crypto.randomUUID(),
    protocol,
    client,
    startTime: Date.now(),
    requestPath: pathname,
    evalRunId,
  };
}

function buildGatewayEvent(params: {
  context: GatewayRequestContext;
  routeClass: RouteClass;
  response: LLMResponse;
  status: GatewayRequestEvent["status"];
  errorClass?: string;
  shadow?: ShadowDecision;
}): GatewayRequestEvent {
  const latencyMs = Date.now() - params.context.startTime;

  const event: GatewayRequestEvent = {
    id: params.context.requestId,
    timestamp: new Date().toISOString(),
    client: params.context.client,
    protocol: params.context.protocol,
    sessionId: params.context.sessionId,
    repoPath: params.context.repoPath,
    evalRunId: params.context.evalRunId,
    routeClass: params.routeClass,
    requestedModel: params.response.model,
    selectedProvider: params.response.provider,
    selectedModel: params.response.model,
    fallbackChain: params.response.fallbackChain,
    routingFallbackChain: params.response.routing?.fallbackChain,
    capabilityDegradations: params.response.capabilityDegradations ?? params.response.routing?.degradations,
    inputTokens: params.response.usage?.inputTokens,
    outputTokens: params.response.usage?.outputTokens,
    cachedInputTokens: params.response.usage?.cachedInputTokens,
    costEstimateUsd: 0,
    latencyMs,
    cacheHit: params.response.cacheHit,
    status: params.status,
    errorClass: params.errorClass,
    compatibilityFailure: classifyGatewayResponse({ response: params.response, routeClass: params.routeClass }),
    shadowRoute: params.shadow?.wouldRoute,
    shadowProvider: params.shadow?.wouldProvider,
    shadowConfidence: params.shadow?.confidence,
    projectedSavingsUsd: params.shadow?.projectedSavingsUsd,
  };

  event.costEstimateUsd = estimateCost(event);
  return event;
}

function buildCapabilityDegradations(params: {
  activeRoute: RouteClass;
  stripTools: boolean;
  request: LLMRequest;
}) {
  if (!params.stripTools || !(params.request.tools?.length)) return undefined;

  return [
    {
      capability: "tool_calling",
      action: "stripped" as const,
      reason: params.activeRoute === "tool_loop"
        ? "No premium tool-safe provider is configured for an in-progress tool loop."
        : "Route class selected a low-cost text path that does not preserve caller tool schemas.",
    },
  ];
}

function shouldStripTools(params: {
  activeRoute: RouteClass;
  context: GatewayRequestContext;
  request: LLMRequest;
  candidates: string[];
}) {
  if (!(params.request.tools?.length)) return false;

  // OpenAI Responses clients such as Codex can consume function_call items, and
  // @stackbilt/llm-providers normalizes Groq tool-call-only responses as of 1.13.1.
  if (params.context.protocol === "openai-responses") return false;

  const cheapRoutes = new Set<RouteClass>(["planning", "code_draft", "summary"]);
  if (!cheapRoutes.has(params.activeRoute) && params.activeRoute !== "tool_loop") return false;

  return !params.candidates.some((candidate) => {
    const entry = defaultCompatibilityRegistry.find((model) => model.provider === candidate);
    return Boolean(entry?.tools);
  });
}

function requestFromInspectionInput(input: Record<string, unknown>, context: GatewayRequestContext): LLMRequest {
  const protocol = input.protocol;
  const body = (input.body ?? input.request ?? input) as Record<string, unknown>;

  if (protocol === "anthropic-messages") {
    return anthropicMessagesAdapter.toLLMRequest(body as never, { ...context, protocol });
  }
  if (protocol === "openai-chat") {
    return openAIChatCompletionsAdapter.toLLMRequest(body as never, { ...context, protocol });
  }
  if (protocol === "openai-responses") {
    return openAIResponsesAdapter.toLLMRequest(body as never, { ...context, protocol });
  }

  if (!Array.isArray((body as Partial<LLMRequest>).messages)) {
    throw new ValidationError("Route inspection requires a canonical request or { protocol, body }");
  }

  return body as unknown as LLMRequest;
}

async function loadGatewayModelAliases(params: {
  config: GatewayConfig;
  providerClient: ProviderClient;
}): Promise<GatewayModelAlias[]> {
  const providerSnapshot = await params.providerClient.getHealthSnapshot({ live: false });
  const providers = providerSnapshot.availableProviders.length
    ? providerSnapshot.availableProviders
    : configuredRouteProviders(params.config);
  const catalog = await getModelCatalog();

  return buildGatewayModelAliases({
    config: params.config,
    providers,
    catalog: Array.from(catalog),
  });
}

function openAIModelPayload(alias: GatewayModelAlias) {
  return {
    id: alias.id,
    object: "model",
    created: alias.created,
    owned_by: alias.owned_by,
  };
}

function buildErrorEvent(params: {
  context: GatewayRequestContext;
  errorClass: string;
  errorMessage?: string;
  routeClass?: RouteClass;
}): GatewayRequestEvent {
  return {
    id: params.context.requestId,
    timestamp: new Date().toISOString(),
    client: params.context.client,
    protocol: params.context.protocol,
    sessionId: params.context.sessionId,
    repoPath: params.context.repoPath,
    evalRunId: params.context.evalRunId,
    routeClass: params.routeClass ?? "fallback_safe",
    cacheHit: false,
    latencyMs: Date.now() - params.context.startTime,
    status: "error",
    errorClass: params.errorClass,
    compatibilityFailure: classifyGatewayFailure({
      errorClass: params.errorClass,
      message: params.errorMessage,
    }),
    costEstimateUsd: 0,
  };
}

async function parseRequestBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
}

async function executeRequest(params: {
  config: GatewayConfig;
  context: GatewayRequestContext;
  request: LLMRequest;
  cache: FileCache;
  providerClient: ProviderClient;
}): Promise<RouteOutput> {
  const aliases = await loadGatewayModelAliases({
    config: params.config,
    providerClient: params.providerClient,
  });
  const modelResolution = resolveModelAlias({
    requestedModel: params.request.model,
    aliases,
  });
  const activeRoute: RouteClass = modelResolution.routeClass ?? classifyRequest(params.request);

  // Per-route override takes precedence over the global shadowMode flag.
  const shadowMode = params.config.routing.shadowRoutes?.[activeRoute]
    ?? params.config.routing.shadowMode;

  const candidates = routeCandidates(activeRoute, params.config);

  const stripTools = shouldStripTools({ activeRoute, context: params.context, request: params.request, candidates });
  const capabilityDegradations = buildCapabilityDegradations({
    activeRoute,
    stripTools,
    request: params.request,
  });
  const requestToForward: LLMRequest = {
    ...params.request,
    ...(stripTools ? { tools: undefined, toolMode: undefined } : {}),
    model: modelResolution.kind === "provider_alias" ? modelResolution.model : undefined,
    workload: ROUTE_TO_USE_CASE[activeRoute],
    requirements: {
      ...params.request.requirements,
      ...(stripTools ? { toolCalling: false } : {}),
    },
    metadata: {
      ...params.request.metadata,
      custom: {
        ...(params.request.metadata?.custom ?? {}),
        modelResolution,
        ...(capabilityDegradations ? { capabilityDegradations } : {}),
      },
    },
  };

  const classifiedProvider = selectCompatibleProvider(
    candidates,
    requestToForward,
    params.context.client,
    params.config.routing.experimentalModels,
  );

  const resolvedProvider = modelResolution.provider ?? classifiedProvider;
  // Shadow mode: always route to Anthropic; log what non-shadow routing WOULD have done.
  const provider = shadowMode ? "anthropic" : resolvedProvider;
  const modelOverride = shadowMode ? undefined : modelResolution.model;

  // Trim tool list to the resolved provider's maximum before forwarding.
  // Prioritizes recently-used tools from conversation history so the most
  // relevant tools survive the cut.
  const toolTrim = trimToolsForProvider(requestToForward, provider, params.config.routing.maxTools);
  const requestToSend = toolTrim.trimmed > 0 ? toolTrim.request : requestToForward;
  if (toolTrim.trimmed > 0) {
    console.log(`[gateway] ${params.context.requestId} tool-trim: ${toolTrim.originalCount} → ${toolTrim.originalCount - toolTrim.trimmed} tools (provider=${provider} limit=${toolTrim.originalCount - toolTrim.trimmed})`);
  }

  const safeResponseCacheRoute = activeRoute === "summary";
  const shouldCheckResponseCache =
    params.config.cache.enabled
    && params.config.cache.responseCache
    && safeResponseCacheRoute
    && !requestToSend.stream
    && (requestToSend.sampling?.temperature ?? 0) <= 0.2;

  if (shouldCheckResponseCache) {
    const responseKey = buildResponseCacheKey(requestToSend);
    const cachedPayload = params.cache.getResponse(responseKey);
    if (cachedPayload) {
      const cachedResponse = JSON.parse(cachedPayload) as LLMResponse;
      return {
        response: {
          ...cachedResponse,
          id: params.context.requestId,
          cacheHit: true,
        },
        textStream: new ReadableStream<string>({
          start(controller) {
            controller.enqueue(cachedResponse.outputText);
            controller.close();
          },
        }),
        routeClass: activeRoute,
      };
    }
  }

  let shadow: ShadowDecision | undefined;
  if (shadowMode) {
    shadow = computeShadowDecision(requestToSend, activeRoute, resolvedProvider);
  }

  const result = await routeViaProviders(
    requestToSend,
    activeRoute,
    provider,
    params.context.requestId,
    params.providerClient,
    modelOverride,
  );

  if (shouldCheckResponseCache && result.response.outputText) {
    const responseKey = buildResponseCacheKey(requestToSend);
    params.cache.setResponse(responseKey, JSON.stringify(result.response));
  }

  return { ...result, routeClass: activeRoute, shadow, modelResolution };
}

class GatewayQuotaHook {
  constructor(private readonly store: EventStore, private readonly budgetUsd: number) {}

  async check(_input: unknown): Promise<{ allowed: boolean; remainingBudget: number; reason?: string }> {
    const spent = this.store.all().reduce((sum, e) => sum + (e.costEstimateUsd ?? 0), 0);
    const remaining = Math.max(0, this.budgetUsd - spent);
    return {
      allowed: remaining > 0,
      remainingBudget: remaining,
      ...(remaining === 0 ? { reason: `budget cap $${this.budgetUsd} reached (spent $${spent.toFixed(5)} this session)` } : {}),
    };
  }

  async record(_input: unknown): Promise<void> {
    // Gateway event flow records cost — no-op here.
  }
}

export function createServer(config = resolveConfig(), dependencies: ServerDependencies = {}) {
  const app = new Hono();
  const events = new EventStore();
  const cache = new FileCache(config.cache.path, {
    ttlMs: config.cache.responseTtlMs,
    maxEntries: config.cache.maxEntries,
  });
  const eventSink = new JsonlEventSink(config.telemetry.path);
  for (const e of eventSink.load()) events.append(e);
  const quotaHook = config.budget?.usd ? new GatewayQuotaHook(events, config.budget.usd) : undefined;
  const activeProviderClient: ProviderClient = dependencies.providerClient
    ?? (quotaHook ? createProviderClient({ quotaHook }) : getProviderClient());
  const getActiveProviderClient = () => activeProviderClient;

  app.onError((error, c) => {
    if (error instanceof GatewayError) {
      console.error(`[gateway] ${c.req.method} ${c.req.path} → ${error.statusCode} ${error.code}: ${error.message}`);
      return c.json(asJsonError(error.message, error.code), {
        status: error.statusCode as 400 | 401 | 403 | 404 | 429 | 500,
      });
    }

    if (error instanceof HTTPException) {
      console.error(`[gateway] ${c.req.method} ${c.req.path} → ${error.status}: ${error.message}`);
      return c.json(asJsonError(error.message, "http_error"), error.status);
    }

    console.error(`[gateway] ${c.req.method} ${c.req.path} unexpected error:`, error);
    return c.json(asJsonError("Unexpected gateway error", "internal_error"), 500);
  });

  app.get("/health", async (c) => {
    const live = c.req.query("live") === "1" || c.req.query("live") === "true";
    let providerHealth: Awaited<ReturnType<ProviderClient["getHealthSnapshot"]>>;

    try {
      providerHealth = await getActiveProviderClient().getHealthSnapshot({ live });
    } catch (error) {
      const providerError = error as { message?: string };
      providerHealth = {
        configured: false,
        availableProviders: [],
        status: "unconfigured",
        error: providerError.message ?? "provider client unavailable",
      };
    }

    return c.json({
      ok: true,
      status: providerHealth.status === "degraded" ? "degraded" : "up",
      service: "bildy",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
      providers: providerHealth,
    });
  });

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") {
      await next();
      return;
    }
    return authMiddleware(config)(c, next);
  });

  app.get("/metrics", (c) => {
    const evalRunId = normalizeEvalRunId(c.req.query("evalRunId"));
    const metrics = buildMetrics(events.all(evalRunId));
    return c.json(metrics);
  });

  app.get("/providers", async (c) => {
    const live = c.req.query("live") === "1" || c.req.query("live") === "true";
    const providers = await getActiveProviderClient().getHealthSnapshot({ live });

    return c.json({
      providers,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/v1/models", async (c) => {
    const aliases = await loadGatewayModelAliases({
      config,
      providerClient: getActiveProviderClient(),
    });

    return c.json({
      object: "list",
      data: aliases.map(openAIModelPayload),
    });
  });

  app.get("/models", async (c) => {
    const aliases = await loadGatewayModelAliases({
      config,
      providerClient: getActiveProviderClient(),
    });
    const providerSnapshot = await getActiveProviderClient().getHealthSnapshot({ live: false });

    return c.json({
      object: "list",
      providers: providerSnapshot.availableProviders,
      aliases,
      data: aliases.map(openAIModelPayload),
    });
  });

  app.get("/events/recent", (c) => {
    const evalRunId = normalizeEvalRunId(c.req.query("evalRunId"));
    const limit = Number(c.req.query("limit") ?? "100");
    return c.json({ events: events.recent(Number.isFinite(limit) ? limit : 100, evalRunId) });
  });

  app.post("/routes/inspect", async (c) => {
    const input = await parseRequestBody<Record<string, unknown>>(c.req.raw);
    const client = (input.client === "claude-code" || input.client === "codex" || input.client === "unknown")
      ? input.client as ClientName
      : buildContext(c.req.path, evalRunIdFromRequest(c.req)).client;
    const context: GatewayRequestContext = {
      ...buildContext(c.req.path, evalRunIdFromRequest(c.req)),
      client,
    };
    const request = requestFromInspectionInput(input, context);
    const aliases = await loadGatewayModelAliases({
      config,
      providerClient: getActiveProviderClient(),
    });
    const modelResolution = resolveModelAlias({
      requestedModel: request.model,
      aliases,
    });
    const routeClass = typeof input.routeClass === "string" && input.routeClass in config.routing.routes
      ? input.routeClass as RouteClass
      : modelResolution.routeClass
        ? modelResolution.routeClass
      : classifyRequest(request);
    const candidates = routeCandidates(routeClass, config);
    const shadowMode = config.routing.shadowRoutes?.[routeClass] ?? config.routing.shadowMode;
    const stripTools = shouldStripTools({ activeRoute: routeClass, context, request, candidates });
    const capabilityDegradations = buildCapabilityDegradations({ activeRoute: routeClass, stripTools, request }) ?? [];
    const requestForSelection: LLMRequest = {
      ...request,
      ...(stripTools ? { tools: undefined, toolMode: undefined } : {}),
      model: modelResolution.kind === "provider_alias" ? modelResolution.model : undefined,
      workload: ROUTE_TO_USE_CASE[routeClass],
    };
    const selectedProvider = shadowMode
      ? "anthropic"
      : modelResolution.provider ?? selectCompatibleProvider(candidates, requestForSelection, context.client, config.routing.experimentalModels);
    const ranked = await rankModelsForRoutes(ROUTE_TO_USE_CASE[routeClass], [selectedProvider]);
    const selected = ranked[0] ?? null;
    const selectedIndex = Math.max(0, candidates.indexOf(selectedProvider));
    const selectedModel = shadowMode
      ? selected?.model ?? "bildy-auto"
      : modelResolution.model ?? selected?.model ?? "bildy-auto";
    const routePlan = getGatewayRoutePlan({
      ...requestForSelection,
      model: selectedModel === "bildy-auto" ? requestForSelection.model : selectedModel,
    }, toProviderNames([selectedProvider]));
    const combinedCapabilityDegradations = [
      ...capabilityDegradations,
      ...routePlan.degradations,
    ];

    return c.json({
      routeClass,
      providerCandidates: candidates,
      selectedProvider,
      selectedModel,
      fallbackChain: candidates.slice(selectedIndex),
      capabilityDegradations: combinedCapabilityDegradations,
      shadowMode,
      workload: ROUTE_TO_USE_CASE[routeClass],
      routePlan: {
        useCase: ROUTE_TO_USE_CASE[routeClass],
        estimatedInputTokens: routePlan.estimatedInputTokens,
        requirements: routePlan.requirements,
        capabilities: routePlan.capabilities,
        cache: routePlan.cache,
        degradations: routePlan.degradations,
        warnings: routePlan.warnings,
      },
      requestedModel: modelResolution.requestedModel,
      modelResolution,
    });
  });

  app.post("/v1/messages", async (c) => {
    const context = buildContext(c.req.path, evalRunIdFromRequest(c.req));
    let routeClass: RouteClass | undefined;

    try {
      // Optional compatibility mode: proxy raw Claude Code requests directly to
      // Anthropic when exact Anthropic wire behavior is more important than
      // gateway routing. Disabled by default so eligible Claude traffic can use
      // cheaper providers such as Cloudflare Workers AI.
      const upstreamAuth: UpstreamAnthropicAuth = {
        apiKey: process.env.ANTHROPIC_API_KEY,
        bearerToken: extractBearerToken(c.req.header("authorization")),
      };
      if (config.routing.anthropicDirectProxy && (upstreamAuth.apiKey || upstreamAuth.bearerToken)) {
        const rawBody = await c.req.text();
        console.log(`[gateway] ${context.requestId} /v1/messages → direct anthropic proxy`);
        return directAnthropicProxy(rawBody, c.req, context, upstreamAuth, events, eventSink, config);
      }

      const input = await parseRequestBody<Record<string, unknown>>(c.req.raw);
      const llmRequest = anthropicMessagesAdapter.toLLMRequest(input as never, context);

      console.log(`[gateway] ${context.requestId} /v1/messages model=${String(llmRequest.model ?? "auto")} msgs=${llmRequest.messages.length} tools=${llmRequest.tools?.length ?? 0} stream=${llmRequest.stream ?? false}`);

      const result = await executeRequest({
        config,
        context,
        request: llmRequest,
        cache,
        providerClient: getActiveProviderClient(),
      });
      routeClass = result.routeClass;

      const event = buildGatewayEvent({
        context,
        routeClass: result.routeClass,
        response: result.response,
        status: result.response.fallbackChain.length > 1 ? "fallback_success" : "success",
        shadow: result.shadow,
      });

      events.append(event);
      eventSink.write(event);

      console.log(`[gateway] ${context.requestId} → ${result.routeClass} ${result.response.provider}/${result.response.model}`);

      if (llmRequest.stream) {
        const out = anthropicMessagesAdapter.fromLLMStream?.(result.textStream, context);
        return new Response(out, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      return c.json(anthropicMessagesAdapter.fromLLMResponse(result.response, context));
    } catch (error) {
      const err = error as { message?: string; code?: string };
      const errorClass = err.code ?? (error instanceof Error ? error.constructor.name : "unknown_error");
      const errEvent = buildErrorEvent({ context, errorClass, errorMessage: err.message, routeClass });
      events.append(errEvent);
      eventSink.write(errEvent);
      throw error;
    }
  });

  app.post("/v1/responses", async (c) => {
    const context = buildContext(c.req.path, evalRunIdFromRequest(c.req));
    let routeClass: RouteClass | undefined;

    try {
      const input = await parseRequestBody<Record<string, unknown>>(c.req.raw);
      const llmRequest = openAIResponsesAdapter.toLLMRequest(input as never, context);
      const executeRequestBody = llmRequest.stream && llmRequest.tools?.length
        ? { ...llmRequest, stream: false }
        : llmRequest;

      console.log(`[gateway] ${context.requestId} /v1/responses stream=${llmRequest.stream ?? false}`);

      const result = await executeRequest({
        config,
        context,
        request: executeRequestBody,
        cache,
        providerClient: getActiveProviderClient(),
      });
      routeClass = result.routeClass;

      const event = buildGatewayEvent({
        context,
        routeClass: result.routeClass,
        response: result.response,
        status: result.response.fallbackChain.length > 1 ? "fallback_success" : "success",
        shadow: result.shadow,
      });

      events.append(event);
      eventSink.write(event);

      console.log(`[gateway] ${context.requestId} → ${result.routeClass} ${result.response.provider}/${result.response.model}`);

      if (llmRequest.stream) {
        const out = openAIResponsesAdapter.fromLLMStream?.(result.textStream, context, result.response);
        return new Response(out, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      return c.json(openAIResponsesAdapter.fromLLMResponse(result.response, context));
    } catch (error) {
      const err = error as { message?: string; code?: string };
      const errorClass = err.code ?? (error instanceof Error ? error.constructor.name : "unknown_error");
      const errEvent = buildErrorEvent({ context, errorClass, errorMessage: err.message, routeClass });
      events.append(errEvent);
      eventSink.write(errEvent);
      throw error;
    }
  });

  app.post("/v1/chat/completions", async (c) => {
    const context = buildContext(c.req.path, evalRunIdFromRequest(c.req));
    let routeClass: RouteClass | undefined;

    try {
      const input = await parseRequestBody<Record<string, unknown>>(c.req.raw);
      const llmRequest = openAIChatCompletionsAdapter.toLLMRequest(input as never, context);

      console.log(`[gateway] ${context.requestId} /v1/chat/completions stream=${llmRequest.stream ?? false}`);

      const result = await executeRequest({
        config,
        context,
        request: llmRequest,
        cache,
        providerClient: getActiveProviderClient(),
      });
      routeClass = result.routeClass;

      const event = buildGatewayEvent({
        context,
        routeClass: result.routeClass,
        response: result.response,
        status: result.response.fallbackChain.length > 1 ? "fallback_success" : "success",
        shadow: result.shadow,
      });

      events.append(event);
      eventSink.write(event);

      console.log(`[gateway] ${context.requestId} → ${result.routeClass} ${result.response.provider}/${result.response.model}`);

      if (llmRequest.stream) {
        const out = openAIChatCompletionsAdapter.fromLLMStream?.(result.textStream, context);
        return new Response(out, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      return c.json(openAIChatCompletionsAdapter.fromLLMResponse(result.response, context));
    } catch (error) {
      const err = error as { message?: string; code?: string };
      const errorClass = err.code ?? (error instanceof Error ? error.constructor.name : "unknown_error");
      const errEvent = buildErrorEvent({ context, errorClass, errorMessage: err.message, routeClass });
      events.append(errEvent);
      eventSink.write(errEvent);
      throw error;
    }
  });

  // Shadow stats: aggregate projected savings, route distribution, and catalog snapshot
  app.get("/shadow/stats", async (c) => {
    const all = events.all();
    const shadowed = all.filter((e) => e.shadowRoute !== undefined);

    const byRoute: Record<string, { count: number; projectedSavingsUsd: number; confidence: Record<string, number> }> = {};
    let totalProjected = 0;

    for (const e of shadowed) {
      const key = e.shadowRoute!;
      if (!byRoute[key]) byRoute[key] = { count: 0, projectedSavingsUsd: 0, confidence: {} };
      byRoute[key].count++;
      byRoute[key].projectedSavingsUsd += e.projectedSavingsUsd ?? 0;
      byRoute[key].confidence[e.shadowConfidence ?? "unknown"] = (byRoute[key].confidence[e.shadowConfidence ?? "unknown"] ?? 0) + 1;
      totalProjected += e.projectedSavingsUsd ?? 0;
    }

    // Catalog snapshot: what would each route class select right now?
    const ROUTE_CLASSES: RouteClass[] = ["tool_loop", "long_context", "planning", "code_draft", "summary", "fallback_safe"];
    const catalogSnapshot: Record<string, {
      useCase: string;
      shadowActive: boolean;
      candidates: string[];
      recommended: { provider: string; model: string; lifecycle: string; deprecationWarning?: string } | null;
    }> = {};

    for (const rc of ROUTE_CLASSES) {
      const useCase = ROUTE_TO_USE_CASE[rc];
      const candidates = routeCandidates(rc, config);
      const ranked = await rankModelsForRoutes(useCase, candidates);
      const top = ranked[0] ?? null;
      const shadowActive = config.routing.shadowRoutes?.[rc] ?? config.routing.shadowMode;
      catalogSnapshot[rc] = {
        useCase,
        shadowActive,
        candidates,
        recommended: top
          ? {
              provider: top.provider,
              model: top.model,
              lifecycle: top.lifecycle,
              ...(top.lifecycle === "retired" || top.lifecycle === "compatibility"
                ? { deprecationWarning: `${top.model} is ${top.lifecycle}` }
                : {}),
            }
          : null,
      };
    }

    return c.json({
      shadowMode: config.routing.shadowMode,
      totalRequests: all.length,
      shadowedRequests: shadowed.length,
      totalProjectedSavingsUsd: Math.round(totalProjected * 100000) / 100000,
      byRoute,
      catalogSnapshot,
      recentShadow: shadowed.slice(-20).reverse().map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        actualRoute: e.routeClass,
        shadowRoute: e.shadowRoute,
        shadowProvider: e.shadowProvider,
        confidence: e.shadowConfidence,
        projectedSavingsUsd: e.projectedSavingsUsd,
      })),
    });
  });

  // Context compaction: distill a conversation into durable facts + next actions
  app.post("/v1/context/compact", async (c) => {
    const input = await parseRequestBody<{
      messages: Array<{ role: string; content: string }>;
      system?: string;
    }>(c.req.raw);

    const transcript = input.messages
      .map((m) => `[${m.role.toUpperCase()}]: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n\n");

    const compactRequest: LLMRequest = {
      messages: [
        {
          role: "user",
          content: `Extract the essential structure from this AI coding session transcript. Return ONLY valid JSON matching this schema — no prose, no markdown:

{
  "durable_facts": [],
  "decisions_made": [],
  "files_changed": [],
  "open_questions": [],
  "next_actions": [],
  "context_to_discard": ""
}

TRANSCRIPT:
${transcript.slice(0, 32_000)}`,
        },
      ],
      sampling: {
        maxTokens: 1200,
        temperature: 0.1,
      },
    };

    const requestId = crypto.randomUUID();
    const providerClient = getActiveProviderClient();
    const summaryCandidates = routeCandidates("summary", config);
    const compactProvider = selectCompatibleProvider(summaryCandidates, compactRequest, "unknown", config.routing.experimentalModels);

    try {
      const { response } = await providerClient.route(compactRequest, "summary", compactProvider, requestId);

      let parsed: unknown;
      try {
        const jsonMatch = response.outputText.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: response.outputText };
      } catch {
        parsed = { raw: response.outputText };
      }

      return c.json({
        ok: true,
        provider: response.provider,
        model: response.model,
        inputTokensEstimate: Math.ceil(transcript.length / 4),
        compact: parsed,
      });
    } catch (error) {
      const err = error as { message?: string };
      return c.json({ ok: false, error: err.message ?? "compaction failed" }, 500);
    }
  });

  return {
    app,
    config,
  };
}

export async function startServer(config = resolveConfig()) {
  const { app } = createServer(config);
  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  return server;
}
