import {
  BedrockAgentClient,
  ListDataSourcesCommand,
  GetDataSourceCommand,
  StartIngestionJobCommand,
  GetIngestionJobCommand,
  IngestKnowledgeBaseDocumentsCommand,
  DeleteKnowledgeBaseDocumentsCommand,
  GetKnowledgeBaseDocumentsCommand,
  type KnowledgeBaseDocumentDetail,
} from "@aws-sdk/client-bedrock-agent";

// Live-confirmed: bounded concurrency (default 8, see runBatchesWithConcurrency
// below) against IngestKnowledgeBaseDocuments can trigger real
// ThrottlingException bursts - the SDK's default maxAttempts (3) wasn't
// enough for all concurrent workers' retries to clear the same burst. Raising
// it gives the SDK's own exponential-backoff-with-jitter retry logic more
// room to self-heal, rather than hand-rolling a separate retry mechanism.
const DEFAULT_MAX_ATTEMPTS = 8;

function getClient(): BedrockAgentClient {
  return new BedrockAgentClient({
    region: process.env.AWS_REGION || process.env.BAWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.BAWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.BAWS_SECRET_ACCESS_KEY!,
    },
    maxAttempts: Number(process.env.KB_SYNC_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS),
  });
}

export interface KbDataSource {
  dataSourceId: string;
  bucketName: string;
}

// Assumes a single S3 data source per knowledge base, matching every KB
// provisioned in this project so far.
export async function getKbDataSource(
  knowledgeBaseId: string,
): Promise<KbDataSource | null> {
  const client = getClient();

  const list = await client.send(
    new ListDataSourcesCommand({ knowledgeBaseId }),
  );
  const dataSourceId = list.dataSourceSummaries?.[0]?.dataSourceId;
  if (!dataSourceId) return null;

  const dataSource = await client.send(
    new GetDataSourceCommand({ knowledgeBaseId, dataSourceId }),
  );
  const bucketArn =
    dataSource.dataSource?.dataSourceConfiguration?.s3Configuration
      ?.bucketArn;
  if (!bucketArn) return null;

  const bucketName = bucketArn.split(":::")[1];
  if (!bucketName) return null;

  return { dataSourceId, bucketName };
}

// Still used by scripts/migrate-tenants-to-pool.ts for its one-off,
// whole-KB migration ingestion - the admin-facing "Sync Knowledge Base"
// action no longer uses these (see ingestKnowledgeBaseDocuments below),
// since a full StartIngestionJob rescans every tenant's files in the
// shared pool bucket, not just the one being synced.
export async function startKbIngestion(
  knowledgeBaseId: string,
  dataSourceId: string,
): Promise<string> {
  const client = getClient();
  const result = await client.send(
    new StartIngestionJobCommand({ knowledgeBaseId, dataSourceId }),
  );
  const jobId = result.ingestionJob?.ingestionJobId;
  if (!jobId) throw new Error("Bedrock did not return an ingestion job ID");
  return jobId;
}

export async function getKbIngestionStatus(
  knowledgeBaseId: string,
  dataSourceId: string,
  ingestionJobId: string,
) {
  const client = getClient();
  const result = await client.send(
    new GetIngestionJobCommand({ knowledgeBaseId, dataSourceId, ingestionJobId }),
  );
  return {
    status: result.ingestionJob?.status,
    statistics: result.ingestionJob?.statistics,
  };
}

export interface DocumentSyncResult {
  key: string;
  status?: string;
  statusReason?: string;
}

// Bedrock caps a single Ingest/Delete/GetKnowledgeBaseDocuments call at 10
// documents.
const DOCUMENT_BATCH_SIZE = 10;

function batch<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

// A tenant with ~2,000 files needs ~200 batched calls; run sequentially that
// blew well past Amplify's ~28s platform execution limit (live-confirmed:
// two consecutive full syncs both hard-timed-out at exactly ~28,003ms).
// Bounded concurrency instead of full parallelism - live-confirmed exact
// limit (not a guess): "Your account's sum of concurrent
// IngestKnowledgeBaseDocuments and DeleteKnowledgeBaseDocuments requests
// can't exceed (10)" - account-wide, and summed *across both* APIs, not
// per-call-type. Set safely under that so normal variance (retries, another
// admin syncing a different tenant at the same moment) doesn't tip over it;
// combined with never running ingest and delete concurrently with each
// other (see ingestKnowledgeBaseDocuments/deleteKnowledgeBaseDocuments
// callers), this keeps any single moment's usage well clear of the cap.
//
// Concurrency alone wasn't enough live: even at 4 (well under the cap of
// 10), immediately refiring the next batch the instant a slot freed still
// triggered ThrottlingException, with zero slack for AWS-side burst
// enforcement. A small pacing delay between dispatches smooths the actual
// request *rate*, not just the concurrent count, which the raw "sum of
// concurrent requests" wording doesn't capture on its own.
const DEFAULT_BATCH_CONCURRENCY = 5;
const DEFAULT_BATCH_PACING_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runBatchesWithConcurrency<T, R>(
  items: T[],
  worker: (batch: T[]) => Promise<R[]>,
): Promise<R[]> {
  const batches = batch(items, DOCUMENT_BATCH_SIZE);
  const concurrency = Math.min(
    Number(process.env.KB_SYNC_BATCH_CONCURRENCY || DEFAULT_BATCH_CONCURRENCY),
    batches.length,
  );
  const pacingMs = Number(process.env.KB_SYNC_BATCH_PACING_MS ?? DEFAULT_BATCH_PACING_MS);
  const results: R[][] = new Array(batches.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < batches.length) {
      const index = nextIndex;
      nextIndex += 1;
      if (index > 0 && pacingMs > 0) await sleep(pacingMs);
      results[index] = await worker(batches[index]);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, runNext));
  return results.flat();
}

function s3Uri(bucketName: string, key: string): string {
  return `s3://${bucketName}/${key}`;
}

function keyFromDetail(detail: KnowledgeBaseDocumentDetail, bucketName: string): string {
  const uri = detail.identifier?.s3?.uri ?? "";
  const prefix = `s3://${bucketName}/`;
  return uri.startsWith(prefix) ? uri.slice(prefix.length) : uri;
}

// Ingests specific S3 objects directly into the knowledge base, scoped to
// exactly the keys passed in - unlike StartIngestionJob, this never touches
// any other tenant's files in the shared pool bucket. Metadata must come
// from the same .metadata.json sidecar convention the upload flow and
// migration script already write for every object (live-verified: Bedrock
// rejects inline metadata attributes paired with S3-sourced content on an
// S3 data source - "You can only upload content and metadata from S3 if
// your knowledge base is connected to an S3 data source").
export async function ingestKnowledgeBaseDocuments(params: {
  knowledgeBaseId: string;
  dataSourceId: string;
  bucketName: string;
  keys: string[];
}): Promise<DocumentSyncResult[]> {
  if (params.keys.length === 0) return [];
  const client = getClient();

  return runBatchesWithConcurrency(params.keys, async (keyBatch) => {
    const response = await client.send(
      new IngestKnowledgeBaseDocumentsCommand({
        knowledgeBaseId: params.knowledgeBaseId,
        dataSourceId: params.dataSourceId,
        documents: keyBatch.map((key) => ({
          content: {
            dataSourceType: "S3",
            s3: { s3Location: { uri: s3Uri(params.bucketName, key) } },
          },
          metadata: {
            type: "S3_LOCATION",
            s3Location: { uri: s3Uri(params.bucketName, `${key}.metadata.json`) },
          },
        })),
      }),
    );

    return (response.documentDetails ?? []).map((detail) => ({
      key: keyFromDetail(detail, params.bucketName),
      status: detail.status,
      statusReason: detail.statusReason,
    }));
  });
}

export async function deleteKnowledgeBaseDocuments(params: {
  knowledgeBaseId: string;
  dataSourceId: string;
  bucketName: string;
  keys: string[];
}): Promise<DocumentSyncResult[]> {
  if (params.keys.length === 0) return [];
  const client = getClient();

  return runBatchesWithConcurrency(params.keys, async (keyBatch) => {
    const response = await client.send(
      new DeleteKnowledgeBaseDocumentsCommand({
        knowledgeBaseId: params.knowledgeBaseId,
        dataSourceId: params.dataSourceId,
        documentIdentifiers: keyBatch.map((key) => ({
          dataSourceType: "S3",
          s3: { uri: s3Uri(params.bucketName, key) },
        })),
      }),
    );

    return (response.documentDetails ?? []).map((detail) => ({
      key: keyFromDetail(detail, params.bucketName),
      status: detail.status,
      statusReason: detail.statusReason,
    }));
  });
}

// Polls the current status of previously submitted documents (ingested or
// deleted) - the fire-and-poll counterpart to ingest/deleteKnowledgeBaseDocuments,
// which only return each document's status at submission time (typically
// STARTING), not its eventual terminal state.
export async function getKnowledgeBaseDocumentsStatus(params: {
  knowledgeBaseId: string;
  dataSourceId: string;
  bucketName: string;
  keys: string[];
}): Promise<DocumentSyncResult[]> {
  if (params.keys.length === 0) return [];
  const client = getClient();

  return runBatchesWithConcurrency(params.keys, async (keyBatch) => {
    const response = await client.send(
      new GetKnowledgeBaseDocumentsCommand({
        knowledgeBaseId: params.knowledgeBaseId,
        dataSourceId: params.dataSourceId,
        documentIdentifiers: keyBatch.map((key) => ({
          dataSourceType: "S3",
          s3: { uri: s3Uri(params.bucketName, key) },
        })),
      }),
    );

    return (response.documentDetails ?? []).map((detail) => ({
      key: keyFromDetail(detail, params.bucketName),
      status: detail.status,
      statusReason: detail.statusReason,
    }));
  });
}
