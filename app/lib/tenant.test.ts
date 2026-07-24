import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/app/lib/db/tenants", () => ({
  getTenant: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { getTenant } from "@/app/lib/db/tenants";
import { auth } from "@/auth";
import {
  signTenantToken,
  verifyTenantToken,
  resolveTenantContext,
  isTenantResolutionError,
} from "./tenant";

const mockedGetTenant = vi.mocked(getTenant);
const mockedAuth = vi.mocked(auth);

beforeEach(() => {
  vi.stubEnv("TENANT_JWT_SECRET", "test-secret-at-least-32-bytes-long!!");
  mockedGetTenant.mockReset();
  mockedAuth.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signTenantToken / verifyTenantToken", () => {
  it("round-trips claims through sign and verify", async () => {
    const claims = {
      tenantId: "acme",
      allowedOrigins: ["https://acme.example"],
    };

    const token = await signTenantToken(claims);
    const verified = await verifyTenantToken(token);

    expect(verified).toMatchObject(claims);
  });

  it("returns null when the token was signed with a different secret", async () => {
    const token = await signTenantToken({ tenantId: "acme" });

    vi.stubEnv("TENANT_JWT_SECRET", "a-completely-different-secret-value");

    const verified = await verifyTenantToken(token);

    expect(verified).toBeNull();
  });

  it("returns null for an expired token", async () => {
    // jose's time-span parser only supports s/m/h/d/w/y units, not "ms", so
    // an already-expired token is built directly via a negative offset
    // rather than signing with a tiny TTL and waiting for it to lapse.
    const token = await signTenantToken(
      { tenantId: "acme" },
      { expiresIn: "-10s" },
    );

    const verified = await verifyTenantToken(token);

    expect(verified).toBeNull();
  });
});

describe("resolveTenantContext", () => {
  it("falls back to the dev tenant when NODE_ENV=development and no token header is sent", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BAWS_ACCESS_KEY_ID", "dev-access-key");
    vi.stubEnv("BAWS_SECRET_ACCESS_KEY", "dev-secret-key");

    const req = new Request("https://example.com/api/chat");

    const result = await resolveTenantContext(req);

    expect(isTenantResolutionError(result)).toBe(false);
    if (isTenantResolutionError(result)) throw new Error("unreachable");

    expect(result.tenantId).toBe("dev");
    expect(result.requireEndUserAuth).toBe(false);
    expect(result.awsCredentials).toEqual({
      accessKeyId: "dev-access-key",
      secretAccessKey: "dev-secret-key",
    });
    expect(mockedGetTenant).not.toHaveBeenCalled();
  });

  it("rejects with 403 when the request Origin isn't in the token's allowedOrigins", async () => {
    const token = await signTenantToken({
      tenantId: "acme",
      allowedOrigins: ["https://acme.example"],
    });

    const req = new Request("https://example.com/api/chat", {
      headers: {
        "x-tenant-token": token,
        origin: "https://evil.example",
      },
    });

    const result = await resolveTenantContext(req);

    expect(isTenantResolutionError(result)).toBe(true);
    if (!isTenantResolutionError(result)) throw new Error("unreachable");

    expect(result.status).toBe(403);
    expect(result.error).toBe("Origin not allowed");
    expect(mockedGetTenant).not.toHaveBeenCalled();
  });

  it("resolves the tenant from a logged-in session, ignoring any tenant token", async () => {
    vi.stubEnv("BAWS_ACCESS_KEY_ID", "session-access-key");
    vi.stubEnv("BAWS_SECRET_ACCESS_KEY", "session-secret-key");

    mockedAuth.mockResolvedValue({
      user: { role: "end_user", tenantId: "session-tenant" },
    } as any);
    mockedGetTenant.mockResolvedValue({
      tenantId: "session-tenant",
      name: "Session Tenant",
      knowledgeBaseId: "kb-session",
      llmProviderDefaults: { provider: "anthropic", model: "claude-sonnet-4-5" },
      requireEndUserAuth: true,
      guardrailId: "",
      guardrailVersion: "",
      createdAt: new Date().toISOString(),
    });

    // No x-tenant-token header at all -- a foreign token would be ignored
    // even if present, since the session already resolved a tenant.
    const req = new Request("https://example.com/api/chat", {
      headers: {
        "x-tenant-token": await signTenantToken({ tenantId: "some-other-tenant" }),
      },
    });

    const result = await resolveTenantContext(req);

    expect(isTenantResolutionError(result)).toBe(false);
    if (isTenantResolutionError(result)) throw new Error("unreachable");

    expect(result.tenantId).toBe("session-tenant");
    expect(mockedGetTenant).toHaveBeenCalledWith("session-tenant");
    expect(mockedGetTenant).toHaveBeenCalledTimes(1);
  });

  it("rejects an anonymous request to a tenant that requires end-user auth", async () => {
    const token = await signTenantToken({ tenantId: "acme" });
    mockedGetTenant.mockResolvedValue({
      tenantId: "acme",
      name: "Acme",
      knowledgeBaseId: "kb-acme",
      llmProviderDefaults: { provider: "anthropic", model: "claude-sonnet-4-5" },
      requireEndUserAuth: true,
      guardrailId: "",
      guardrailVersion: "",
      createdAt: new Date().toISOString(),
    });

    const req = new Request("https://example.com/api/chat", {
      headers: { "x-tenant-token": token },
    });

    const result = await resolveTenantContext(req);

    expect(isTenantResolutionError(result)).toBe(true);
    if (!isTenantResolutionError(result)) throw new Error("unreachable");

    expect(result.status).toBe(401);
    expect(result.error).toBe("Authentication required");
  });
});
