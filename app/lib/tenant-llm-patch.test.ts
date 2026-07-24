// app/lib/tenant-llm-patch.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/app/lib/tenant-secrets", () => ({
  encryptApiKey: vi.fn((plaintext: string) => `cipher:${plaintext}`),
}));

import { encryptApiKey } from "@/app/lib/tenant-secrets";
import { mergeLlmProviderDefaults } from "./tenant-llm-patch";

const mockedEncrypt = vi.mocked(encryptApiKey);

beforeEach(() => {
  mockedEncrypt.mockClear();
});

describe("mergeLlmProviderDefaults", () => {
  it("sets provider+model+apiKey together on an empty existing config", () => {
    const result = mergeLlmProviderDefaults(undefined, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "sk-live-abc",
    });

    expect(result).toEqual({
      ok: true,
      llmProviderDefaults: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKeyCiphertext: "cipher:sk-live-abc",
      },
    });
    expect(mockedEncrypt).toHaveBeenCalledWith("sk-live-abc");
  });

  it("preserves an existing key unchanged when apiKey is omitted from the patch", () => {
    const existing = {
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      apiKeyCiphertext: "cipher:existing-key",
    };

    const result = mergeLlmProviderDefaults(existing, {
      allowedModels: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    });

    expect(result).toEqual({
      ok: true,
      llmProviderDefaults: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKeyCiphertext: "cipher:existing-key",
        allowedModels: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
      },
    });
    expect(mockedEncrypt).not.toHaveBeenCalled();
  });

  it("clears an existing key when apiKey is null, even though provider/model remain", () => {
    const existing = {
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      apiKeyCiphertext: "cipher:existing-key",
    };

    const result = mergeLlmProviderDefaults(existing, { apiKey: null });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.llmProviderDefaults).not.toHaveProperty("apiKeyCiphertext");
      expect(result.llmProviderDefaults.provider).toBe("anthropic");
      expect(result.llmProviderDefaults.model).toBe("claude-sonnet-4-6");
    }
    expect(mockedEncrypt).not.toHaveBeenCalled();
  });

  it("clears an existing key when apiKey is an empty string, same as null", () => {
    const existing = {
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      apiKeyCiphertext: "cipher:existing-key",
    };

    const result = mergeLlmProviderDefaults(existing, { apiKey: "" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.llmProviderDefaults).not.toHaveProperty("apiKeyCiphertext");
    }
    expect(mockedEncrypt).not.toHaveBeenCalled();
  });

  it("rejects an apiKey set alone with no existing and no patched provider/model", () => {
    const result = mergeLlmProviderDefaults(undefined, {
      apiKey: "sk-live-abc",
    });

    expect(result).toEqual({
      ok: false,
      error: "A provider and model must be set together with an API key.",
    });
  });

  it("keeps the existing key/provider when patching only model on a full config", () => {
    const existing = {
      provider: "openai" as const,
      model: "gpt-4o-mini",
      apiKeyCiphertext: "cipher:existing-key",
    };

    const result = mergeLlmProviderDefaults(existing, { model: "gpt-4o" });

    expect(result).toEqual({
      ok: true,
      llmProviderDefaults: {
        provider: "openai",
        model: "gpt-4o",
        apiKeyCiphertext: "cipher:existing-key",
      },
    });
    expect(mockedEncrypt).not.toHaveBeenCalled();
  });
});
