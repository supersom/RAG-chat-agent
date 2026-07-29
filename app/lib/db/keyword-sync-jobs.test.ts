import { describe, expect, it, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("@aws-sdk/lib-dynamodb", async () => {
  const actual = await vi.importActual("@aws-sdk/lib-dynamodb");
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send: sendMock }) } };
});

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getKeywordSyncJob, putKeywordSyncJob, KeywordSyncJob } from "./keyword-sync-jobs";

const testClient = DynamoDBDocumentClient.from({} as never);

describe("getKeywordSyncJob", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.DYNAMODB_KEYWORD_SYNC_JOBS_TABLE = "CustomerSupportAgent-KeywordSyncJobs";
  });

  it("returns null when no job exists for the tenant", async () => {
    sendMock.mockResolvedValue({ Item: undefined });

    const result = await getKeywordSyncJob("acme", testClient);

    expect(result).toBeNull();
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "CustomerSupportAgent-KeywordSyncJobs",
          Key: { tenantId: "acme" },
        }),
      }),
    );
  });

  it("returns the job when one exists", async () => {
    const job: KeywordSyncJob = {
      tenantId: "acme",
      status: "running",
      mode: "incremental",
      startedAt: "2026-07-28T20:00:00.000Z",
      finishedAt: null,
      listedObjectCount: 10,
      changedObjectCount: 2,
      unchangedObjectCount: 8,
      deletedObjectCount: 0,
      indexedObjectCount: 1,
      indexedChunkCount: 5,
      skippedObjectCount: 0,
      errorCount: 0,
      errors: [],
      failureMessage: null,
    };
    sendMock.mockResolvedValue({ Item: job });

    const result = await getKeywordSyncJob("acme", testClient);

    expect(result).toEqual(job);
  });
});

describe("putKeywordSyncJob", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.DYNAMODB_KEYWORD_SYNC_JOBS_TABLE = "CustomerSupportAgent-KeywordSyncJobs";
  });

  it("writes the full job record", async () => {
    const job: KeywordSyncJob = {
      tenantId: "acme",
      status: "queued",
      mode: "full",
      startedAt: "2026-07-28T20:00:00.000Z",
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

    await putKeywordSyncJob(job, testClient);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "CustomerSupportAgent-KeywordSyncJobs",
          Item: job,
        }),
      }),
    );
  });
});
