import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Context } from "aws-lambda";

const sendMock = vi.fn();
const clientConfigs: any[] = [];
vi.mock("@aws-sdk/client-sqs", () => ({
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
}));

vi.mock("../../app/lib/kb-keyword-index", () => ({
  reconcileKeywordIndex: vi.fn(),
}));
vi.mock("../../app/lib/db/keyword-sync-jobs", () => ({
  putKeywordSyncJob: vi.fn(),
}));
vi.mock("./db-client", () => ({ workerDbClient: {} }));

import { reconcileKeywordIndex } from "../../app/lib/kb-keyword-index";
import { putKeywordSyncJob } from "../../app/lib/db/keyword-sync-jobs";
import { handler } from "./handler";

const mockedReconcile = vi.mocked(reconcileKeywordIndex);
const mockedPut = vi.mocked(putKeywordSyncJob);

function sqsEvent(body: Record<string, unknown>) {
  return {
    Records: [{ messageId: "m1", body: JSON.stringify(body) }],
  } as never;
}

// getRemainingTimeInMillis is the only Context member this handler touches -
// the rest of the real Context surface is irrelevant here.
function mockContext(remainingMs: number): Context {
  return {
    getRemainingTimeInMillis: () => remainingMs,
  } as Context;
}

// SQSHandler's third argument is a callback the handler never uses (it's a
// promise-returning handler); a no-op satisfies the type.
const noopCallback = () => {};

function reconcileResult(overrides: Partial<Awaited<ReturnType<typeof reconcileKeywordIndex>>> = {}) {
  return {
    indexBucket: "pooled-bucket",
    indexKey: "index-key",
    mode: "reconcile" as const,
    listedObjectCount: 5,
    changedObjectCount: 2,
    unchangedObjectCount: 3,
    deletedObjectCount: 0,
    indexedObjectCount: 2,
    indexedChunkCount: 10,
    skippedObjectCount: 0,
    errorCount: 0,
    partial: false,
    errors: [],
    listedKeys: [],
    changedKeys: [],
    deletedKeys: [],
    ...overrides,
  };
}

const message = {
  tenantId: "acme",
  knowledgeBaseId: "kb-acme",
  bucketName: "pooled-bucket",
  region: "us-east-2",
  mode: "incremental" as const,
};

describe("kb-keyword-sync-worker handler", () => {
  beforeEach(() => {
    mockedReconcile.mockReset();
    mockedPut.mockReset();
    mockedPut.mockResolvedValue(undefined);
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    clientConfigs.length = 0;
    process.env.KB_KEYWORD_SYNC_QUEUE_URL = "https://sqs.us-east-2.amazonaws.com/123/kb-keyword-sync";
  });

  it("writes a running record, calls reconcileKeywordIndex once when it finishes non-partial, then writes complete", async () => {
    mockedReconcile.mockResolvedValue(reconcileResult({ partial: false }));

    await handler(sqsEvent(message), mockContext(600_000), noopCallback);

    expect(mockedReconcile).toHaveBeenCalledTimes(1);
    expect(mockedReconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "acme",
        knowledgeBaseId: "kb-acme",
        bucketName: "pooled-bucket",
        region: "us-east-2",
        mode: "incremental",
      }),
    );

    const statuses = mockedPut.mock.calls.map(([job]) => job.status);
    expect(statuses).toEqual(["running", "complete"]);
    const finalJob = mockedPut.mock.calls[1][0];
    expect(finalJob.indexedObjectCount).toBe(2);
    expect(finalJob.finishedAt).not.toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("leaves the job running and sends a continuation when a checkpoint round is partial", async () => {
    mockedReconcile.mockResolvedValue(reconcileResult({ partial: true, indexedObjectCount: 1 }));

    await handler(sqsEvent(message), mockContext(600_000), noopCallback);

    expect(mockedReconcile).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [{ input }] = sendMock.mock.calls[0];
    expect(input.QueueUrl).toBe("https://sqs.us-east-2.amazonaws.com/123/kb-keyword-sync");
    expect(JSON.parse(input.MessageBody)).toEqual(message);
    const statuses = mockedPut.mock.calls.map(([job]) => job.status);
    expect(statuses).toEqual(["running"]);
  });

  it("writes a failed record with the error message when reconcileKeywordIndex throws", async () => {
    mockedReconcile.mockRejectedValue(new Error("S3 GetObject denied"));

    await handler(sqsEvent(message), mockContext(600_000), noopCallback);

    const statuses = mockedPut.mock.calls.map(([job]) => job.status);
    expect(statuses).toEqual(["running", "failed"]);
    const finalJob = mockedPut.mock.calls[1][0];
    expect(finalJob.failureMessage).toBe("S3 GetObject denied");
    expect(finalJob.finishedAt).not.toBeNull();
  });

  it("caps timeBudgetMs so the unbudgeted download and upload still fit before Lambda timeout", async () => {
    mockedReconcile.mockResolvedValue(reconcileResult({ partial: false }));

    await handler(sqsEvent(message), mockContext(500_000), noopCallback);

    expect(mockedReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ timeBudgetMs: 90_000 }),
    );
  });

  it("passes the message's mode through to reconcileKeywordIndex, not just a hardcoded default - a full-sync click must actually reach the keyword index, not only vector-sync", async () => {
    mockedReconcile.mockResolvedValue(reconcileResult({ partial: false }));

    await handler(sqsEvent({ ...message, mode: "full" }), mockContext(600_000), noopCallback);

    expect(mockedReconcile).toHaveBeenCalledWith(expect.objectContaining({ mode: "full" }));
  });

  it("leaves the job running and sends a continuation when remaining time drops below the minimum round budget", async () => {
    mockedReconcile.mockResolvedValue(reconcileResult({ partial: true }));

    // 380_000 - 360_000 margin = 20_000, below MIN_ROUND_BUDGET_MS
    await handler(sqsEvent(message), mockContext(380_000), noopCallback);

    const statuses = mockedPut.mock.calls.map(([job]) => job.status);
    expect(statuses).toEqual(["running"]); // never reaches "failed" or "complete"
    expect(mockedReconcile).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [{ input }] = sendMock.mock.calls[0];
    expect(input.QueueUrl).toBe("https://sqs.us-east-2.amazonaws.com/123/kb-keyword-sync");
    expect(JSON.parse(input.MessageBody)).toEqual(message);
    expect(clientConfigs[0].region).toBe("us-east-2");
  });

  it("does not run multiple checkpoint rounds in one invocation", async () => {
    mockedReconcile.mockResolvedValue(reconcileResult({ partial: true }));

    await handler(sqsEvent(message), mockContext(600_000), noopCallback);

    expect(mockedReconcile).toHaveBeenCalledTimes(1);
    expect(mockedReconcile).toHaveBeenCalledWith(expect.objectContaining({ timeBudgetMs: 90_000 }));
    expect(sendMock).toHaveBeenCalledTimes(1);
    const statuses = mockedPut.mock.calls.map(([job]) => job.status);
    expect(statuses).toEqual(["running"]);
  });

  it("reports the job's real start time on the terminal record, not the time it finished", async () => {
    mockedReconcile.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-07-28T00:05:00.000Z"));
      return reconcileResult({ partial: false });
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));

    try {
      await handler(sqsEvent(message), mockContext(600_000), noopCallback);
    } finally {
      vi.useRealTimers();
    }

    const runningJob = mockedPut.mock.calls[0][0];
    const completeJob = mockedPut.mock.calls[1][0];
    expect(runningJob.startedAt).toBe("2026-07-28T00:00:00.000Z");
    expect(completeJob.startedAt).toBe("2026-07-28T00:00:00.000Z");
    expect(completeJob.finishedAt).toBe("2026-07-28T00:05:00.000Z");
  });
});
