import { ClientAdapter, normalizeGatewayLLMRequest, toCanonicalTool, toCanonicalToolMode } from "./types.js";
import { GatewayRequestContext, LLMMessage, LLMRequest, LLMResponse } from "../types.js";

interface OpenAIResponseMessageInput {
  type?: "message";
  role: "user" | "assistant" | "system" | "developer";
  content:
    | string
    | Array<
        | { type: "input_text"; text: string }
        | { type: "output_text"; text: string }
        | { type: string; [key: string]: unknown }
      >;
}

interface OpenAIResponseFunctionCallInput {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
}

interface OpenAIResponseFunctionCallOutputInput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

type OpenAIResponseInput =
  | OpenAIResponseMessageInput
  | OpenAIResponseFunctionCallInput
  | OpenAIResponseFunctionCallOutputInput;

interface OpenAIResponsesRequest {
  model?: string;
  input?: string | OpenAIResponseInput[];
  max_output_tokens?: number;
  temperature?: number;
  tools?: Array<{ type?: string; name?: string; description?: string; parameters?: Record<string, unknown> }>;
  tool_choice?: string | Record<string, unknown>;
  stream?: boolean;
}

function normalizeResponsesTool(
  tool: NonNullable<OpenAIResponsesRequest["tools"]>[number],
) {
  if (tool.type && tool.type !== "function") return null;
  if (!tool.name) return null;
  return toCanonicalTool(tool.name, tool.description, tool.parameters);
}

interface OpenAIResponsesResponse {
  id: string;
  object: "response";
  model: string;
  output: Array<
    | {
        id: string;
        type: "message";
        role: "assistant";
        content: Array<{ type: "output_text"; text: string }>;
      }
    | {
        id: string;
        type: "function_call";
        call_id: string;
        name: string;
        arguments: string;
        status: "completed";
      }
  >;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface ResponseSseEvent {
  type: string;
  sequence_number: number;
  [key: string]: unknown;
}

function normalizeResponsesModel(model?: string): string | undefined {
  const normalized = model?.trim();
  if (!normalized) return undefined;
  if (normalized === "unknown" || normalized === "undefined" || normalized === "null") return undefined;
  return normalized;
}

function normalizeInputContent(content: OpenAIResponseMessageInput["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((item) => "text" in item)
    .map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
    .join("\n");
}

function normalizeInputItem(item: OpenAIResponseInput): LLMMessage | null {
  if (item.type === "function_call_output") {
    return {
      role: "user",
      content: item.output || "(empty tool result)",
      toolResults: [{ id: item.call_id, output: item.output || "" }],
    };
  }

  if (item.type === "function_call") {
    return {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: item.call_id,
          type: "function",
          function: {
            name: item.name,
            arguments: item.arguments,
          },
        },
      ],
    };
  }

  return {
    role: item.role === "developer" ? "system" : item.role,
    content: normalizeInputContent(item.content),
  };
}

function outputItemsForResponse(responseId: string, outputText?: string, toolCalls: LLMResponse["toolCalls"] = []) {
  const output: Array<Record<string, unknown>> = [];

  if (outputText !== undefined && (outputText.length > 0 || toolCalls.length === 0)) {
    output.push({
      id: `${responseId}_msg`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: outputText,
          annotations: [],
        },
      ],
    });
  }

  for (const toolCall of toolCalls) {
    output.push({
      id: toolCall.id,
      type: "function_call",
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
      status: "completed",
    });
  }

  return output;
}

function buildStreamResponse(params: {
  id: string;
  model: string;
  createdAt: number;
  status: "in_progress" | "completed";
  outputText?: string;
  toolCalls?: LLMResponse["toolCalls"];
  usage?: LLMResponse["usage"];
}) {
  const output = outputItemsForResponse(params.id, params.outputText, params.toolCalls);

  return {
    id: params.id,
    object: "response",
    created_at: params.createdAt,
    status: params.status,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: params.model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: params.usage
      ? {
          input_tokens: params.usage.inputTokens,
          output_tokens: params.usage.outputTokens,
          total_tokens: (params.usage.inputTokens ?? 0) + (params.usage.outputTokens ?? 0),
        }
      : null,
    user: null,
    metadata: {},
  };
}

function responsesTextToSseStream(
  stream: ReadableStream<string>,
  context: GatewayRequestContext,
  response?: LLMResponse,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const responseId = response?.id ?? context.requestId;
  const messageId = `${responseId}_msg`;
  const model = response?.model ?? "stackbilt/auto";
  const createdAt = Math.floor(Date.now() / 1000);
  let sequenceNumber = 0;
  let outputText = "";

  const encodeEvent = (eventName: string, event: ResponseSseEvent) => {
    return encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const nextEvent = (eventName: string, event: Omit<ResponseSseEvent, "type" | "sequence_number">) => {
    return encodeEvent(eventName, {
      type: eventName,
      sequence_number: sequenceNumber++,
      ...event,
    });
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const toolCalls = response?.toolCalls ?? [];
      const reader = toolCalls.length ? null : stream.getReader();
      try {
        controller.enqueue(nextEvent("response.created", {
          response: buildStreamResponse({
            id: responseId,
            model,
            createdAt,
            status: "in_progress",
          }),
        }));

        if (toolCalls.length) {
          for (const [outputIndex, toolCall] of toolCalls.entries()) {
            const item = {
              id: toolCall.id,
              type: "function_call",
              call_id: toolCall.id,
              name: toolCall.function.name,
              arguments: "",
              status: "in_progress",
            };
            controller.enqueue(nextEvent("response.output_item.added", {
              output_index: outputIndex,
              item,
            }));
            controller.enqueue(nextEvent("response.function_call_arguments.delta", {
              item_id: toolCall.id,
              output_index: outputIndex,
              delta: toolCall.function.arguments,
            }));
            controller.enqueue(nextEvent("response.function_call_arguments.done", {
              item_id: toolCall.id,
              output_index: outputIndex,
              arguments: toolCall.function.arguments,
            }));
            controller.enqueue(nextEvent("response.output_item.done", {
              output_index: outputIndex,
              item: {
                ...item,
                arguments: toolCall.function.arguments,
                status: "completed",
              },
            }));
          }
          controller.enqueue(nextEvent("response.completed", {
            response: buildStreamResponse({
              id: responseId,
              model,
              createdAt,
              status: "completed",
              toolCalls,
              usage: response?.usage,
            }),
          }));
          return;
        }
        if (!reader) return;

        controller.enqueue(nextEvent("response.output_item.added", {
          output_index: 0,
          item: {
            id: messageId,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        }));
        controller.enqueue(nextEvent("response.content_part.added", {
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: {
            type: "output_text",
            text: "",
            annotations: [],
          },
        }));

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          outputText += value;
          controller.enqueue(nextEvent("response.output_text.delta", {
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: value,
            logprobs: [],
          }));
        }

        controller.enqueue(nextEvent("response.output_text.done", {
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text: outputText,
          logprobs: [],
        }));
        controller.enqueue(nextEvent("response.content_part.done", {
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: {
            type: "output_text",
            text: outputText,
            annotations: [],
          },
        }));
        controller.enqueue(nextEvent("response.output_item.done", {
          output_index: 0,
          item: {
            id: messageId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: outputText,
                annotations: [],
              },
            ],
          },
        }));
        controller.enqueue(nextEvent("response.completed", {
          response: buildStreamResponse({
            id: responseId,
            model,
            createdAt,
            status: "completed",
            outputText,
            toolCalls: response?.toolCalls,
            usage: response?.usage,
          }),
        }));
      } finally {
        reader?.releaseLock();
        controller.close();
      }
    },
  });
}

export const openAIResponsesAdapter: ClientAdapter<OpenAIResponsesRequest, OpenAIResponsesResponse> = {
  toLLMRequest(input: OpenAIResponsesRequest, _context: GatewayRequestContext): LLMRequest {
    const messages =
      typeof input.input === "string"
        ? [{ role: "user" as const, content: input.input }]
        : (input.input ?? []).map(normalizeInputItem).filter((m): m is LLMMessage => m !== null);

    const request = normalizeGatewayLLMRequest({
      model: normalizeResponsesModel(input.model),
      messages,
      maxTokens: input.max_output_tokens,
      temperature: input.temperature,
      tools: input.tools
        ?.map(normalizeResponsesTool)
        .filter((tool): tool is NonNullable<ReturnType<typeof normalizeResponsesTool>> => tool !== null),
      stream: input.stream,
    }, _context);

    request.toolMode = toCanonicalToolMode(input.tool_choice);
    return request;
  },

  fromLLMResponse(output: LLMResponse): OpenAIResponsesResponse {
    return {
      id: output.id,
      object: "response",
      model: output.model,
      output: outputItemsForResponse(output.id, output.outputText, output.toolCalls) as OpenAIResponsesResponse["output"],
      usage: output.usage
        ? {
            input_tokens: output.usage.inputTokens,
            output_tokens: output.usage.outputTokens,
          }
        : undefined,
    };
  },

  fromLLMStream(
    stream: ReadableStream<string>,
    context: GatewayRequestContext,
    response?: LLMResponse,
  ): ReadableStream<Uint8Array> {
    return responsesTextToSseStream(stream, context, response);
  },
};
