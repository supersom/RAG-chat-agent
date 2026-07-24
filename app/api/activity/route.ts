import { auth } from "@/auth";
import {
  getActivityForTenant,
  getActivityForTenantUser,
} from "@/app/lib/db/activity";
import {
  ActivityAccessError,
  filterVisibleActivitiesForRole,
  resolveActivityLogReadScope,
  resolveActivityReadScope,
} from "@/app/lib/activity-scope";

function parseLimit(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const url = new URL(req.url);
  const requestedUserId = url.searchParams.get("userId");
  const before = url.searchParams.get("before") || undefined;
  const limit = parseLimit(url.searchParams.get("limit"));
  const kind = url.searchParams.get("kind");
  const sessionUser = {
    id: session.user.id,
    role: session.user.role,
    tenantId: session.user.tenantId,
  };

  try {
    if (kind === "app_log") {
      const scope = resolveActivityLogReadScope({ sessionUser });
      const activities = await getActivityForTenant({
        tenantId: scope.tenantId,
        limit,
        before,
      });

      return Response.json({
        activities: filterVisibleActivitiesForRole(
          session.user.role,
          activities,
        ).filter((activity) => activity.kind === "app_log"),
      });
    }

    const scope = resolveActivityReadScope({
      sessionUser,
      requestedUserId,
    });

    const activities = await getActivityForTenantUser({
      tenantId: scope.tenantId,
      userId: scope.userId,
      limit,
      before,
    });

    return Response.json({
      activities: filterVisibleActivitiesForRole(session.user.role, activities),
    });
  } catch (err) {
    if (err instanceof ActivityAccessError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("Failed to read activity:", err);
    return Response.json({ error: "Failed to read activity" }, { status: 500 });
  }
}
