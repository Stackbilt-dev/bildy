import type { ModelCatalogEntry } from "@stackbilt/llm-providers";
import { GatewayConfig, RouteClass } from "../types.js";

export type ModelResolutionKind =
  | "none"
  | "gateway_alias"
  | "provider_alias"
  | "auto_hidden";

export interface ModelResolution {
  kind: ModelResolutionKind;
  requestedModel?: string;
  alias?: string;
  routeClass?: RouteClass;
  provider?: string;
  model?: string;
}

export interface GatewayModelAlias {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  routeClass?: RouteClass;
  provider?: string;
  providerModel?: string;
  description?: string;
  lifecycle?: string;
}

const CREATED_AT = 0;

export const ROUTE_MODEL_ALIASES: Array<{
  id: string;
  routeClass?: RouteClass;
  description: string;
}> = [
  { id: "stackbilt/auto", description: "Gateway automatic route and provider selection" },
  { id: "stackbilt/planning", routeClass: "planning", description: "Planning and tool-aware reasoning turns" },
  { id: "stackbilt/code-fast", routeClass: "code_draft", description: "Fast code drafting route" },
  { id: "stackbilt/tool-loop", routeClass: "tool_loop", description: "In-progress tool result loop route" },
  { id: "stackbilt/summary", routeClass: "summary", description: "Low-cost summarize and extraction route" },
  { id: "stackbilt/long-context", routeClass: "long_context", description: "Large-context route" },
  { id: "stackbilt/fallback-safe", routeClass: "fallback_safe", description: "Conservative fallback route" },
];

const ROUTE_ALIAS_BY_ID = new Map(ROUTE_MODEL_ALIASES.map((alias) => [alias.id, alias]));

export function configuredRouteProviders(config: GatewayConfig): string[] {
  return Array.from(new Set(Object.values(config.routing.routes).flat()));
}

function providerAliasId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function buildGatewayModelAliases(params: {
  config: GatewayConfig;
  providers: string[];
  catalog: ModelCatalogEntry[];
}): GatewayModelAlias[] {
  const activeProviders = new Set(params.providers.length ? params.providers : configuredRouteProviders(params.config));
  const routeAliases: GatewayModelAlias[] = ROUTE_MODEL_ALIASES.map((alias) => ({
    id: alias.id,
    object: "model",
    created: CREATED_AT,
    owned_by: "stackbilt",
    routeClass: alias.routeClass,
    description: alias.description,
  }));

  const providerAliases = params.catalog
    .filter((entry) => activeProviders.has(entry.provider))
    .map((entry) => ({
      id: providerAliasId(entry.provider, entry.model),
      object: "model" as const,
      created: CREATED_AT,
      owned_by: entry.provider,
      provider: entry.provider,
      providerModel: entry.model,
      description: entry.capabilities.description,
      lifecycle: entry.lifecycle,
    }));

  const byId = new Map<string, GatewayModelAlias>();
  for (const alias of [...routeAliases, ...providerAliases]) {
    byId.set(alias.id, alias);
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveModelAlias(params: {
  requestedModel?: string;
  aliases: GatewayModelAlias[];
}): ModelResolution {
  const requestedModel = params.requestedModel?.trim();
  if (!requestedModel) return { kind: "none" };

  const routeAlias = ROUTE_ALIAS_BY_ID.get(requestedModel);
  if (routeAlias) {
    return {
      kind: "gateway_alias",
      requestedModel,
      alias: routeAlias.id,
      routeClass: routeAlias.routeClass,
    };
  }

  const providerAlias = params.aliases.find((alias) => alias.id === requestedModel && alias.provider && alias.providerModel);
  if (providerAlias) {
    return {
      kind: "provider_alias",
      requestedModel,
      alias: providerAlias.id,
      provider: providerAlias.provider,
      model: providerAlias.providerModel,
    };
  }

  return {
    kind: "auto_hidden",
    requestedModel,
  };
}
