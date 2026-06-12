import { createHash } from "node:crypto";
import { LLMRequest } from "../types.js";

export function buildResponseCacheKey(request: LLMRequest): string {
  const payload = JSON.stringify({
    model: request.model,
    messages: request.messages,
    maxTokens: request.sampling?.maxTokens,
    temperature: request.sampling?.temperature,
  });
  const digest = createHash("sha256").update(payload).digest("hex").slice(0, 32);
  return `response:${digest}`;
}
