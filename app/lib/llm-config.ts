// app/lib/llm-config.ts
import { ActivityLlmProvider, Tenant } from "@/app/lib/db/schema";
import { decryptApiKey } from "@/app/lib/tenant-secrets";
import { parseModelList } from "@/app/lib/models";

export type LlmConfig = {
  provider: ActivityLlmProvider;
  apiKey: string;
  model: string;
  allowedModels: string[];
};

const FALLBACK_MODEL_SOURCE = "claude-haiku-4-5-20251001:Claude Haiku 4.5";

function defaultModelList(): { model: string; allowedModels: string[] } {
  const source = process.env.NEXT_PUBLIC_MODELS || FALLBACK_MODEL_SOURCE;
  const models = parseModelList(source);
  return {
    model: models[0]?.id ?? "claude-haiku-4-5-20251001",
    allowedModels: models.map((m) => m.id),
  };
}

function resolveServerDefaults(): LlmConfig | null {
  const { model, allowedModels } = defaultModelList();

  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", apiKey: process.env.OPENAI_API_KEY, model, allowedModels };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY, model, allowedModels };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return { provider: "openrouter", apiKey: process.env.OPENROUTER_API_KEY, model, allowedModels };
  }
  return null;
}

export function resolveLlmConfig(
  llmProviderDefaults: Tenant["llmProviderDefaults"],
  clientApiKey?: string,
): LlmConfig | null {
  if (llmProviderDefaults?.apiKeyCiphertext) {
    const model = llmProviderDefaults.model!;
    return {
      provider: llmProviderDefaults.provider!,
      apiKey: decryptApiKey(llmProviderDefaults.apiKeyCiphertext),
      model,
      allowedModels: llmProviderDefaults.allowedModels?.length
        ? llmProviderDefaults.allowedModels
        : [model],
    };
  }

  const serverDefaults = resolveServerDefaults();
  if (serverDefaults) {
    return serverDefaults;
  }

  if (clientApiKey && process.env.NEXT_PUBLIC_APP_ENV === "development") {
    const { model, allowedModels } = defaultModelList();
    return { provider: "unknown", apiKey: clientApiKey, model, allowedModels };
  }

  return null;
}
