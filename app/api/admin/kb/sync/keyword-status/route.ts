import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getKeywordSyncJob } from "@/app/lib/db/keyword-sync-jobs";

export async function GET(req: Request) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const job = await getKeywordSyncJob(session.user.tenantId);
  return NextResponse.json({ job });
}
