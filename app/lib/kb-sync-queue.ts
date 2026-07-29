import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

export type KeywordSyncJobMessage = {
  tenantId: string;
  knowledgeBaseId: string;
  bucketName: string;
  region?: string;
  mode: "full" | "incremental";
};

// Matches every other AWS client in app/lib/ (see kb-keyword-index.ts's
// s3Client): constructed inside the call site, not at module top level,
// since reading process.env at import time returned undefined credentials
// under Amplify's Web Compute bundling. Uses the same BAWS_* static keys as
// the rest of the Next.js app - unlike the worker Lambda, Amplify Compute
// doesn't expose a usable execution role for the app's own AWS calls today.
function sqsClient(region?: string): SQSClient {
  return new SQSClient({
    region: region || process.env.AWS_REGION || process.env.BAWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.BAWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.BAWS_SECRET_ACCESS_KEY!,
    },
  });
}

export async function sendKeywordSyncJob(message: KeywordSyncJobMessage): Promise<void> {
  const queueUrl = process.env.KB_KEYWORD_SYNC_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("KB_KEYWORD_SYNC_QUEUE_URL is not configured");
  }

  const client = sqsClient(message.region);
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
    }),
  );
}
