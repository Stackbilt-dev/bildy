import { GatewayConfig, RouteClass } from "../types.js";

export function routeCandidates(routeClass: RouteClass, config: GatewayConfig): string[] {
  const configured = config.routing.routes[routeClass];
  if (configured?.length) return configured;
  return config.routing.routes.fallback_safe;
}
