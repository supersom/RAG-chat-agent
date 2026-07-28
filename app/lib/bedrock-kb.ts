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

function getClient(): BedrockAgentClient {
  return new BedrockAgentClient({
    region: process.env.AWS_REGION || process.env.BAWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.BAWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.BAWS_SECRET_ACCESS_KEY!,
    },
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
  const results: DocumentSyncResult[] = [];

  for (const keyBatch of batch(params.keys, DOCUMENT_BATCH_SIZE)) {
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

    for (const detail of response.documentDetails ?? []) {
      results.push({
        key: keyFromDetail(detail, params.bucketName),
        status: detail.status,
        statusReason: detail.statusReason,
      });
    }
  }

  return results;
}

export async function deleteKnowledgeBaseDocuments(params: {
  knowledgeBaseId: string;
  dataSourceId: string;
  bucketName: string;
  keys: string[];
}): Promise<DocumentSyncResult[]> {
  if (params.keys.length === 0) return [];
  const client = getClient();
  const results: DocumentSyncResult[] = [];

  for (const keyBatch of batch(params.keys, DOCUMENT_BATCH_SIZE)) {
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

    for (const detail of response.documentDetails ?? []) {
      results.push({
        key: keyFromDetail(detail, params.bucketName),
        status: detail.status,
        statusReason: detail.statusReason,
      });
    }
  }

  return results;
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
  const results: DocumentSyncResult[] = [];

  for (const keyBatch of batch(params.keys, DOCUMENT_BATCH_SIZE)) {
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

    for (const detail of response.documentDetails ?? []) {
      results.push({
        key: keyFromDetail(detail, params.bucketName),
        status: detail.status,
        statusReason: detail.statusReason,
      });
    }
  }

  return results;
}
