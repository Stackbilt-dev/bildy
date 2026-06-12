type CloudflareRunInput = Record<string, unknown>;

interface CloudflareRunOptions {
  extraHeaders?: Record<string, string>;
  gateway?: {
    id: string;
    cacheKey?: string;
    cacheTtl?: number;
    skipCache?: boolean;
    collectLog?: boolean;
    metadata?: Record<string, number | string | boolean | null | bigint>;
  };
}

interface CloudflareAiBindingOptions {
  accountId: string;
  apiToken: string;
  apiBaseUrl?: string;
  gatewayId?: string;
}

interface CloudflareAiBinding {
  run(model: string, input: CloudflareRunInput, options?: CloudflareRunOptions): Promise<unknown>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function encodeModelPath(model: string): string {
  return model.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export function createCloudflareAiBinding(options: CloudflareAiBindingOptions): CloudflareAiBinding {
  const baseUrl = trimTrailingSlash(options.apiBaseUrl ?? "https://api.cloudflare.com/client/v4");
  const accountId = options.accountId.trim();
  const apiToken = options.apiToken.trim();
  const defaultGatewayId = options.gatewayId?.trim();

  return {
    async run(model: string, input: CloudflareRunInput, runOptions?: CloudflareRunOptions): Promise<unknown> {
      const gateway = runOptions?.gateway ?? (defaultGatewayId ? { id: defaultGatewayId } : undefined);
      const useGatewayChatEndpoint = Boolean(gateway?.id && Array.isArray(input.messages));
      const encodedModel = encodeModelPath(model);
      const url = useGatewayChatEndpoint
        ? `${baseUrl}/accounts/${accountId}/ai/v1/chat/completions`
        : `${baseUrl}/accounts/${accountId}/ai/run/${encodedModel}`;
      const headers: Record<string, string> = {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        ...(runOptions?.extraHeaders ?? {}),
      };
      let body: CloudflareRunInput = input;

      if (gateway?.id) {
        headers["cf-aig-gateway-id"] = gateway.id;
      }
      if (typeof gateway?.cacheTtl === "number") {
        headers["cf-aig-cache-ttl"] = String(gateway.cacheTtl);
      }
      if (gateway?.cacheKey) {
        headers["cf-aig-cache-key"] = gateway.cacheKey;
      }
      if (gateway?.skipCache) {
        headers["cf-aig-skip-cache"] = "true";
      }
      if (gateway?.collectLog !== undefined) {
        headers["cf-aig-collect-log"] = String(gateway.collectLog);
      }
      if (gateway?.metadata && Object.keys(gateway.metadata).length > 0) {
        headers["cf-aig-metadata"] = JSON.stringify(gateway.metadata);
      }

      if (useGatewayChatEndpoint) {
        body = { ...input, model };
      }

      // This Node-side shim emulates the Workers AI binding for local gateway
      // runs. Returning an upstream SSE stream here would bypass the provider's
      // response normalizers, so ask Cloudflare for JSON and let llm-providers
      // synthesize the client stream from normalized text/tool calls.
      if (body.stream === true) {
        body = { ...body, stream: false };
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      const payload = (await response.json().catch(() => null)) as
        | { success?: boolean; errors?: Array<{ message?: string }> | null; result?: unknown }
        | null;

      if (useGatewayChatEndpoint) {
        if (!response.ok) {
          const firstError = payload?.errors?.[0]?.message;
          const message = firstError ?? `Cloudflare AI Gateway request failed (${response.status})`;
          throw new Error(message);
        }
        return payload;
      }

      if (!response.ok || !payload?.success) {
        const firstError = payload?.errors?.[0]?.message;
        const message = firstError ?? `Cloudflare AI request failed (${response.status})`;
        throw new Error(message);
      }

      return payload.result;
    },
  };
}
