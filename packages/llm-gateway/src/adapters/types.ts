import {
  normalizeLLMRequest,
  type CanonicalToolMode,
  type LLMRequest as ProviderRequest,
  type Tool,
} from "@stackbilt/llm-providers";
import { GatewayRequestContext, LLMRequest, LLMResponse } from "../types.js";

export interface ClientAdapter<ClientRequest, ClientResponse> {
  toLLMRequest(input: ClientRequest, context: GatewayRequestContext): LLMRequest;
  fromLLMResponse(output: LLMResponse, context: GatewayRequestContext): ClientResponse;
  fromLLMStream?(
    stream: ReadableStream<string>,
    context: GatewayRequestContext,
    response?: LLMResponse,
  ): ReadableStream<Uint8Array>;
}

export function textToSseStream(
  eventName: string,
  stream: ReadableStream<string>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(encoder.encode(`event: ${eventName}\ndata: ${value}\n\n`));
        }
        controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeToolParameters(inputSchema: unknown): Tool["function"]["parameters"] {
  if (isRecord(inputSchema) && inputSchema.type === "object" && isRecord(inputSchema.properties)) {
    return {
      type: "object",
      properties: inputSchema.properties,
      required: Array.isArray(inputSchema.required)
        ? inputSchema.required.filter((item): item is string => typeof item === "string")
        : undefined,
    };
  }

  return {
    type: "object",
    properties: {},
  };
}

export function toCanonicalTool(
  name: string,
  description: string | undefined,
  inputSchema: unknown,
): Tool {
  return {
    type: "function",
    function: {
      name,
      description: description ?? "Gateway forwarded tool",
      parameters: normalizeToolParameters(inputSchema),
    },
  };
}

export function toCanonicalToolMode(toolChoice: unknown): CanonicalToolMode | undefined {
  if (toolChoice === undefined) return undefined;
  if (toolChoice === "none" || toolChoice === "auto") return toolChoice;
  if (toolChoice === "any" || toolChoice === "required") return "required";

  if (typeof toolChoice === "string") {
    return { toolName: toolChoice };
  }

  if (isRecord(toolChoice)) {
    const functionValue = toolChoice.function;
    if (isRecord(functionValue) && typeof functionValue.name === "string") {
      return { toolName: functionValue.name };
    }

    if (typeof toolChoice.name === "string") {
      return { toolName: toolChoice.name };
    }
  }

  return "auto";
}

export function normalizeGatewayLLMRequest(
  request: ProviderRequest,
  context: GatewayRequestContext,
): LLMRequest {
  const canonical = normalizeLLMRequest(request);

  return {
    ...canonical,
    metadata: {
      ...canonical.metadata,
      requestId: context.requestId,
      custom: {
        ...(canonical.metadata?.custom ?? {}),
        client: context.client,
        protocol: context.protocol,
        requestPath: context.requestPath,
      },
    },
  };
}
