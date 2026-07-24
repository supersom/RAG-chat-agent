import { describe, expect, it } from "vitest";
import { ActivityRecord } from "./db/schema";
import {
  ActivityAccessError,
  filterVisibleActivitiesForRole,
  resolveActivityReadScope,
} from "./activity-scope";

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


describe("filterVisibleActivitiesForRole", () => {
  const activities = [
    { kind: "chat_turn", activityId: "chat" },
    { kind: "app_log", activityId: "log" },
  ] as ActivityRecord[];

  it("keeps app logs visible to admins", () => {
    expect(filterVisibleActivitiesForRole("admin", activities)).toEqual(activities);
  });

  it("hides app logs from end users", () => {
    expect(filterVisibleActivitiesForRole("end_user", activities)).toEqual([
      activities[0],
    ]);
  });
});
