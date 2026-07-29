import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import { getKbDataSource } from "@/app/lib/bedrock-kb";
import { trackTenantObjects, submitVectorSync, DEFAULT_VECTOR_SYNC_TIME_BUDGET_MS } from "@/app/lib/kb-keyword-index";
import { sendKeywordSyncJob } from "@/app/lib/kb-sync-queue";
import { getKeywordSyncJob, putKeywordSyncJob } from "@/app/lib/db/keyword-sync-jobs";

// See docs/superpowers/plans/2026-07-28-async-keyword-index-sync.md - the
// combined-stage budget below governs submitVectorSync only.
// reconcileKeywordIndex no longer runs in this request at all; it's async
// (see lambda/kb-keyword-sync-worker), so it has no time budget to compose
// against anymore.
const DEFAULT_TOTAL_SYNC_BUDGET_MS = 22_000;

// A legitimate job can take up to ~30 minutes (3 SQS redeliveries, see
// kb_keyword_sync.tf's maxReceiveCount, x up to 10 min each, the worker's
// own Lambda timeout) before genuinely failing into the DLQ. Anything still
// "queued"/"running" well past that is stuck - a crash, an OOM, a DLQ'd
// message - not legitimately in progress. Without this, the dedup check
// below would otherwise block that tenant from ever syncing again, with no
// recovery path short of manually deleting the DynamoDB row.
const STALE_JOB_THRESHOLD_MS = 35 * 60 * 1000;

const syncRequestSchema = z
  .object({
    mode: z.enum(["full", "incremental"]).optional(),
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

  if (resumeVectorSyncOnly) {
    try {
      vectorSync = await submitVectorSync({
        tenantId: tenant.tenantId,
        knowledgeBaseId: tenant.knowledgeBaseId,
        dataSourceId: dataSource.dataSourceId,
        bucketName: dataSource.bucketName,
        region: tenant.awsRegion,
        mode,
        usesTrackingFile: true,
      });
    } catch (err) {
      console.error("Vector sync failed:", err);
      vectorSyncError = err instanceof Error ? err.message : "Vector sync failed";
    }
    return NextResponse.json({ keywordIndex: null, keywordIndexError: null, vectorSync, vectorSyncError });
  }

  const requestStartedAt = Date.now();

  // trackTenantObjects runs unconditionally now - it's the cheap, dedicated
  // diff (never touches the large keyword-index file) that drives
  // submitVectorSync, fully decoupled from whether/when the keyword-index
  // itself gets rebuilt. See the design spec's "API changes" section.
  let objectDiff: {
    listedKeys: string[];
    changedKeys: string[];
    deletedKeys: string[];
    partial: boolean;
  } | null = null;
  let keywordIndexError: string | null = null;
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

  if (objectDiff && !objectDiff.partial) {
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
        usesTrackingFile: true,
        diff: objectDiff,
        timeBudgetMs: Math.min(remainingBudgetMs, DEFAULT_VECTOR_SYNC_TIME_BUDGET_MS),
      });
    } catch (err) {
      console.error("Vector sync failed:", err);
      vectorSyncError = err instanceof Error ? err.message : "Vector sync failed";
    }
  }

  let keywordIndex: { status: "queued" | "running" } | null = null;
  if (!tenant.disableKeywordSearch) {
    try {
      const existingJob = await getKeywordSyncJob(tenant.tenantId);
      const existingJobIsStale =
        existingJob != null &&
        Date.now() - new Date(existingJob.startedAt).getTime() > STALE_JOB_THRESHOLD_MS;
      if (
        existingJob &&
        (existingJob.status === "queued" || existingJob.status === "running") &&
        !existingJobIsStale
      ) {
        keywordIndex = { status: existingJob.status };
      } else {
        // Send before persisting the "queued" record, not after: if
        // sendKeywordSyncJob throws (SQS misconfigured, transient AWS
        // failure), there must be no DB row claiming a job is queued when
        // no message actually reached the queue - the dedup check above
        // would otherwise skip every future request for this tenant
        // forever, since nothing would ever move that row past "queued".
        await sendKeywordSyncJob({
          tenantId: tenant.tenantId,
          knowledgeBaseId: tenant.knowledgeBaseId,
          bucketName: dataSource.bucketName,
          region: tenant.awsRegion,
          mode,
        });
        await putKeywordSyncJob({
          tenantId: tenant.tenantId,
          status: "queued",
          mode,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          listedObjectCount: 0,
          changedObjectCount: 0,
          unchangedObjectCount: 0,
          deletedObjectCount: 0,
          indexedObjectCount: 0,
          indexedChunkCount: 0,
          skippedObjectCount: 0,
          errorCount: 0,
          errors: [],
          failureMessage: null,
        });
        keywordIndex = { status: "queued" };
      }
    } catch (err) {
      // Matches the try/catch pattern already used for trackTenantObjects
      // and submitVectorSync above - a failure here must not crash the
      // whole response and discard an already-successful vectorSync result.
      console.error("Failed to enqueue keyword-index sync:", err);
      keywordIndexError = err instanceof Error ? err.message : "Failed to enqueue keyword-index sync";
    }
  }

  return NextResponse.json({ keywordIndex, keywordIndexError, vectorSync, vectorSyncError });
}
