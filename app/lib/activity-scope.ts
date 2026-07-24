import { User } from "@/app/lib/db/schema";

export type ActivitySessionUser = {
  id: string;
  role: "admin" | "end_user";
  tenantId: string;
};

export type ActivityReadScope =
  | { kind: "tenant"; tenantId: string }
  | { kind: "tenant_user"; tenantId: string; userId: string };

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
  requestedUser,
}: {
  sessionUser: ActivitySessionUser;
  requestedUserId?: string | null;
  requestedUser?: Pick<User, "userId" | "tenantId"> | null;
}): ActivityReadScope {
  if (sessionUser.role !== "admin") {
    if (requestedUserId && requestedUserId !== sessionUser.id) {
      throw new ActivityAccessError(403, "Forbidden");
    }
    return {
      kind: "tenant_user",
      tenantId: sessionUser.tenantId,
      userId: sessionUser.id,
    };
  }

  if (!requestedUserId) {
    return { kind: "tenant", tenantId: sessionUser.tenantId };
  }

  if (!requestedUser || requestedUser.tenantId !== sessionUser.tenantId) {
    // Do not reveal whether a cross-tenant user id exists.
    throw new ActivityAccessError(404, "User not found");
  }

  return {
    kind: "tenant_user",
    tenantId: sessionUser.tenantId,
    userId: requestedUser.userId,
  };
}
