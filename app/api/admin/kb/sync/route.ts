import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import {
  getKbDataSource,
  ingestKnowledgeBaseDocuments,
  deleteKnowledgeBaseDocuments,
  getKnowledgeBaseDocumentsStatus,
} from "@/app/lib/bedrock-kb";
import { reconcileKeywordIndex, trackTenantObjects } from "@/app/lib/kb-keyword-index";

const syncRequestSchema = z
  .object({
    mode: z.enum(["full", "incremental"]).optional(),
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
  const mode = parsed.data?.mode ?? "incremental";
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

  // Vector sync only ever runs off a freshly computed (non-partial) diff -
  // resuming a checkpointed keyword-index pass doesn't recompute one, and
  // acting on a partial listing risks missing deletions.
  let vectorSync: {
    mode: "full" | "incremental";
    submittedCount: number;
    deletedCount: number;
    documents: { key: string; status?: string; statusReason?: string }[];
  } | null = null;
  let vectorSyncError: string | null = null;

  if (!resumeKeywordIndexOnly && objectDiff && !objectDiff.partial) {
    try {
      const keysToIngest = mode === "full" ? objectDiff.listedKeys : objectDiff.changedKeys;
      const [ingestResults, deleteResults] = await Promise.all([
        ingestKnowledgeBaseDocuments({
          knowledgeBaseId: tenant.knowledgeBaseId,
          dataSourceId: dataSource.dataSourceId,
          bucketName: dataSource.bucketName,
          keys: keysToIngest,
        }),
        deleteKnowledgeBaseDocuments({
          knowledgeBaseId: tenant.knowledgeBaseId,
          dataSourceId: dataSource.dataSourceId,
          bucketName: dataSource.bucketName,
          keys: objectDiff.deletedKeys,
        }),
      ]);
      vectorSync = {
        mode,
        submittedCount: keysToIngest.length,
        deletedCount: objectDiff.deletedKeys.length,
        documents: [...ingestResults, ...deleteResults],
      };
    } catch (err) {
      console.error("Vector sync failed:", err);
      vectorSyncError = err instanceof Error ? err.message : "Vector sync failed";
    }
  }

  return NextResponse.json({ keywordIndex, keywordIndexError, vectorSync, vectorSyncError });
}

// Fire-and-poll: POST submits documents for ingestion/deletion and returns
// immediately with their initial (usually STARTING) status; the client polls
// here with that same key list to watch them reach a terminal status
// (INDEXED/FAILED/NOT_FOUND/etc).
export async function GET(req: Request) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const keys = (url.searchParams.get("keys") || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  if (keys.length === 0) {
    return Response.json({ error: "Missing keys" }, { status: 400 });
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

  const documents = await getKnowledgeBaseDocumentsStatus({
    knowledgeBaseId: tenant.knowledgeBaseId,
    dataSourceId: dataSource.dataSourceId,
    bucketName: dataSource.bucketName,
    keys,
  });

  return NextResponse.json({ documents });
}
