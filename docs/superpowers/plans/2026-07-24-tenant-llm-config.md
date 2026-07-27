# Per-Tenant LLM Provider/Key/Model Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each tenant configure its own LLM provider, API key, and allowed-models list, taking precedence over the main app's server-configured defaults, which in turn take precedence over the existing dev-only client-supplied key.

**Architecture:** A new `resolveLlmConfig()` pure function implements the three-tier priority (tenant config → main-app server env vars → dev-only client key) as a single bundled decision, backed by a new AES-256-GCM encryption module for at-rest tenant API keys. The admin tenant-settings UI and API gain a provider selector and masked key field; new tenants no longer get a hardcoded provider/model.

**Tech Stack:** Next.js 14 (App Router), TypeScript, Zod, Vitest, Node's built-in `crypto`, DynamoDB (`@aws-sdk/lib-dynamodb`), `litellm`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-tenant-llm-config-design.md` — read it before starting; every task below implements a section of it.
- Vitest only picks up tests under `app/lib/**/*.test.ts` (see `vitest.config.ts:12`) — all new unit tests must live there, not under `app/api/` or `components/`.
- Tier-3 (client-supplied key) gating uses `process.env.NEXT_PUBLIC_APP_ENV === "development"`, **not** `NODE_ENV` (see spec's corrected section — `NODE_ENV` is always `"production"` under `next build`, including this repo's own preview Amplify deployments).
- Never log or return a tenant's decrypted API key or its ciphertext to any client response — this includes props passed from a Server Component to a Client Component, which Next.js serializes into the page payload just like an API response.
- `TENANT_SECRETS_KEY` must be a 32-byte value, base64-encoded, for AES-256-GCM.
- Follow existing code style: no comments except where a non-obvious constraint needs explaining (see e.g. `app/lib/tenant.ts`'s existing comments for the house style).

---

## Task 1: Tenant schema — optional, partial LLM config

**Files:**
- Modify: `app/lib/db/schema.ts`

**Interfaces:**
- Produces: `LlmProvider` type (`"openai" | "anthropic" | "openrouter"`), and `Tenant.llmProviderDefaults` becomes `{ provider?: LlmProvider; apiKeyCiphertext?: string; model?: string; allowedModels?: string[]; } | undefined` (the whole object, and every field inside it, optional). All later tasks read/write this shape.

- [ ] **Step 1: Update the schema**

Replace the whole file content with:

```ts
export type LlmProvider = "openai" | "anthropic" | "openrouter";

export interface Tenant {
  tenantId: string;
  name: string;
  knowledgeBaseId: string;
  llmProviderDefaults?: {
    provider?: LlmProvider;
    apiKeyCiphertext?: string;
    model?: string;
    allowedModels?: string[];
  };
  requireEndUserAuth: boolean;
  guardrailId: string;
  guardrailVersion: string;
  allowedOrigins?: string[];
  awsCredentialsSecretArn?: string;
  amplifyAppId?: string;
  awsRegion?: string;
  createdAt: string;
}

export interface User {
  userId: string;
  email: string;
  passwordHash: string;
  role: "admin" | "end_user";
  tenantId: string;
  createdAt: string;
}
```

- [ ] **Step 2: Typecheck to find every call site that needs updating**

Run: `npx tsc --noEmit`
Expected: Errors in `app/lib/tenant.ts`, `app/api/admin/tenant/route.ts`, `app/api/admin/signup/route.ts`, `app/admin/page.tsx`, `components/admin/TenantSettingsForm.tsx`, `app/api/chat/route.ts` — these are exactly the files fixed in Tasks 2–8 below. `app/lib/tenant.test.ts` should NOT error (it already passes full `{provider, model}` objects, which remain valid under the new optional type).

- [ ] **Step 3: Commit**

```bash
git add app/lib/db/schema.ts
git commit -m "Make tenant llmProviderDefaults optional/partial, add LlmProvider type"
```

---

## Task 2: API key encryption module

**Files:**
- Create: `app/lib/tenant-secrets.ts`
- Test: `app/lib/tenant-secrets.test.ts`

**Interfaces:**
- Produces: `encryptApiKey(plaintext: string): string`, `decryptApiKey(ciphertext: string): string`. Task 4 (`resolveLlmConfig`) and Task 6 (admin route) call these.
- Consumes: `process.env.TENANT_SECRETS_KEY` (32-byte, base64).

- [ ] **Step 1: Write the failing tests**

```ts
// app/lib/tenant-secrets.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { encryptApiKey, decryptApiKey } from "./tenant-secrets";

function stubKey() {
  const key = crypto.randomBytes(32).toString("base64");
  process.env.TENANT_SECRETS_KEY = key;
  return key;
}

beforeEach(() => {
  delete process.env.TENANT_SECRETS_KEY;
});

afterEach(() => {
  delete process.env.TENANT_SECRETS_KEY;
});

describe("encryptApiKey / decryptApiKey", () => {
  it("round-trips a plaintext key", () => {
    stubKey();
    const ciphertext = encryptApiKey("sk-ant-super-secret-value");
    expect(ciphertext).not.toContain("sk-ant-super-secret-value");
    expect(decryptApiKey(ciphertext)).toBe("sk-ant-super-secret-value");
  });

  it("produces different ciphertext for the same plaintext on repeated calls", () => {
    stubKey();
    const a = encryptApiKey("same-value");
    const b = encryptApiKey("same-value");
    expect(a).not.toBe(b);
    expect(decryptApiKey(a)).toBe("same-value");
    expect(decryptApiKey(b)).toBe("same-value");
  });

  it("throws when the ciphertext has been tampered with", () => {
    stubKey();
    const ciphertext = encryptApiKey("sk-real-value");
    const raw = Buffer.from(ciphertext, "base64");
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString("base64");
    expect(() => decryptApiKey(tampered)).toThrow();
  });

  it("throws when decrypting with a different key than it was encrypted with", () => {
    stubKey();
    const ciphertext = encryptApiKey("sk-real-value");
    stubKey();
    expect(() => decryptApiKey(ciphertext)).toThrow();
  });

  it("throws when TENANT_SECRETS_KEY is not configured", () => {
    expect(() => encryptApiKey("value")).toThrow("TENANT_SECRETS_KEY");
    expect(() => decryptApiKey("aGVsbG8=")).toThrow("TENANT_SECRETS_KEY");
  });

  it("throws when TENANT_SECRETS_KEY doesn't decode to 32 bytes", () => {
    process.env.TENANT_SECRETS_KEY = Buffer.from("too-short").toString("base64");
    expect(() => encryptApiKey("value")).toThrow("32 bytes");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/lib/tenant-secrets.test.ts`
Expected: FAIL — `Cannot find module './tenant-secrets'`

- [ ] **Step 3: Implement the module**

```ts
// app/lib/tenant-secrets.ts
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = process.env.TENANT_SECRETS_KEY;
  if (!raw) {
    throw new Error("TENANT_SECRETS_KEY is not configured");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("TENANT_SECRETS_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function encryptApiKey(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptApiKey(ciphertextB64: string): string {
  const key = getKey();
  const raw = Buffer.from(ciphertextB64, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/tenant-secrets.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add app/lib/tenant-secrets.ts app/lib/tenant-secrets.test.ts
git commit -m "Add AES-256-GCM encryption module for tenant API keys"
```

---

## Task 3: Shared model-list parser

**Files:**
- Create: `app/lib/models.ts`
- Modify: `components/ChatArea.tsx:296-302`
- Test: `app/lib/models.test.ts`

**Interfaces:**
- Produces: `type Model = { id: string; name: string }`, `parseModelList(source: string): Model[]`. Task 4 (`resolveLlmConfig`) and `ChatArea.tsx` both use this.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/models.test.ts
import { describe, it, expect } from "vitest";
import { parseModelList } from "./models";

describe("parseModelList", () => {
  it("parses id:name pairs separated by commas", () => {
    expect(
      parseModelList("gpt-4o-mini:GPT-4o Mini,gpt-4o:GPT-4o"),
    ).toEqual([
      { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      { id: "gpt-4o", name: "GPT-4o" },
    ]);
  });

  it("trims whitespace around entries", () => {
    expect(parseModelList(" gpt-4o : GPT-4o ")).toEqual([
      { id: "gpt-4o", name: "GPT-4o" },
    ]);
  });

  it("joins a name containing a colon back together", () => {
    expect(parseModelList("openrouter/anthropic/claude-sonnet-4-6:Claude: Sonnet 4.6")).toEqual([
      { id: "openrouter/anthropic/claude-sonnet-4-6", name: "Claude: Sonnet 4.6" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/models.test.ts`
Expected: FAIL — `Cannot find module './models'`

- [ ] **Step 3: Implement the parser**

```ts
// app/lib/models.ts
export type Model = { id: string; name: string };

export function parseModelList(source: string): Model[] {
  return source.split(",").map((entry) => {
    const [id, ...nameParts] = entry.trim().split(":");
    return { id: id.trim(), name: nameParts.join(":").trim() };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/models.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Update `ChatArea.tsx` to use the shared parser**

In `components/ChatArea.tsx`, add the import near the top with the other `@/` imports:

```ts
import { parseModelList, type Model } from "@/app/lib/models";
```

Remove the now-duplicate local type declaration (around line 187-191):

```ts
// Define a type for the model
type Model = {
  id: string;
  name: string;
};
```

Replace (around line 296-302):

```ts
  const modelsSource = uiSettings.models || process.env.NEXT_PUBLIC_MODELS || "claude-haiku-4-5-20251001:Claude Haiku 4.5";
  const models: Model[] = modelsSource
    .split(",")
    .map((entry) => {
      const [id, ...nameParts] = entry.trim().split(":");
      return { id, name: nameParts.join(":") };
    });
```

with:

```ts
  const modelsSource = uiSettings.models || process.env.NEXT_PUBLIC_MODELS || "claude-haiku-4-5-20251001:Claude Haiku 4.5";
  const models: Model[] = parseModelList(modelsSource);
```

- [ ] **Step 6: Confirm the app still builds**

Run: `npx tsc --noEmit`
Expected: No new errors introduced by this task (pre-existing errors from Task 1's schema change are expected and are fixed in later tasks).

- [ ] **Step 7: Commit**

```bash
git add app/lib/models.ts app/lib/models.test.ts components/ChatArea.tsx
git commit -m "Extract model-list parsing into a shared app/lib/models.ts util"
```

---

## Task 4: `resolveLlmConfig` — three-tier resolution

**Files:**
- Create: `app/lib/llm-config.ts`
- Test: `app/lib/llm-config.test.ts`

**Interfaces:**
- Consumes: `Tenant["llmProviderDefaults"]` (Task 1), `decryptApiKey` (Task 2), `parseModelList` (Task 3), `process.env.OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `NEXT_PUBLIC_MODELS` / `NEXT_PUBLIC_APP_ENV`.
- Produces: `type LlmConfig = { provider: string; apiKey: string; model: string; allowedModels: string[] }`, `resolveLlmConfig(llmProviderDefaults: Tenant["llmProviderDefaults"], clientApiKey?: string): LlmConfig | null`. Task 7 (`/api/chat/route.ts`) is the consumer.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/lib/llm-config.test.ts`
Expected: FAIL — `Cannot find module './llm-config'`

- [ ] **Step 3: Implement `resolveLlmConfig`**

```ts
// app/lib/llm-config.ts
import { Tenant } from "@/app/lib/db/schema";
import { decryptApiKey } from "@/app/lib/tenant-secrets";
import { parseModelList } from "@/app/lib/models";

export type LlmConfig = {
  provider: string;
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/llm-config.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add app/lib/llm-config.ts app/lib/llm-config.test.ts
git commit -m "Add resolveLlmConfig implementing the three-tier LLM resolution order"
```

---

## Task 5: Shared tenant redaction utility

**Files:**
- Create: `app/lib/tenant-redact.ts`
- Test: `app/lib/tenant-redact.test.ts`

**Context:** Two different places send a `Tenant` object out of the server: `GET /api/admin/tenant`'s JSON response, and `app/admin/page.tsx` (a Server Component) passing `tenant` as a prop into `TenantSettingsForm` (a Client Component). Next.js serializes Server→Client Component props into the page's payload exactly like an API response body — so both call sites need the same redaction, not just the API route. A single shared function is the only way to guarantee they don't drift apart.

**Interfaces:**
- Produces: `type RedactedTenant = Omit<Tenant, "llmProviderDefaults"> & { llmProviderDefaults: { provider?: LlmProvider; model?: string; allowedModels?: string[]; apiKeyConfigured: boolean } }`, `redactTenant(tenant: Tenant): RedactedTenant`. Task 6 (`/api/admin/tenant/route.ts`) and Task 8 (`app/admin/page.tsx`, `TenantSettingsForm.tsx`) both consume this.

- [ ] **Step 1: Write the failing tests**

```ts
// app/lib/tenant-redact.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/lib/tenant-redact.test.ts`
Expected: FAIL — `Cannot find module './tenant-redact'`

- [ ] **Step 3: Implement the utility**

```ts
// app/lib/tenant-redact.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/tenant-redact.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add app/lib/tenant-redact.ts app/lib/tenant-redact.test.ts
git commit -m "Add shared tenant redaction utility to keep API key ciphertext off the client"
```

---

## Task 6: Admin tenant API — provider, key, and redaction

**Files:**
- Modify: `app/api/admin/tenant/route.ts`

**Interfaces:**
- Consumes: `encryptApiKey` (Task 2), `redactTenant` (Task 5), `Tenant` type (Task 1).
- Produces: `GET /api/admin/tenant` response shape adds `llmProviderDefaults.apiKeyConfigured: boolean` and never includes `apiKeyCiphertext`. `PATCH /api/admin/tenant` accepts `llmProviderDefaults.apiKey?: string | null` (plaintext; omitted = unchanged, `""` or `null` = clear, non-empty = set) alongside `provider`/`model`/`allowedModels`, and 400s if the merged result would have a key but no provider/model.

- [ ] **Step 1: Update the route**

Replace the full file content:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getTenant, updateTenant } from "@/app/lib/db/tenants";
import { encryptApiKey } from "@/app/lib/tenant-secrets";
import { redactTenant } from "@/app/lib/tenant-redact";
import type { Tenant } from "@/app/lib/db/schema";

const editableTenantSchema = z
  .object({
    knowledgeBaseId: z.string().optional(),
    requireEndUserAuth: z.boolean().optional(),
    guardrailId: z.string().optional(),
    guardrailVersion: z.string().optional(),
    allowedOrigins: z.array(z.string()).optional(),
    amplifyAppId: z.string().optional(),
    awsRegion: z.string().optional(),
    llmProviderDefaults: z
      .object({
        provider: z.enum(["openai", "anthropic", "openrouter"]).optional(),
        model: z.string().optional(),
        allowedModels: z.array(z.string()).optional(),
        apiKey: z.string().nullable().optional(),
      })
      .optional(),
  })
  .strict();

export async function GET() {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenant = await getTenant(session.user.tenantId);
  if (!tenant) {
    return Response.json({ error: "Tenant not found" }, { status: 404 });
  }

  return NextResponse.json(redactTenant(tenant));
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = editableTenantSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await getTenant(session.user.tenantId);
  if (!existing) {
    return Response.json({ error: "Tenant not found" }, { status: 404 });
  }

  const { llmProviderDefaults: patchDefaults, ...rest } = parsed.data;

  let llmProviderDefaults: Tenant["llmProviderDefaults"] = existing.llmProviderDefaults;

  if (patchDefaults) {
    const { apiKey, ...fieldPatch } = patchDefaults;

    const merged: NonNullable<Tenant["llmProviderDefaults"]> = {
      ...(existing.llmProviderDefaults ?? {}),
      ...fieldPatch,
    };

    if (apiKey === null || apiKey === "") {
      delete merged.apiKeyCiphertext;
    } else if (apiKey) {
      merged.apiKeyCiphertext = encryptApiKey(apiKey);
    }

    if (merged.apiKeyCiphertext && (!merged.provider || !merged.model)) {
      return NextResponse.json(
        {
          error:
            "A provider and model must be set together with an API key.",
        },
        { status: 400 },
      );
    }

    llmProviderDefaults = merged;
  }

  const updated = await updateTenant(session.user.tenantId, {
    ...rest,
    llmProviderDefaults,
  });

  return NextResponse.json(redactTenant(updated));
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors in `app/api/admin/tenant/route.ts`. Errors remaining in `app/api/admin/signup/route.ts`, `app/admin/page.tsx`, `components/admin/TenantSettingsForm.tsx`, `app/api/chat/route.ts` are expected and fixed in Tasks 7–8.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/tenant/route.ts
git commit -m "Add provider/apiKey fields to admin tenant API with redaction and clearing"
```

---

## Task 7: Wire `resolveLlmConfig` into `/api/chat`

**Files:**
- Modify: `app/api/chat/route.ts:94-100` (model resolution) and `:294-311` (LLM call)

**Interfaces:**
- Consumes: `resolveLlmConfig` (Task 4).

- [ ] **Step 1: Replace the model/key resolution logic**

Remove (around line 94-100):

```ts
  const allowedModels = tenant.llmProviderDefaults.allowedModels ?? [
    tenant.llmProviderDefaults.model,
  ];
  const resolvedModel =
    model && allowedModels.includes(model)
      ? model
      : tenant.llmProviderDefaults.model;
```

Add the import near the top of the file (with the other `@/` imports):

```ts
import { resolveLlmConfig } from "@/app/lib/llm-config";
```

Insert in its place, right after `const tenant = tenantResult;`:

```ts
  const llmConfig = resolveLlmConfig(tenant.llmProviderDefaults, clientApiKey);
  if (!llmConfig) {
    return Response.json(
      { error: "No LLM provider configured for this tenant" },
      { status: 500 },
    );
  }

  const resolvedModel =
    model && llmConfig.allowedModels.includes(model)
      ? model
      : llmConfig.model;
```

- [ ] **Step 2: Replace the `completion()` call's key resolution**

Remove (around line 294-303):

```ts
    const { completion } = await import("litellm");
    // TEMPORARY: client-supplied key takes priority over server env vars
    // while this deployment has no real server-side LLM credential
    // configured. Not tenant-scoped -- see BACKLOG.md, this needs removing
    // once a real key is provisioned server-side.
    const resolvedApiKey =
      clientApiKey ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENROUTER_API_KEY;
```

Replace with:

```ts
    const { completion } = await import("litellm");
```

Update the `completion(...)` call's `apiKey` field (around line 305-312):

```ts
    const response = await (completion as any)({
      model: resolvedModel,
      max_tokens: 1000,
      messages: litellmMessages,
      temperature: 0.3,
      apiKey: llmConfig.apiKey,
      response_format: { type: "json_object" },
    });
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors in `app/api/chat/route.ts`. Errors remaining in `app/api/admin/signup/route.ts`, `app/admin/page.tsx`, and `components/admin/TenantSettingsForm.tsx` are fixed in Task 8.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: All existing tests still pass (11 tests, plus the new ones from Tasks 2, 3, 4, and 5).

- [ ] **Step 5: Commit**

```bash
git add app/api/chat/route.ts
git commit -m "Resolve LLM provider/key/model via resolveLlmConfig in /api/chat"
```

---

## Task 8: Fix signup defaults; redact + extend the admin settings page/form

**Files:**
- Modify: `app/api/admin/signup/route.ts:35-46`
- Modify: `app/admin/page.tsx`
- Modify: `components/admin/TenantSettingsForm.tsx`

**Interfaces:**
- Consumes: `redactTenant`/`RedactedTenant` (Task 5).

- [ ] **Step 1: Stop hardcoding provider/model at signup**

In `app/api/admin/signup/route.ts`, replace:

```ts
  const tenant = await createTenant({
    tenantId: ulid(),
    name: tenantName,
    knowledgeBaseId: process.env.NEXT_PUBLIC_KNOWLEDGE_BASE_ID || "",
    llmProviderDefaults: {
      provider: "openai",
      model: "gpt-4o-mini",
    },
    requireEndUserAuth: false,
    guardrailId: "",
    guardrailVersion: "",
  });
```

with:

```ts
  const tenant = await createTenant({
    tenantId: ulid(),
    name: tenantName,
    knowledgeBaseId: process.env.NEXT_PUBLIC_KNOWLEDGE_BASE_ID || "",
    llmProviderDefaults: {},
    requireEndUserAuth: false,
    guardrailId: "",
    guardrailVersion: "",
  });
```

- [ ] **Step 2: Redact the tenant before it reaches the client component**

In `app/admin/page.tsx`, add the import:

```ts
import { redactTenant } from "@/app/lib/tenant-redact";
```

Replace:

```tsx
      <TenantSettingsForm tenant={tenant} />
```

with:

```tsx
      <TenantSettingsForm tenant={redactTenant(tenant)} />
```

- [ ] **Step 3: Update `TenantSettingsForm.tsx`'s prop type**

Replace:

```ts
import type { Tenant } from "@/app/lib/db/schema";
```

with:

```ts
import type { RedactedTenant } from "@/app/lib/tenant-redact";
```

Replace:

```ts
interface TenantSettingsFormProps {
  tenant: Tenant;
}
```

with:

```ts
interface TenantSettingsFormProps {
  tenant: RedactedTenant;
}
```

- [ ] **Step 4: Add provider selector and API key field to the form**

Replace the state initialization (around line 44-49):

```ts
  const [model, setModel] = useState(tenant.llmProviderDefaults.model);
  const [allowedModels, setAllowedModels] = useState(
    (tenant.llmProviderDefaults.allowedModels ?? []).join(", "),
  );
  const [amplifyAppId, setAmplifyAppId] = useState(tenant.amplifyAppId ?? "");
  const [awsRegion, setAwsRegion] = useState(tenant.awsRegion ?? "");
```

with:

```ts
  const [provider, setProvider] = useState(
    tenant.llmProviderDefaults.provider ?? "openai",
  );
  const [model, setModel] = useState(tenant.llmProviderDefaults.model ?? "");
  const [allowedModels, setAllowedModels] = useState(
    (tenant.llmProviderDefaults.allowedModels ?? []).join(", "),
  );
  const [apiKey, setApiKey] = useState("");
  const apiKeyConfigured = tenant.llmProviderDefaults.apiKeyConfigured;
  const [clearApiKey, setClearApiKey] = useState(false);
  const [amplifyAppId, setAmplifyAppId] = useState(tenant.amplifyAppId ?? "");
  const [awsRegion, setAwsRegion] = useState(tenant.awsRegion ?? "");
```

Replace the submit body's `llmProviderDefaults` (around line 72-76):

```ts
        llmProviderDefaults: {
          provider: tenant.llmProviderDefaults.provider,
          model,
          allowedModels: parseList(allowedModels),
        },
```

with:

```ts
        llmProviderDefaults: {
          provider,
          model,
          allowedModels: parseList(allowedModels),
          apiKey: clearApiKey ? null : apiKey || undefined,
        },
```

Add the provider select and API key field to the form, right before the existing "Model" field block (around line 189):

```tsx
          <div className="flex flex-col gap-1">
            <label htmlFor="provider" className="text-sm font-medium">
              Provider
            </label>
            <select
              id="provider"
              value={provider}
              onChange={(e) =>
                setProvider(e.target.value as "openai" | "anthropic" | "openrouter")
              }
              className="border rounded-md px-3 py-2 text-sm bg-background"
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="apiKey" className="text-sm font-medium">
              API Key
            </label>
            <Input
              id="apiKey"
              type="password"
              placeholder={
                apiKeyConfigured && !clearApiKey
                  ? "Configured (leave blank to keep)"
                  : "sk-..."
              }
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setClearApiKey(false);
              }}
            />
            {apiKeyConfigured && (
              <label className="flex items-center gap-2 cursor-pointer w-fit text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={clearApiKey}
                  onChange={(e) => {
                    setClearApiKey(e.target.checked);
                    if (e.target.checked) setApiKey("");
                  }}
                  className="h-3 w-3 accent-primary"
                />
                Clear the configured key (fall back to the main app&apos;s
                default provider)
              </label>
            )}
          </div>
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors anywhere in the project.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add app/api/admin/signup/route.ts app/admin/page.tsx components/admin/TenantSettingsForm.tsx
git commit -m "Stop hardcoding signup LLM defaults; redact tenant before it reaches the client form"
```

---

## Task 9: Env var wiring for `TENANT_SECRETS_KEY`

**Files:**
- Modify: `.env.example`
- Modify: `amplify.yml`

**Interfaces:**
- Consumes: nothing new. Produces: documented env var for local dev and the Amplify build.

- [ ] **Step 1: Document the env var locally**

In `.env.example`, add to the `## Auth & Multi-tenancy` section (after `DYNAMODB_USERS_TABLE`):

```
TENANT_SECRETS_KEY=your-32-byte-base64-key # AES-256-GCM key for encrypting tenant LLM API keys at rest; generate with: openssl rand -base64 32
```

- [ ] **Step 2: Add it to the Amplify build**

In `amplify.yml`, add this line to the `build.commands` list, alongside the other `echo ... >> .env.production` lines (keep alphabetical order with the existing block, i.e. right after the `TENANT_JWT_SECRET` line):

```yaml
        - echo "TENANT_SECRETS_KEY=$TENANT_SECRETS_KEY" >> .env.production
```

- [ ] **Step 3: Generate a local dev key and add it to `.env.local`**

Run: `openssl rand -base64 32`
Add the output as `TENANT_SECRETS_KEY=<generated-value>` to `.env.local` (do not commit `.env.local` — it's already gitignored).

- [ ] **Step 4: Commit**

```bash
git add .env.example amplify.yml
git commit -m "Wire TENANT_SECRETS_KEY into env docs and the Amplify build"
```

(`.env.local` is intentionally not committed — verify with `git status` that it doesn't appear as a tracked change.)

---

## Task 10: Full local verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass (existing 11 + new tests from Tasks 2, 3, 4, and 5, ~29 total).

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 4: Manual smoke test locally**

Run: `npm run dev`, sign in as an admin, open tenant settings:
- Confirm the Provider dropdown and API Key field render.
- Save a real API key for a provider you have credentials for; confirm the field shows "Configured (leave blank to keep)" placeholder after reload and never displays the raw key.
- Check the page source / React DevTools props for `TenantSettingsForm` and confirm no ciphertext is present anywhere in the payload.
- Send a chat message; confirm it now uses the tenant's own key (check server logs / behavior matches the chosen provider).
- Use the "Clear the configured key" checkbox, save, and confirm chat still works via the main app's env-var fallback.

---

## Task 11: Provision `TENANT_SECRETS_KEY` on Amplify app `d2l47euepvccx6` and deploy

**Files:** none (infrastructure/deployment only)

**Context:** Per `DEVLOG.md`'s 2026-07-24 entry, a new required env var does not propagate anywhere except wherever it's explicitly provisioned — provisioning against one Amplify app does not cover another. This branch's target for QA is app `d2l47euepvccx6` (`customer-support-agent-auth-preview2`, region `us-east-2`).

- [ ] **Step 1: Generate a production key**

Run: `openssl rand -base64 32`
Save the output somewhere secure (e.g. a password manager) — this is the encryption key for every tenant API key stored on this app going forward; losing it makes stored tenant keys unrecoverable.

- [ ] **Step 2: Confirm before touching AWS state**

Stop and confirm with the user before running the next step — it modifies a real Amplify app's configuration.

- [ ] **Step 3: Add the env var to the Amplify app**

```bash
aws amplify update-app \
  --app-id d2l47euepvccx6 \
  --region us-east-2 \
  --environment-variables \
    ANTHROPIC_API_KEY="your-anthropic-api-key",AUTH_SECRET="VHDPBffnaWY2GGj0QTwpuPMHSYfqWO6Iv0zSN7jZaVw=",BAWS_ACCESS_KEY_ID="REDACTED-AWS-ACCESS-KEY-ID",BAWS_SECRET_ACCESS_KEY="REDACTED-AWS-SECRET-ACCESS-KEY",BEDROCK_GUARDRAIL_ID="fvsirf90zt71",BEDROCK_GUARDRAIL_VERSION="1",COMPANY_NAME="Acme Support",DYNAMODB_TENANTS_TABLE="CustomerSupportAgent-Tenants",DYNAMODB_USERS_TABLE="CustomerSupportAgent-Users",KNOWLEDGE_BASE_ID="SLXQFWWXPR",NEXT_PUBLIC_APP_ENV="development",NEXT_PUBLIC_KNOWLEDGE_BASE_ID="SLXQFWWXPR",NEXT_PUBLIC_MODELS="claude-haiku-4-5-20251001:Claude Haiku 4.5,claude-sonnet-4-6:Claude Sonnet 4.6",TENANT_JWT_SECRET="deMqnaaY8BmwzNicFCIp4E6rd9hFLh2hWy40gz8GW0U=",TENANT_SECRETS_KEY="<generated-value-from-step-1>"
```

`update-app --environment-variables` replaces the full map, so every existing var must be re-sent alongside the new one (values captured live from the app on 2026-07-24 — re-fetch with `aws amplify get-app --app-id d2l47euepvccx6 --region us-east-2 --query 'app.environmentVariables'` first if this plan is executed much later, in case they've since changed).

- [ ] **Step 4: Verify it landed**

```bash
aws amplify get-app --app-id d2l47euepvccx6 --region us-east-2 --query 'app.environmentVariables.TENANT_SECRETS_KEY'
```

Expected: the same value from Step 1.

- [ ] **Step 5: Create the Amplify branch for this feature branch**

```bash
aws amplify create-branch \
  --app-id d2l47euepvccx6 \
  --region us-east-2 \
  --branch-name worktree-tenant-llm-config \
  --stage NONE \
  --framework "Next.js - SSR"
```

- [ ] **Step 6: Push the branch to trigger the build**

Confirm with the user before pushing (this is a `git push`).

```bash
git push -u origin worktree-tenant-llm-config
```

- [ ] **Step 7: Watch the build and verify it succeeds**

```bash
aws amplify list-jobs --app-id d2l47euepvccx6 --branch-name worktree-tenant-llm-config --region us-east-2 --max-results 1
```

Poll until `status` is `SUCCEED` (or `FAILED`, in which case fetch build logs via the job's `logUrl` and debug before proceeding).

- [ ] **Step 8: Verify live**

Visit `https://worktree-tenant-llm-config.d2l47euepvccx6.amplifyapp.com`, sign in as an admin, and repeat the manual smoke test from Task 10 Step 4 against the real deployment.
