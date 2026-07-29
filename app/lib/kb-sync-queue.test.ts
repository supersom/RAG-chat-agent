import { describe, expect, it, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
// Records every SQSClient constructor config so tests can assert on how the
// client itself was built, not just on the message payload.
const clientConfigs: any[] = [];
vi.mock("@aws-sdk/client-sqs", () => {
  return {
    SQSClient: class {
      send = sendMock;
      constructor(config: any) {
        clientConfigs.push(config);
      }
    },
    SendMessageCommand: class {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
  };
});

import { sendKeywordSyncJob } from "./kb-sync-queue";

describe("sendKeywordSyncJob", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    clientConfigs.length = 0;
    process.env.KB_KEYWORD_SYNC_QUEUE_URL = "https://sqs.us-east-2.amazonaws.com/123/test-queue";
  });

  it("sends one SQS message with the job payload as JSON", async () => {
    await sendKeywordSyncJob({
      tenantId: "acme",
      knowledgeBaseId: "kb-acme",
      bucketName: "pooled-bucket",
      region: "us-east-2",
      mode: "incremental",
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [{ input }] = sendMock.mock.calls[0];
    expect(input.QueueUrl).toBe("https://sqs.us-east-2.amazonaws.com/123/test-queue");
    expect(JSON.parse(input.MessageBody)).toEqual({
      tenantId: "acme",
      knowledgeBaseId: "kb-acme",
      bucketName: "pooled-bucket",
      region: "us-east-2",
      mode: "incremental",
    });
  });

  it("derives the SQS client's region from the queue URL, not the tenant's region", async () => {
    process.env.KB_KEYWORD_SYNC_QUEUE_URL = "https://sqs.us-west-2.amazonaws.com/123/test-queue";

    await sendKeywordSyncJob({
      tenantId: "acme",
      knowledgeBaseId: "kb-acme",
      bucketName: "pooled-bucket",
      // Deliberately different from the queue's real region: tenant.awsRegion
      // describes the tenant's S3 bucket and must never drive the SQS client.
      region: "eu-west-1",
      mode: "incremental",
    });

    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0].region).toBe("us-west-2");
  });

  it("still forwards the tenant's own region in the message body, for the worker's S3 calls", async () => {
    await sendKeywordSyncJob({
      tenantId: "acme",
      knowledgeBaseId: "kb-acme",
      bucketName: "pooled-bucket",
      region: "eu-west-1",
      mode: "incremental",
    });

    const [{ input }] = sendMock.mock.calls[0];
    expect(JSON.parse(input.MessageBody).region).toBe("eu-west-1");
  });

  it("falls back to the env region when the queue URL isn't a parseable SQS URL", async () => {
    process.env.KB_KEYWORD_SYNC_QUEUE_URL = "http://localhost:4566/000000000000/test-queue";
    const originalAwsRegion = process.env.AWS_REGION;
    process.env.AWS_REGION = "ap-south-1";

    try {
      await sendKeywordSyncJob({
        tenantId: "acme",
        knowledgeBaseId: "kb-acme",
        bucketName: "pooled-bucket",
        mode: "incremental",
      });
    } finally {
      if (originalAwsRegion === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = originalAwsRegion;
    }

    expect(clientConfigs[0].region).toBe("ap-south-1");
  });

  it("throws if KB_KEYWORD_SYNC_QUEUE_URL is not configured", async () => {
    delete process.env.KB_KEYWORD_SYNC_QUEUE_URL;

    await expect(
      sendKeywordSyncJob({
        tenantId: "acme",
        knowledgeBaseId: "kb-acme",
        bucketName: "pooled-bucket",
        mode: "incremental",
      }),
    ).rejects.toThrow("KB_KEYWORD_SYNC_QUEUE_URL");
  });
});
