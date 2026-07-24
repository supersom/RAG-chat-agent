import {
  BedrockAgentClient,
  ListDataSourcesCommand,
  GetDataSourceCommand,
  StartIngestionJobCommand,
  GetIngestionJobCommand,
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
