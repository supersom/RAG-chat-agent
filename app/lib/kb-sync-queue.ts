import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

export type KeywordSyncJobMessage = {
  tenantId: string;
  knowledgeBaseId: string;
  bucketName: string;
  region?: string;
  mode: "full" | "incremental";
};

// SQS queue URLs are always https://sqs.<region>.amazonaws.com/<account>/<name>
// - parsing the region from the URL itself (a single source of truth this
// client already has to read anyway) avoids a separate env var that could
// drift out of sync with the queue's actual Terraform-provisioned region.
function regionFromQueueUrl(queueUrl: string): string | undefined {
  return queueUrl.match(/^https:\/\/sqs\.([^.]+)\.amazonaws\.com\//)?.[1];
}

// Matches every other AWS client in app/lib/ (see kb-keyword-index.ts's
// s3Client): constructed inside the call site, not at module top level,
// since reading process.env at import time returned undefined credentials
// under Amplify's Web Compute bundling. Uses the same BAWS_* static keys as
// the rest of the Next.js app - unlike the worker Lambda, Amplify Compute
// doesn't expose a usable execution role for the app's own AWS calls today.
//
// Deliberately does NOT take a tenant region parameter - the queue is a
// single fixed-region resource, unrelated to any tenant's own AWS region
// (that field is about the tenant's S3 bucket). Confirmed by the final
// whole-branch review: message.region (tenant.awsRegion) is optional and
// likely unset for real tenants, and even when set has nothing to do with
// where the queue actually lives.
function sqsClient(queueUrl: string): SQSClient {
  return new SQSClient({
    region:
      regionFromQueueUrl(queueUrl) ||
      process.env.AWS_REGION ||
      process.env.BAWS_REGION ||
      "us-east-1",
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

  const client = sqsClient(queueUrl);
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
    }),
  );
}
