import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import { getKbDataSource } from "@/app/lib/bedrock-kb";
import {
  reconcileKeywordIndex,
  trackTenantObjects,
  submitVectorSync,
  DEFAULT_VECTOR_SYNC_TIME_BUDGET_MS,
} from "@/app/lib/kb-keyword-index";

// A fresh (non-resume) request can run reconcileKeywordIndex and
// submitVectorSync back to back in the same Lambda invocation. Each is
// independently time-budgeted (12s / 15s defaults), but nothing previously
// bounded their *sum* against Amplify's real ~28s wall - a cold keyword-index
// build followed by a non-trivial vector-sync submission could stack close to
// 27s of budgeted work alone, and did: CloudWatch showed two live requests
// hard-killed at 28002-28005ms. This shared ceiling caps the whole request,
// with submitVectorSync's own default as a second cap so a fast reconcile
// never hands it more time than already-verified-safe standalone.
const DEFAULT_TOTAL_SYNC_BUDGET_MS = 22_000;

const syncRequestSchema = z
  .object({
    mode: z.enum(["full", "incremental"]).optional(),
    resumeKeywordIndexOnly: z.boolean().optional(),
    resumeVectorSyncOnly: z.boolean().optional(),
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
  const mode = parsed.data?.mode ?? "incremental";
  const resumeKeywordIndexOnly = parsed.data?.resumeKeywordIndexOnly === true;
  const resumeVectorSyncOnly = parsed.data?.resumeVectorSyncOnly === true;

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

  let vectorSync: Awaited<ReturnType<typeof submitVectorSync>> | null = null;
  let vectorSyncError: string | null = null;

  // A vector-sync-only resume continues an in-progress checkpointed
  // submission (see submitVectorSync's own vector_sync_run state) - it
  // needs neither a fresh diff nor any keyword-index work this round.
  if (resumeVectorSyncOnly) {
    try {
      vectorSync = await submitVectorSync({
        tenantId: tenant.tenantId,
        knowledgeBaseId: tenant.knowledgeBaseId,
        dataSourceId: dataSource.dataSourceId,
        bucketName: dataSource.bucketName,
        region: tenant.awsRegion,
        mode,
        usesTrackingFile: Boolean(tenant.disableKeywordSearch),
      });
    } catch (err) {
      console.error("Vector sync failed:", err);
      vectorSyncError = err instanceof Error ? err.message : "Vector sync failed";
    }
    return NextResponse.json({ keywordIndex: null, keywordIndexError: null, vectorSync, vectorSyncError });
  }

  // Both reconcileKeywordIndex and submitVectorSync can run in this same
  // request below - track wall-clock time from here so submitVectorSync's
  // budget can be shrunk by however long reconcileKeywordIndex actually took,
  // not just by its own fixed default. See DEFAULT_TOTAL_SYNC_BUDGET_MS above.
  const requestStartedAt = Date.now();

  // The tenant-scoped S3 object diff, however it was computed, drives vector
  // sync below. Keyword search disabled doesn't mean "skip diffing" - vector
  // sync still needs to know what changed, so trackTenantObjects computes
  // and records the same diff without building the (unused) FTS index.
  let keywordIndex = null;
  let keywordIndexError: string | null = null;
  let objectDiff: {
    listedKeys: string[];
    changedKeys: string[];
    deletedKeys: string[];
    partial: boolean;
  } | null = null;

  if (!tenant.disableKeywordSearch) {
    try {
      keywordIndex = await reconcileKeywordIndex({
        tenantId: tenant.tenantId,
        knowledgeBaseId: tenant.knowledgeBaseId,
        bucketName: dataSource.bucketName,
        region: tenant.awsRegion,
      });
      objectDiff = keywordIndex;
    } catch (err) {
      console.error("Keyword index update failed:", err);
      keywordIndexError = err instanceof Error ? err.message : "Keyword index update failed";
    }
  } else if (!resumeKeywordIndexOnly) {
    try {
      objectDiff = await trackTenantObjects({
        tenantId: tenant.tenantId,
        knowledgeBaseId: tenant.knowledgeBaseId,
        bucketName: dataSource.bucketName,
        region: tenant.awsRegion,
      });
    } catch (err) {
      console.error("Tenant object tracking failed:", err);
      keywordIndexError = err instanceof Error ? err.message : "Tenant object tracking failed";
    }
  }

  // Vector sync only ever starts fresh off a freshly computed (non-partial)
  // diff - resuming a checkpointed keyword-index pass doesn't recompute one,
  // and acting on a partial listing risks missing deletions. (A separate
  // resumeVectorSyncOnly request, handled above, continues vector sync's own
  // checkpoint independently of the keyword-index resume loop.)
  if (!resumeKeywordIndexOnly && objectDiff && !objectDiff.partial) {
    const totalBudgetMs = Number(
      process.env.KB_SYNC_TOTAL_BUDGET_MS || DEFAULT_TOTAL_SYNC_BUDGET_MS,
    );
    const remainingBudgetMs = Math.max(0, totalBudgetMs - (Date.now() - requestStartedAt));
    try {
      vectorSync = await submitVectorSync({
        tenantId: tenant.tenantId,
        knowledgeBaseId: tenant.knowledgeBaseId,
        dataSourceId: dataSource.dataSourceId,
        bucketName: dataSource.bucketName,
        region: tenant.awsRegion,
        mode,
        usesTrackingFile: Boolean(tenant.disableKeywordSearch),
        diff: objectDiff,
        timeBudgetMs: Math.min(remainingBudgetMs, DEFAULT_VECTOR_SYNC_TIME_BUDGET_MS),
      });
    } catch (err) {
      console.error("Vector sync failed:", err);
      vectorSyncError = err instanceof Error ? err.message : "Vector sync failed";
    }
  }

  return NextResponse.json({ keywordIndex, keywordIndexError, vectorSync, vectorSyncError });
}
