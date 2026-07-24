// app/lib/tenant-llm-patch.ts
import type { LlmProvider, Tenant } from "@/app/lib/db/schema";
import { encryptApiKey } from "@/app/lib/tenant-secrets";

export type LlmProviderPatch = {
  provider?: LlmProvider;
  model?: string;
  allowedModels?: string[];
  apiKey?: string | null;
};

export type MergeResult =
  | { ok: true; llmProviderDefaults: NonNullable<Tenant["llmProviderDefaults"]> }
  | { ok: false; error: string };

export function mergeLlmProviderDefaults(
  existing: Tenant["llmProviderDefaults"],
  patch: LlmProviderPatch,
): MergeResult {
  const { apiKey, ...fieldPatch } = patch;

  const merged: NonNullable<Tenant["llmProviderDefaults"]> = {
    ...(existing ?? {}),
    ...fieldPatch,
  };

  if (apiKey === null || apiKey === "") {
    delete merged.apiKeyCiphertext;
  } else if (apiKey) {
    merged.apiKeyCiphertext = encryptApiKey(apiKey);
  }

  if (merged.apiKeyCiphertext && (!merged.provider || !merged.model)) {
    return {
      ok: false,
      error: "A provider and model must be set together with an API key.",
    };
  }

  return { ok: true, llmProviderDefaults: merged };
}
