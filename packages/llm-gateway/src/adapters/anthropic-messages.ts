import { ClientAdapter, normalizeGatewayLLMRequest, textToSseStream, toCanonicalTool, toCanonicalToolMode } from "./types.js";
import { GatewayRequestContext, LLMMessage, LLMRequest, LLMResponse } from "../types.js";

type AnthropicContentBlock =
  | { type: "text"; text?: string }
  | { type: "thinking"; thinking?: string }
  | { type: "tool_use"; id: string; name?: string; input?: unknown }
  | { type: "tool_result"; tool_use_id?: string; content?: string | Array<{ type: string; text?: string }> }
  | { type: "image"; source?: unknown };

type AnthropicInputMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

type AnthropicSystemBlock = { type: "text"; text?: string; cache_control?: unknown };

interface AnthropicMessagesRequest {
  model?: string;
  system?: string | AnthropicSystemBlock[];
  messages: AnthropicInputMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
  tool_choice?: string | Record<string, unknown>;
  stream?: boolean;
}

interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }>;
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function normalizeContent(content: AnthropicInputMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text ?? "";
      if (part.type === "tool_result") {
        const c = part.content;
        if (!c) return "";
        if (typeof c === "string") return c;
        return c.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
      }
      // Skip tool_use and thinking blocks — they're in assistant messages
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export const anthropicMessagesAdapter: ClientAdapter<AnthropicMessagesRequest, AnthropicMessagesResponse> = {
  toLLMRequest(input: AnthropicMessagesRequest, _context: GatewayRequestContext): LLMRequest {
    const messages: LLMMessage[] = input.messages.map((m) => {
      // User messages that are exclusively tool_result blocks → mark as role "tool"
      // so classifyRequest correctly detects in-progress tool loops.
      if (m.role === "user" && Array.isArray(m.content) && m.content.length > 0
          && m.content.every((b) => b.type === "tool_result")) {
        const text = m.content
          .map((b) => normalizeContent([b]))
          .filter(Boolean)
          .join("\n");
        return {
          role: "user" as const,
          content: text || "(empty tool result)",
          toolResults: m.content.map((b) => ({
            id: b.tool_use_id ?? "unknown_tool",
            output: normalizeContent([b]) || "(empty tool result)",
          })),
        };
      }
      return { role: m.role, content: normalizeContent(m.content) };
    });

    const systemPrompt = Array.isArray(input.system)
      ? input.system.filter((b) => b.type === "text").map((b) => b.text ?? "").filter(Boolean).join("\n")
      : input.system;

    const request = normalizeGatewayLLMRequest({
      model: input.model,
      messages,
      systemPrompt,
      maxTokens: input.max_tokens,
      temperature: input.temperature,
      tools: input.tools?.map((tool) => toCanonicalTool(tool.name, tool.description, tool.input_schema)),
      stream: input.stream,
    }, _context);

    request.toolMode = toCanonicalToolMode(input.tool_choice);
    return request;
  },

  fromLLMResponse(output: LLMResponse): AnthropicMessagesResponse {
    const content: AnthropicMessagesResponse["content"] = output.outputText
      ? [{ type: "text", text: output.outputText }]
      : [];
    for (const toolCall of output.toolCalls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        input = { arguments: toolCall.function.arguments };
      }
      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.function.name,
        input,
      });
    }

    return {
      id: output.id,
      type: "message",
      role: "assistant",
      model: output.model,
      content: content.length ? content : [{ type: "text", text: "" }],
      stop_reason: output.stopReason ?? (output.toolCalls?.length ? "tool_use" : null),
      usage: output.usage
        ? {
            input_tokens: output.usage.inputTokens,
            output_tokens: output.usage.outputTokens,
            cache_read_input_tokens: output.usage.cachedInputTokens,
          }
        : undefined,
    };
  },

  fromLLMStream(stream: ReadableStream<string>, _context: GatewayRequestContext): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const msgId = `msg_${Date.now().toString(36)}`;

    function sse(event: string, data: unknown): Uint8Array {
      return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        // message_start
        controller.enqueue(sse("message_start", {
          type: "message_start",
          message: { id: msgId, type: "message", role: "assistant", content: [], model: "gateway-routed", stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
        }));
        controller.enqueue(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        controller.enqueue(sse("ping", { type: "ping" }));

        const reader = stream.getReader();
        let outputTokens = 0;
        let streamErr: unknown = null;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              controller.enqueue(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } }));
              outputTokens += Math.ceil(value.length / 4);
            }
          }
        } catch (err) {
          streamErr = err;
        } finally {
          reader.releaseLock();
        }

        if (streamErr) {
          const msg = streamErr instanceof Error ? streamErr.message : "Gateway provider stream error";
          controller.enqueue(sse("error", { type: "error", error: { type: "api_error", message: msg } }));
          controller.close();
          return;
        }

        controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
        controller.enqueue(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } }));
        controller.enqueue(sse("message_stop", { type: "message_stop" }));
        controller.close();
      },
    });
  },
};
