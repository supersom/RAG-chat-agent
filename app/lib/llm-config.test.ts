// app/lib/llm-config.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/app/lib/tenant-secrets", () => ({
  decryptApiKey: vi.fn((ciphertext: string) => `decrypted:${ciphertext}`),
}));

import { decryptApiKey } from "@/app/lib/tenant-secrets";
import { resolveLlmConfig } from "./llm-config";

const mockedDecrypt = vi.mocked(decryptApiKey);

beforeEach(() => {
  mockedDecrypt.mockClear();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveLlmConfig", () => {
  it("tier 1: uses the tenant's own config when apiKeyCiphertext is set", () => {
    const result = resolveLlmConfig({
      provider: "anthropic",
      apiKeyCiphertext: "cipher-abc",
      model: "claude-sonnet-4-6",
      allowedModels: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    });

    expect(result).toEqual({
      provider: "anthropic",
      apiKey: "decrypted:cipher-abc",
      model: "claude-sonnet-4-6",
      allowedModels: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    });
    expect(mockedDecrypt).toHaveBeenCalledWith("cipher-abc");
  });

  it("tier 1: defaults allowedModels to [model] when the tenant didn't set an allow-list", () => {
    const result = resolveLlmConfig({
      provider: "openai",
      apiKeyCiphertext: "cipher-xyz",
      model: "gpt-4o-mini",
    });

    expect(result?.allowedModels).toEqual(["gpt-4o-mini"]);
  });

  it("tier 2: falls back to server env vars when the tenant has no key configured", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-server-key");
    vi.stubEnv("NEXT_PUBLIC_MODELS", "claude-sonnet-4-6:Sonnet,claude-haiku-4-5-20251001:Haiku");

    const result = resolveLlmConfig(undefined);

    expect(result).toEqual({
      provider: "anthropic",
      apiKey: "sk-server-key",
      model: "claude-sonnet-4-6",
      allowedModels: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    });
    expect(mockedDecrypt).not.toHaveBeenCalled();
  });

  it("tier 2: prefers OPENAI_API_KEY over ANTHROPIC_API_KEY over OPENROUTER_API_KEY", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-anthropic");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-openrouter");

    const result = resolveLlmConfig({});

    expect(result?.provider).toBe("openai");
    expect(result?.apiKey).toBe("sk-openai");
  });

  it("tier 2: uses the fallback default model when NEXT_PUBLIC_MODELS is unset", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");

    const result = resolveLlmConfig({});

    expect(result?.model).toBe("claude-haiku-4-5-20251001");
    expect(result?.allowedModels).toEqual(["claude-haiku-4-5-20251001"]);
  });

  it("tier 3: uses the client-supplied key only when NEXT_PUBLIC_APP_ENV=development and no tenant/server key exists", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");

    const result = resolveLlmConfig({}, "sk-client-supplied");

    expect(result?.apiKey).toBe("sk-client-supplied");
    expect(result?.provider).toBe("unknown");
  });

  it("tier 3: ignores the client-supplied key when NEXT_PUBLIC_APP_ENV is not development", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");

    const result = resolveLlmConfig({}, "sk-client-supplied");

    expect(result).toBeNull();
  });

  it("tier 3 never overrides tier 1 or tier 2 even when NEXT_PUBLIC_APP_ENV=development", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    vi.stubEnv("OPENAI_API_KEY", "sk-server-key");

    const result = resolveLlmConfig({}, "sk-client-supplied");

    expect(result?.apiKey).toBe("sk-server-key");
  });

  it("returns null when no tier resolves a key", () => {
    const result = resolveLlmConfig(undefined);
    expect(result).toBeNull();
  });
});
