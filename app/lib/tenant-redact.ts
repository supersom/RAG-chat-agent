import type { Tenant, LlmProvider } from "@/app/lib/db/schema";

export type RedactedTenant = Omit<Tenant, "llmProviderDefaults"> & {
  llmProviderDefaults: {
    provider?: LlmProvider;
    model?: string;
    allowedModels?: string[];
    apiKeyConfigured: boolean;
  };
};

export function redactTenant(tenant: Tenant): RedactedTenant {
  const { llmProviderDefaults, ...rest } = tenant;
  return {
    ...rest,
    llmProviderDefaults: {
      provider: llmProviderDefaults?.provider,
      model: llmProviderDefaults?.model,
      allowedModels: llmProviderDefaults?.allowedModels,
      apiKeyConfigured: Boolean(llmProviderDefaults?.apiKeyCiphertext),
    },
  };
}
