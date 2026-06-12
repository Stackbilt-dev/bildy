import { ClientName, LLMRequest, ModelCompatibility } from "../types.js";

export const defaultCompatibilityRegistry: ModelCompatibility[] = [
  {
    provider: "anthropic",
    model: "claude-sonnet-4",
    streaming: true,
    tools: true,
    claudeCodeSafe: true,
    codexSafe: "experimental",
  },
  {
    provider: "openai",
    model: "gpt-4o",
    streaming: true,
    tools: true,
    claudeCodeSafe: "experimental",
    codexSafe: true,
  },
  {
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    streaming: true,
    tools: true, // Groq supports function calling on versatile
    claudeCodeSafe: "experimental",
    codexSafe: true,
  },
  {
    provider: "cerebras",
    model: "openai/gpt-oss-120b",
    streaming: true,
    tools: true,
    claudeCodeSafe: "experimental",
    codexSafe: "experimental",
  },
  {
    provider: "cloudflare",
    model: "@cf/moonshotai/kimi-k2.6",
    streaming: true,
    tools: true,
    claudeCodeSafe: true,
    codexSafe: true,
  },
  {
    provider: "nvidia",
    model: "meta/llama-4-maverick-17b-128e-instruct",
    streaming: true,
    tools: true,
    claudeCodeSafe: "experimental",
    codexSafe: "experimental",
  },
];

export function selectCompatibleProvider(
  candidates: string[],
  request: LLMRequest,
  client: ClientName,
  experimentalModels: boolean,
): string {
  const needsTools = Boolean(request.tools?.length);
  const compatibleCandidates = candidates.filter((candidate) => {
    const entry = defaultCompatibilityRegistry.find((e) => e.provider === candidate);
    return entry && (!needsTools || entry.tools);
  });

  // Always prefer providers explicitly rated safe for the client, regardless of
  // whether experimental mode is on. Safe-first is unconditional.
  for (const candidate of compatibleCandidates) {
    const entry = defaultCompatibilityRegistry.find((e) => e.provider === candidate);
    const clientSafe = client === "claude-code" ? entry?.claudeCodeSafe : entry?.codexSafe;
    if (clientSafe === true) return candidate;
  }

  // If no safe provider matched and the caller has opted into experimental models,
  // accept providers rated "experimental" for this client.
  if (experimentalModels) {
    for (const candidate of compatibleCandidates) {
      const entry = defaultCompatibilityRegistry.find((e) => e.provider === candidate);
      const clientSafe = client === "claude-code" ? entry?.claudeCodeSafe : entry?.codexSafe;
      if (clientSafe === "experimental") return candidate;
    }
  }

  // Last resort: no rated-safe match and no experimental match — accept any
  // compatible candidate rather than hard-failing.
  for (const candidate of compatibleCandidates) {
    return candidate;
  }

  // Last resort
  if (needsTools) return "anthropic";
  return candidates[0] ?? "anthropic";
}
