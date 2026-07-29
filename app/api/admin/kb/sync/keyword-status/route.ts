import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getKeywordSyncJob } from "@/app/lib/db/keyword-sync-jobs";

export async function GET(req: Request) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  // Matches every sibling route under /api/admin/kb/sync. middleware.ts is
  // not a backstop here - it matches /admin/:path*, not /api/admin/* - so
  // without this any authenticated end user could read job status, including
  // errors[], which carries this tenant's S3 keys and filenames.
  if (session.user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const job = await getKeywordSyncJob(session.user.tenantId);
  return NextResponse.json({ job });
}
