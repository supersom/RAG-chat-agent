import type { SQSEvent, SQSHandler, Context } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
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

// reconcileKeywordIndex's own timeBudgetMs only governs its per-object loop
// - the download that precedes it and the checkpoint upload that follows it
// both happen OUTSIDE that budget window entirely, so this margin must cover
// BOTH, not just one. Real wall-clock cost of one reconcileKeywordIndex call
// is therefore download + timeBudgetMs + upload, and must fit inside
// context.getRemainingTimeInMillis() at the moment the round starts.
// Measured worst case for this tenant's current index size was 60-180s for
// download+upload combined - this stays comfortably above that, with real
// margin for corpus growth, not just "conservative" in name. (A prior
// version of this constant was 30_000, which the comment claimed was
// conservative relative to 60-180s while the number contradicted it - fixed
// after a whole-branch review caught the mismatch.)
const SAFETY_MARGIN_MS = 200_000;
// Below this remaining budget, don't even start another reconcileKeywordIndex
// round - enqueue an explicit continuation for a fresh invocation instead of
// starting work that can't possibly make meaningful progress before this
// invocation's own deadline.
const MIN_ROUND_BUDGET_MS = 10_000;

function regionFromQueueUrl(queueUrl: string): string | undefined {
  return queueUrl.match(/^https:\/\/sqs\.([^.]+)\.amazonaws\.com\//)?.[1];
}

function continuationQueueUrl(): string {
  const queueUrl = process.env.KB_KEYWORD_SYNC_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("KB_KEYWORD_SYNC_QUEUE_URL is not configured");
  }
  return queueUrl;
}

function continuationQueueClient(queueUrl: string): SQSClient {
  return new SQSClient({
    region: regionFromQueueUrl(queueUrl) || process.env.AWS_REGION || "us-east-1",
  });
}

async function sendContinuation(message: JobMessage): Promise<void> {
  const queueUrl = continuationQueueUrl();
  const client = continuationQueueClient(queueUrl);
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
    }),
  );
}

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

async function processMessage(message: JobMessage, context: Context): Promise<void> {
  // Captured once and threaded through every subsequent write: the terminal
  // record must report when the job actually started, not when it finished.
  const startedAt = new Date().toISOString();
  await putKeywordSyncJob({ ...emptyJob(message, "running"), startedAt }, workerDbClient);

  let result;
  try {
    while (true) {
      const remainingMs = context.getRemainingTimeInMillis() - SAFETY_MARGIN_MS;
      if (remainingMs < MIN_ROUND_BUDGET_MS) {
        await sendContinuation(message);
        return;
      }
      result = await reconcileKeywordIndex({
        tenantId: message.tenantId,
        knowledgeBaseId: message.knowledgeBaseId,
        bucketName: message.bucketName,
        region: message.region,
        timeBudgetMs: remainingMs,
        mode: message.mode,
      });
      if (!result.partial) {
        break;
      }
    }
  } catch (err) {
    await putKeywordSyncJob(
      {
        ...emptyJob(message, "failed"),
        startedAt,
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
      startedAt,
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

export const handler: SQSHandler = async (event: SQSEvent, context: Context) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.body) as JobMessage;
    await processMessage(message, context);
  }
};
