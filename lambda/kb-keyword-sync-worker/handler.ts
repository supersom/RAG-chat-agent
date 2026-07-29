import type { SQSEvent, SQSHandler } from "aws-lambda";
import { reconcileKeywordIndex } from "../../app/lib/kb-keyword-index";
import { putKeywordSyncJob, KeywordSyncJob } from "../../app/lib/db/keyword-sync-jobs";
import { workerDbClient } from "./db-client";

type JobMessage = {
  tenantId: string;
  knowledgeBaseId: string;
  bucketName: string;
  region?: string;
  mode: "full" | "incremental";
};

function emptyJob(message: JobMessage, status: KeywordSyncJob["status"]): KeywordSyncJob {
  return {
    tenantId: message.tenantId,
    status,
    mode: message.mode,
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
  };
}

async function processMessage(message: JobMessage): Promise<void> {
  await putKeywordSyncJob(emptyJob(message, "running"), workerDbClient);

  let result;
  try {
    // No timeBudgetMs override: this Lambda's own timeout (10 minutes, see
    // infra/terraform/kb_keyword_sync.tf) is the only ceiling, comfortably
    // above the measured 60-180s worst case for this tenant's current index
    // size - unlike the in-request path this replaces, there's no shared
    // ~28s wall to budget against here.
    do {
      result = await reconcileKeywordIndex({
        tenantId: message.tenantId,
        knowledgeBaseId: message.knowledgeBaseId,
        bucketName: message.bucketName,
        region: message.region,
      });
    } while (result.partial);
  } catch (err) {
    await putKeywordSyncJob(
      {
        ...emptyJob(message, "failed"),
        finishedAt: new Date().toISOString(),
        failureMessage: err instanceof Error ? err.message : String(err),
      },
      workerDbClient,
    );
    return;
  }

  await putKeywordSyncJob(
    {
      tenantId: message.tenantId,
      status: "complete",
      mode: message.mode,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      listedObjectCount: result.listedObjectCount,
      changedObjectCount: result.changedObjectCount,
      unchangedObjectCount: result.unchangedObjectCount,
      deletedObjectCount: result.deletedObjectCount,
      indexedObjectCount: result.indexedObjectCount,
      indexedChunkCount: result.indexedChunkCount,
      skippedObjectCount: result.skippedObjectCount,
      errorCount: result.errorCount,
      errors: result.errors,
      failureMessage: null,
    },
    workerDbClient,
  );
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.body) as JobMessage;
    await processMessage(message);
  }
};
