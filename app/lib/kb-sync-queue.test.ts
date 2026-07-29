import { describe, expect, it, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-sqs", () => {
  return {
    SQSClient: class {
      send = sendMock;
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
