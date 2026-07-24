import { describe, expect, it } from "vitest";
import { ActivityRecord } from "./db/schema";
import {
  ActivityAccessError,
  filterVisibleActivitiesForRole,
  resolveActivityLogReadScope,
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

  it("scopes admins to their own chat records by default", () => {
    const scope = resolveActivityReadScope({
      sessionUser: { id: "admin-a", role: "admin", tenantId: "tenant-a" },
    });

    expect(scope).toEqual({
      kind: "tenant_user",
      tenantId: "tenant-a",
      userId: "admin-a",
    });
  });

  it("cuts partial admin browsing of another user's chat records", () => {
    expect(() =>
      resolveActivityReadScope({
        sessionUser: { id: "admin-a", role: "admin", tenantId: "tenant-a" },
        requestedUserId: "user-a",
      }),
    ).toThrow(new ActivityAccessError(403, "Forbidden"));
  });
});

describe("resolveActivityLogReadScope", () => {
  it("lets admins read tenant-scoped app logs", () => {
    expect(
      resolveActivityLogReadScope({
        sessionUser: { id: "admin-a", role: "admin", tenantId: "tenant-a" },
      }),
    ).toEqual({ kind: "tenant_logs", tenantId: "tenant-a" });
  });

  it("blocks end users from tenant app logs", () => {
    expect(() =>
      resolveActivityLogReadScope({
        sessionUser: { id: "user-a", role: "end_user", tenantId: "tenant-a" },
      }),
    ).toThrow(new ActivityAccessError(403, "Forbidden"));
  });
});

describe("filterVisibleActivitiesForRole", () => {
  const activities = [
    { kind: "chat_turn", activityId: "chat" },
    { kind: "app_log", activityId: "log" },
  ] as ActivityRecord[];

  it("keeps app logs visible to admins", () => {
    expect(filterVisibleActivitiesForRole("admin", activities)).toEqual(
      activities,
    );
  });

  it("hides app logs from end users", () => {
    expect(filterVisibleActivitiesForRole("end_user", activities)).toEqual([
      activities[0],
    ]);
  });
});
