import type {
  CacheHints,
  CanonicalDegradation,
  CanonicalRoutingMetadata,
  LLMRequest as ProviderRequest,
  LLMResponse as ProviderResponse,
  ModelRecommendationUseCase,
  ObservabilityHooks,
  ProviderHealthEntry,
  ProviderName,
  QuotaHook,
} from "@stackbilt/llm-providers";
import { canonicalToLLMRequest, normalizeLLMResponse } from "@stackbilt/llm-providers";
import { GatewayError } from "../errors.js";
import { LLMRequest, LLMResponse, RouteClass } from "../types.js";
import { createCloudflareAiBinding } from "./cloudflare-ai-binding.js";

const PROVIDER_NAMES: ProviderName[] = ["openai", "anthropic", "cloudflare", "cerebras", "groq", "nvidia"];

type ProvidersModule = {
  LLMProviders: {
    fromEnv(env: Record<string, unknown>, overrides: Record<string, unknown>): LLMProvidersInstance;
  };
  MODEL_CATALOG: readonly import("@stackbilt/llm-providers").ModelCatalogEntry[];
  getProviderDefaultModel(provider: ProviderName, request?: Partial<ProviderRequest>): string;
  rankModels(useCase: ModelRecommendationUseCase, availableProviders: string[]): Array<{ model: string; provider: string; lifecycle: string }>;
};

type LLMProvidersInstance = {
  generateResponse(request: ProviderRequest): Promise<ProviderResponse>;
  generateResponseStream(request: ProviderRequest): Promise<ReadableStream<string>>;
  getAvailableProviders(): string[];
  getHealth(): Promise<Record<string, ProviderHealthEntry>>;
};

interface PendingRequestMeta {
  requestedProvider: string;
  lastStartedProvider?: string;
  lastStartedModel?: string;
}

export interface ProviderRouteResult {
  response: LLMResponse;
  textStream: ReadableStream<string>;
}

export interface ProviderHealthSnapshot {
  configured: boolean;
  availableProviders: string[];
  status: "unconfigured" | "ok" | "degraded";
  healthyProviders?: string[];
  unhealthyProviders?: string[];
  detail?: Record<string, ProviderHealthEntry>;
  error?: string;
}

export interface ProviderClient {
  route(
    request: LLMRequest,
    routeClass: RouteClass,
    preferredProvider: string,
    requestId: string,
    modelOverride?: string,
  ): Promise<ProviderRouteResult>;
  getHealthSnapshot(options?: { live?: boolean }): Promise<ProviderHealthSnapshot>;
}

let providersModulePromise: Promise<ProvidersModule> | null = null;

function loadProvidersModule(): Promise<ProvidersModule> {
  if (!providersModulePromise) {
    providersModulePromise = import("@stackbilt/llm-providers") as Promise<ProvidersModule>;
  }

  return providersModulePromise;
}

function toStream(text: string, chunkSize = 40): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      let index = 0;
      while (index < text.length) {
        controller.enqueue(text.slice(index, index + chunkSize));
        index += chunkSize;
      }
      controller.close();
    },
  });
}

function providerNameOrNull(input: string): ProviderName | null {
  return PROVIDER_NAMES.find((provider) => provider === input) ?? null;
}

function normalizeFallbackChain(fallbackChain: string[]): CanonicalRoutingMetadata["fallbackChain"] {
  return fallbackChain
    .map((provider) => providerNameOrNull(provider))
    .filter((provider): provider is ProviderName => Boolean(provider))
    .map((provider) => ({ provider }));
}

function getGatewayDegradations(request: LLMRequest): CanonicalDegradation[] | undefined {
  const value = request.metadata?.custom?.capabilityDegradations;
  if (!Array.isArray(value)) return undefined;

  return value.filter((item): item is CanonicalDegradation => {
    if (typeof item !== "object" || item === null) return false;
    const candidate = item as Partial<CanonicalDegradation>;
    return typeof candidate.capability === "string"
      && typeof candidate.reason === "string"
      && (candidate.action === "stripped"
        || candidate.action === "downgraded"
        || candidate.action === "emulated"
        || candidate.action === "failed");
  });
}

function detectConfiguredProvidersFromEnv(env: NodeJS.ProcessEnv): string[] {
  const configured: string[] = [];

  if (env.ANTHROPIC_API_KEY) configured.push("anthropic");
  if (env.OPENAI_API_KEY) configured.push("openai");
  if (env.GROQ_API_KEY) configured.push("groq");
  if (env.CEREBRAS_API_KEY) configured.push("cerebras");
  if (env.NVIDIA_API_KEY) configured.push("nvidia");
  if (env.AI) configured.push("cloudflare");
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) configured.push("cloudflare");

  return configured;
}

class GatewayProviderClient implements ProviderClient {
  private llm: LLMProvidersInstance | null = null;
  private readonly scopedLlms = new Map<ProviderName, LLMProvidersInstance>();
  private readonly pending = new Map<string, PendingRequestMeta>();
  private readonly fallbackByRequestId = new Map<string, string[]>();

  constructor(private readonly quotaHook?: QuotaHook) {}

  private createHooks(): ObservabilityHooks {
    return {
      onFallback: (event) => {
        if (!event.requestId) return;
        const existing = this.fallbackByRequestId.get(event.requestId) ?? [event.fromProvider];
        existing.push(event.toProvider);
        this.fallbackByRequestId.set(event.requestId, existing);
      },
      onRequestStart: (event) => {
        if (!event.requestId) return;
        const pending = this.pending.get(event.requestId);
        if (!pending) return;
        pending.lastStartedProvider = event.provider;
        pending.lastStartedModel = event.model;
      },
    };
  }

  private buildEnvForProviders(allowedProviders?: ReadonlySet<ProviderName>): Record<string, unknown> {
    const includeProvider = (provider: ProviderName) => !allowedProviders || allowedProviders.has(provider);
    const envForProviders: Record<string, unknown> = {};

    if (includeProvider("anthropic") && process.env.ANTHROPIC_API_KEY) {
      envForProviders.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }
    if (includeProvider("openai") && process.env.OPENAI_API_KEY) {
      envForProviders.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    }
    if (includeProvider("groq") && process.env.GROQ_API_KEY) {
      envForProviders.GROQ_API_KEY = process.env.GROQ_API_KEY;
    }
    if (includeProvider("cerebras") && process.env.CEREBRAS_API_KEY) {
      envForProviders.CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY;
    }
    if (includeProvider("nvidia") && process.env.NVIDIA_API_KEY) {
      envForProviders.NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
    }

    if (includeProvider("cloudflare")) {
      const hasCloudflareBinding = typeof process.env.AI === "object" && process.env.AI !== null;
      const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;

      if (hasCloudflareBinding) {
        envForProviders.AI = process.env.AI;
      } else if (cloudflareAccountId && cloudflareApiToken) {
        envForProviders.AI = createCloudflareAiBinding({
          accountId: cloudflareAccountId,
          apiToken: cloudflareApiToken,
          apiBaseUrl: process.env.CLOUDFLARE_API_BASE_URL,
          gatewayId: process.env.AI_GATEWAY_ID,
        });
      }
    }

    return envForProviders;
  }

  private createLLM(
    providersModule: ProvidersModule,
    envForProviders: Record<string, unknown>,
    defaultProvider: ProviderName | "auto",
  ): LLMProvidersInstance {
    return providersModule.LLMProviders.fromEnv(envForProviders, {
      defaultProvider,
      costOptimization: false,
      enableCircuitBreaker: true,
      enableRetries: true,
      hooks: this.createHooks(),
      ...(this.quotaHook ? { quotaHook: this.quotaHook } : {}),
    });
  }

  private async getLLM(): Promise<LLMProvidersInstance> {
    if (this.llm) return this.llm;

    try {
      const providersModule = await loadProvidersModule();
      this.llm = this.createLLM(providersModule, this.buildEnvForProviders(), "auto");

      return this.llm;
    } catch (error) {
      const providerError = error as { message?: string };
      throw new GatewayError(
        providerError.message ?? "No LLM providers configured from environment",
        "provider_init_error",
        503,
      );
    }
  }

  private async getScopedLLM(providerName: ProviderName): Promise<LLMProvidersInstance> {
    const cached = this.scopedLlms.get(providerName);
    if (cached) return cached;

    try {
      const providersModule = await loadProvidersModule();
      const llm = this.createLLM(
        providersModule,
        this.buildEnvForProviders(new Set([providerName])),
        providerName,
      );
      this.scopedLlms.set(providerName, llm);
      return llm;
    } catch (error) {
      const providerError = error as { message?: string };
      throw new GatewayError(
        providerError.message ?? `Provider ${providerName} is not configured from environment`,
        "provider_init_error",
        503,
      );
    }
  }

  private shouldUseScopedProvider(request: LLMRequest, preferredProvider: string, modelOverride?: string): ProviderName | null {
    const providerName = providerNameOrNull(preferredProvider);
    if (!providerName) return null;
    // Only scope when an explicit CF/provider model was chosen — keeps the
    // model pinned to the right provider without killing fallback for
    // auto-routed requests (e.g. Codex tool-loop multi-turn via stackbilt/auto).
    if (modelOverride) return providerName;
    return null;
  }

  private consumeFallbackChain(requestId: string, finalProvider: string): string[] {
    const fallbacks = this.fallbackByRequestId.get(requestId) ?? [];
    this.fallbackByRequestId.delete(requestId);

    if (fallbacks.length === 0) return [finalProvider];

    if (fallbacks[fallbacks.length - 1] !== finalProvider) {
      fallbacks.push(finalProvider);
    }

    return fallbacks;
  }

  private async buildProviderRequest(
    request: LLMRequest,
    routeClass: RouteClass,
    preferredProvider: string,
    requestId: string,
    modelOverride?: string,
  ): Promise<ProviderRequest> {
    const preferredProviderName = providerNameOrNull(preferredProvider);
    const canonicalRequest: LLMRequest = {
      ...request,
      metadata: {
        ...request.metadata,
        requestId,
        gateway: process.env.AI_GATEWAY_ID
          ? {
              ...(request.metadata?.gateway ?? {}),
              requestId,
              customMetadata: {
                ...(request.metadata?.gateway?.customMetadata ?? {}),
                app: "llm-gateway",
                routeClass,
                executor: typeof request.metadata?.custom?.protocol === "string"
                  ? request.metadata.custom.protocol
                  : "unknown",
              },
            }
          : request.metadata?.gateway,
      },
    };

    // Provider-prefix caching benefits requests with stable system prompts + tool schemas.
    // planning and code_draft always have those (Claude Code sends 50+ tools per request).
    const CACHE_HINT_ROUTES = new Set<RouteClass>(["planning", "code_draft"]);
    if (CACHE_HINT_ROUTES.has(routeClass)) {
      canonicalRequest.metadata = {
        ...canonicalRequest.metadata,
        cache: {
          strategy: "provider-prefix",
          cacheablePrefix: "auto",
          sessionId: `llm-gateway:${routeClass}:${requestId}`,
        } satisfies CacheHints,
      };
    }

    const providerRequest = canonicalToLLMRequest(canonicalRequest);

    const cheapProviders = new Set<ProviderName>(["groq", "cerebras", "cloudflare"]);
    const VALID_USE_CASES = new Set<string>(["COST_EFFECTIVE", "HIGH_PERFORMANCE", "BALANCED", "TOOL_CALLING", "LONG_CONTEXT", "VISION", "RESEARCH"]);

    if (modelOverride) {
      providerRequest.model = modelOverride;
    } else if (preferredProviderName && cheapProviders.has(preferredProviderName)) {
      const rawUseCase = request.workload?.toUpperCase();
      const useCase = (rawUseCase && VALID_USE_CASES.has(rawUseCase))
        ? rawUseCase as ModelRecommendationUseCase
        : "BALANCED";
      const { rankModels } = await loadProvidersModule();
      const ranked = rankModels(useCase, [preferredProvider]);
      const top = ranked[0];
      if (top && (top.lifecycle === "retired" || top.lifecycle === "compatibility")) {
        console.warn(`[gateway] model ${top.model} (${top.provider}) is ${top.lifecycle} — update route config`);
      }
      providerRequest.model = top?.model
        ?? (await loadProvidersModule()).getProviderDefaultModel(preferredProviderName, providerRequest);
    } else if (!providerRequest.model) {
      providerRequest.model = (await loadProvidersModule()).getProviderDefaultModel(
        preferredProviderName ?? "anthropic",
        providerRequest,
      );
    }

    return providerRequest;
  }

  async route(
    request: LLMRequest,
    routeClass: RouteClass,
    preferredProvider: string,
    requestId: string,
    modelOverride?: string,
  ): Promise<ProviderRouteResult> {
    const scopedProvider = this.shouldUseScopedProvider(request, preferredProvider, modelOverride);
    const llm = scopedProvider ? await this.getScopedLLM(scopedProvider) : await this.getLLM();
    const providerRequest = await this.buildProviderRequest(
      request,
      routeClass,
      preferredProvider,
      requestId,
      modelOverride,
    );
    this.pending.set(requestId, {
      requestedProvider: preferredProvider,
    });

    try {
      if (request.stream) {
        const stream = await llm.generateResponseStream(providerRequest);
        const pending = this.pending.get(requestId);
        const selectedProvider = pending?.lastStartedProvider ?? preferredProvider;
        const selectedModel = pending?.lastStartedModel ?? providerRequest.model ?? "stackbilt-auto";

        const response: LLMResponse = {
          id: requestId,
          provider: selectedProvider,
          model: selectedModel,
          outputText: "",
          usage: undefined,
          fallbackChain: this.consumeFallbackChain(requestId, selectedProvider),
          routing: {
            selectedProvider: providerNameOrNull(selectedProvider) ?? "anthropic",
            selectedModel,
            degradations: getGatewayDegradations(request),
          },
          capabilityDegradations: getGatewayDegradations(request),
          routeClass,
          cacheHit: false,
        };

        return {
          response,
          textStream: stream,
        };
      }

      const providerResponse = await llm.generateResponse(providerRequest);
      return {
        response: this.toGatewayResponse(providerResponse, routeClass, requestId, preferredProvider, request),
        textStream: toStream(providerResponse.message ?? providerResponse.content ?? ""),
      };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      const providerError = error as { message?: string; statusCode?: number; code?: string };
      throw new GatewayError(
        providerError.message ?? "Provider request failed",
        providerError.code ?? "provider_error",
        providerError.statusCode ?? 502,
      );
    } finally {
      this.pending.delete(requestId);
    }
  }

  async getHealthSnapshot(options?: { live?: boolean }): Promise<ProviderHealthSnapshot> {
    const live = options?.live ?? false;
    const configuredFromEnv = detectConfiguredProvidersFromEnv(process.env);
    const configured = configuredFromEnv.length > 0;

    if (!live) {
      return {
        configured,
        availableProviders: configuredFromEnv,
        status: configured ? "ok" : "unconfigured",
      };
    }

    try {
      const llm = await this.getLLM();
      const availableProviders = llm.getAvailableProviders();
      const detail = await llm.getHealth();
      const healthyProviders = Object.entries(detail)
        .filter(([, entry]) => entry.healthy)
        .map(([provider]) => provider);
      const unhealthyProviders = Object.entries(detail)
        .filter(([, entry]) => !entry.healthy)
        .map(([provider]) => provider);

      return {
        configured: availableProviders.length > 0,
        availableProviders,
        status: availableProviders.length === 0 ? "unconfigured" : unhealthyProviders.length > 0 ? "degraded" : "ok",
        healthyProviders,
        unhealthyProviders,
        detail,
      };
    } catch (error) {
      const providerError = error as { message?: string };
      return {
        configured,
        availableProviders: configuredFromEnv,
        status: configured ? "degraded" : "unconfigured",
        error: providerError.message ?? "provider health check failed",
      };
    }
  }

  private normalizeStopReason(reason?: string): string | undefined {
    if (!reason) return undefined;
    if (reason === "stop") return "end_turn";
    if (reason === "length") return "max_tokens";
    return reason;
  }

  private toGatewayResponse(
    providerResponse: ProviderResponse,
    routeClass: RouteClass,
    requestId: string,
    preferredProvider: string,
    request: LLMRequest,
  ): LLMResponse {
    const outputText = providerResponse.message ?? providerResponse.content ?? "";
    const finalProvider = providerResponse.provider ?? preferredProvider;
    const selectedProvider = providerNameOrNull(finalProvider) ?? providerNameOrNull(preferredProvider) ?? "anthropic";
    const fallbackChain = this.consumeFallbackChain(requestId, finalProvider);
    const routing = normalizeLLMResponse(providerResponse, {
      routing: {
        selectedProvider,
        selectedModel: providerResponse.model,
        fallbackChain: normalizeFallbackChain(fallbackChain),
        degradations: getGatewayDegradations(request),
      },
    }).routing;

    return {
      id: providerResponse.id ?? requestId,
      provider: finalProvider,
      model: providerResponse.model,
      outputText,
      toolCalls: providerResponse.toolCalls,
      stopReason: this.normalizeStopReason(providerResponse.finishReason),
      usage: {
        inputTokens: providerResponse.usage.inputTokens,
        outputTokens: providerResponse.usage.outputTokens,
        cachedInputTokens:
          providerResponse.usage.cachedInputTokens ?? providerResponse.usage.cacheReadInputTokens,
      },
      fallbackChain,
      routing,
      capabilityDegradations: routing?.degradations,
      routeClass,
      cacheHit: Boolean(
        (providerResponse.usage.cachedInputTokens ?? 0) > 0 ||
          (providerResponse.usage.cacheReadInputTokens ?? 0) > 0,
      ),
      raw: providerResponse,
    };
  }
}

let providerClient: GatewayProviderClient | null = null;

export function getProviderClient(): ProviderClient {
  if (providerClient) return providerClient;
  providerClient = new GatewayProviderClient();
  return providerClient;
}

export function resetProviderClient(): void {
  providerClient = null;
}

export function createProviderClient(options?: { quotaHook?: QuotaHook }): ProviderClient {
  return new GatewayProviderClient(options?.quotaHook);
}

export async function rankModelsForRoutes(
  useCase: ModelRecommendationUseCase,
  providers: string[],
): Promise<Array<{ model: string; provider: string; lifecycle: string }>> {
  const { rankModels } = await loadProvidersModule();
  return rankModels(useCase, providers);
}

export async function getModelCatalog(): Promise<readonly import("@stackbilt/llm-providers").ModelCatalogEntry[]> {
  const { MODEL_CATALOG } = await loadProvidersModule();
  return MODEL_CATALOG;
}
