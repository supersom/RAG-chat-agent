import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import {
  getKbDataSource,
  startKbIngestion,
  getKbIngestionStatus,
} from "@/app/lib/bedrock-kb";
import { reconcileKeywordIndex } from "@/app/lib/kb-keyword-index";

const syncRequestSchema = z
  .object({
    resumeKeywordIndexOnly: z.boolean().optional(),
  })
  .optional();

async function parseSyncRequest(req: Request) {
  try {
    const bodyText = await req.text();
    return syncRequestSchema.safeParse(bodyText ? JSON.parse(bodyText) : {});
  } catch {
    return syncRequestSchema.safeParse(null);
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = await parseSyncRequest(req);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const resumeKeywordIndexOnly = parsed.data?.resumeKeywordIndexOnly === true;

  const tenant = await getTenant(session.user.tenantId);
  if (!tenant) {
    return Response.json({ error: "Tenant not found" }, { status: 404 });
  }

  const dataSource = await getKbDataSource(tenant.knowledgeBaseId);
  if (!dataSource) {
    return Response.json(
      { error: "Could not resolve this tenant's knowledge base data source" },
      { status: 400 },
    );
  }

  // A keyword-index-only resume continues a checkpointed reconcile that
  // already hit the route's time budget; it must not kick off another
  // Bedrock ingestion job on top of the one the initial sync started.
  const jobId = resumeKeywordIndexOnly
    ? null
    : await startKbIngestion(tenant.knowledgeBaseId, dataSource.dataSourceId);

  let keywordIndex = null;
  let keywordIndexError = null;
  if (!tenant.disableKeywordSearch) {
    try {
      keywordIndex = await reconcileKeywordIndex({
        tenantId: tenant.tenantId,
        knowledgeBaseId: tenant.knowledgeBaseId,
        bucketName: dataSource.bucketName,
        region: tenant.awsRegion,
      });
    } catch (err) {
      console.error("Keyword index update failed:", err);
      keywordIndexError = err instanceof Error ? err.message : "Keyword index update failed";
    }
  }

  return NextResponse.json({ jobId, keywordIndex, keywordIndexError });
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const jobId = new URL(req.url).searchParams.get("jobId");
  if (!jobId) {
    return Response.json({ error: "Missing jobId" }, { status: 400 });
  }

  const tenant = await getTenant(session.user.tenantId);
  if (!tenant) {
    return Response.json({ error: "Tenant not found" }, { status: 404 });
  }

  const dataSource = await getKbDataSource(tenant.knowledgeBaseId);
  if (!dataSource) {
    return Response.json(
      { error: "Could not resolve this tenant's knowledge base data source" },
      { status: 400 },
    );
  }

  const status = await getKbIngestionStatus(
    tenant.knowledgeBaseId,
    dataSource.dataSourceId,
    jobId,
  );

  return NextResponse.json(status);
}
