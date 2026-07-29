import { GetCommand, PutCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "./client";

export type KeywordSyncJob = {
  tenantId: string;
  status: "queued" | "running" | "complete" | "failed";
  mode: "full" | "incremental";
  startedAt: string;
  finishedAt: string | null;
  listedObjectCount: number;
  changedObjectCount: number;
  unchangedObjectCount: number;
  deletedObjectCount: number;
  indexedObjectCount: number;
  indexedChunkCount: number;
  skippedObjectCount: number;
  errorCount: number;
  errors: string[];
  failureMessage: string | null;
};

const TABLE_NAME = () => process.env.DYNAMODB_KEYWORD_SYNC_JOBS_TABLE!;

// `client` is injectable (defaults to the shared BAWS_*-keyed client used
// everywhere else in app/lib/db/) so the worker Lambda - which has its own
// role-based client (see lambda/kb-keyword-sync-worker/db-client.ts) and no
// BAWS_* env vars at all - can reuse this exact query/write logic instead of
// duplicating it.
export async function getKeywordSyncJob(
  tenantId: string,
  client: DynamoDBDocumentClient = ddbDocClient,
): Promise<KeywordSyncJob | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_NAME(),
      Key: { tenantId },
    }),
  );
  return (result.Item as KeywordSyncJob) || null;
}

export async function putKeywordSyncJob(
  job: KeywordSyncJob,
  client: DynamoDBDocumentClient = ddbDocClient,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: TABLE_NAME(),
      Item: job,
    }),
  );
}
