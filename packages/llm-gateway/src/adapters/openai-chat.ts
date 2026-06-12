import { ClientAdapter, normalizeGatewayLLMRequest, textToSseStream, toCanonicalTool, toCanonicalToolMode } from "./types.js";
import { GatewayRequestContext, LLMRequest, LLMResponse } from "../types.js";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}

interface OpenAIChatRequest {
  model?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: Array<{ type?: string; function?: { name: string; description?: string; parameters?: Record<string, unknown> } }>;
  tool_choice?: string | Record<string, unknown>;
  stream?: boolean;
}

interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    finish_reason: string | null;
    message: {
      role: "assistant";
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export const openAIChatCompletionsAdapter: ClientAdapter<OpenAIChatRequest, OpenAIChatResponse> = {
  toLLMRequest(input: OpenAIChatRequest, _context: GatewayRequestContext): LLMRequest {
    const request = normalizeGatewayLLMRequest({
      model: input.model,
      messages: input.messages.map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content: m.content,
        ...(m.role === "tool"
          ? { toolResults: [{ id: m.tool_call_id ?? m.name ?? "unknown_tool", output: m.content }] }
          : {}),
      })),
      maxTokens: input.max_tokens,
      temperature: input.temperature,
      tools: input.tools?.map((tool) => toCanonicalTool(
        tool.function?.name ?? "unnamed_tool",
        tool.function?.description,
        tool.function?.parameters,
      )),
      stream: input.stream,
    }, _context);

    request.toolMode = toCanonicalToolMode(input.tool_choice);
    return request;
  },

  fromLLMResponse(output: LLMResponse): OpenAIChatResponse {
    const promptTokens = output.usage?.inputTokens;
    const completionTokens = output.usage?.outputTokens;

    return {
      id: output.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: output.model,
      choices: [
        {
          index: 0,
          finish_reason: output.stopReason ?? "stop",
          message: {
            role: "assistant",
            content: output.outputText,
          },
        },
      ],
      usage:
        promptTokens !== undefined || completionTokens !== undefined
          ? {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0),
            }
          : undefined,
    };
  },

  fromLLMStream(stream: ReadableStream<string>): ReadableStream<Uint8Array> {
    return textToSseStream("chat.completion.chunk", stream);
  },
};
