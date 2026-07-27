import { describe, it, expect } from "vitest";
import { redactTenant } from "./tenant-redact";
import type { Tenant } from "./db/schema";

function baseTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    tenantId: "acme",
    name: "Acme",
    knowledgeBaseId: "kb-acme",
    requireEndUserAuth: false,
    guardrailId: "",
    guardrailVersion: "",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("redactTenant", () => {
  it("strips apiKeyCiphertext and replaces it with apiKeyConfigured: true", () => {
    const tenant = baseTenant({
      llmProviderDefaults: {
        provider: "anthropic",
        apiKeyCiphertext: "super-secret-ciphertext",
        model: "claude-sonnet-4-6",
        allowedModels: ["claude-sonnet-4-6"],
      },
    });

    const redacted = redactTenant(tenant);

    expect(redacted.llmProviderDefaults).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      allowedModels: ["claude-sonnet-4-6"],
      apiKeyConfigured: true,
    });
    expect(JSON.stringify(redacted)).not.toContain("super-secret-ciphertext");
  });

  it("reports apiKeyConfigured: false when the tenant has no llmProviderDefaults at all", () => {
    const tenant = baseTenant();

    const redacted = redactTenant(tenant);

    expect(redacted.llmProviderDefaults).toEqual({
      provider: undefined,
      model: undefined,
      allowedModels: undefined,
      apiKeyConfigured: false,
    });
  });

  it("preserves every other tenant field unchanged", () => {
    const tenant = baseTenant({ amplifyAppId: "d2l47euepvccx6" });

    const redacted = redactTenant(tenant);

    expect(redacted.tenantId).toBe("acme");
    expect(redacted.amplifyAppId).toBe("d2l47euepvccx6");
  });
});
