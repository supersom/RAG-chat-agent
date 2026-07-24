import { ActivityRecord } from "@/app/lib/db/schema";

export type ActivitySessionUser = {
  id: string;
  role: "admin" | "end_user";
  tenantId: string;
};

export type ActivityReadScope = {
  kind: "tenant_user";
  tenantId: string;
  userId: string;
};

export type ActivityLogReadScope = { kind: "tenant_logs"; tenantId: string };

export class ActivityAccessError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function resolveActivityReadScope({
  sessionUser,
  requestedUserId,
}: {
  sessionUser: ActivitySessionUser;
  requestedUserId?: string | null;
}): ActivityReadScope {
  if (requestedUserId && requestedUserId !== sessionUser.id) {
    throw new ActivityAccessError(403, "Forbidden");
  }

  return {
    kind: "tenant_user",
    tenantId: sessionUser.tenantId,
    userId: sessionUser.id,
  };
}

export function resolveActivityLogReadScope({
  sessionUser,
}: {
  sessionUser: ActivitySessionUser;
}): ActivityLogReadScope {
  if (sessionUser.role !== "admin") {
    throw new ActivityAccessError(403, "Forbidden");
  }

  return { kind: "tenant_logs", tenantId: sessionUser.tenantId };
}

export function filterVisibleActivitiesForRole(
  role: "admin" | "end_user",
  activities: ActivityRecord[],
): ActivityRecord[] {
  if (role === "admin") return activities;
  return activities.filter((activity) => activity.kind === "chat_turn");
}
