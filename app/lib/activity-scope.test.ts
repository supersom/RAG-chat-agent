import { describe, expect, it } from "vitest";
import { ActivityAccessError, resolveActivityReadScope } from "./activity-scope";

describe("resolveActivityReadScope", () => {
  it("scopes end users to their own tenant/user key", () => {
    const scope = resolveActivityReadScope({
      sessionUser: { id: "user-a", role: "end_user", tenantId: "tenant-a" },
    });

    expect(scope).toEqual({
      kind: "tenant_user",
      tenantId: "tenant-a",
      userId: "user-a",
    });
  });

  it("blocks end users from requesting another user's activity", () => {
    expect(() =>
      resolveActivityReadScope({
        sessionUser: { id: "user-a", role: "end_user", tenantId: "tenant-a" },
        requestedUserId: "user-b",
      }),
    ).toThrow(new ActivityAccessError(403, "Forbidden"));
  });

  it("lets admins read the tenant-wide feed for only their tenant", () => {
    const scope = resolveActivityReadScope({
      sessionUser: { id: "admin-a", role: "admin", tenantId: "tenant-a" },
    });

    expect(scope).toEqual({ kind: "tenant", tenantId: "tenant-a" });
  });

  it("lets admins filter to a user in their own tenant", () => {
    const scope = resolveActivityReadScope({
      sessionUser: { id: "admin-a", role: "admin", tenantId: "tenant-a" },
      requestedUserId: "user-a",
      requestedUser: { userId: "user-a", tenantId: "tenant-a" },
    });

    expect(scope).toEqual({
      kind: "tenant_user",
      tenantId: "tenant-a",
      userId: "user-a",
    });
  });

  it("does not let admins filter to a user from another tenant", () => {
    expect(() =>
      resolveActivityReadScope({
        sessionUser: { id: "admin-a", role: "admin", tenantId: "tenant-a" },
        requestedUserId: "user-b",
        requestedUser: { userId: "user-b", tenantId: "tenant-b" },
      }),
    ).toThrow(new ActivityAccessError(404, "User not found"));
  });
});
