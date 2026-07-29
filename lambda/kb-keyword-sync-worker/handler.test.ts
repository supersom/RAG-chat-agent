import { describe, expect, it, vi, beforeEach } from "vitest";

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
  });

  it("writes a running record, calls reconcileKeywordIndex once when it finishes non-partial, then writes complete", async () => {
    mockedReconcile.mockResolvedValue(reconcileResult({ partial: false }));

    await handler(sqsEvent(message));

    expect(mockedReconcile).toHaveBeenCalledTimes(1);
    expect(mockedReconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "acme",
        knowledgeBaseId: "kb-acme",
        bucketName: "pooled-bucket",
        region: "us-east-2",
      }),
    );

    const statuses = mockedPut.mock.calls.map(([job]) => job.status);
    expect(statuses).toEqual(["running", "complete"]);
    const finalJob = mockedPut.mock.calls[1][0];
    expect(finalJob.indexedObjectCount).toBe(2);
    expect(finalJob.finishedAt).not.toBeNull();
  });

  it("keeps calling reconcileKeywordIndex until partial is false", async () => {
    mockedReconcile
      .mockResolvedValueOnce(reconcileResult({ partial: true, indexedObjectCount: 1 }))
      .mockResolvedValueOnce(reconcileResult({ partial: true, indexedObjectCount: 1 }))
      .mockResolvedValueOnce(reconcileResult({ partial: false, indexedObjectCount: 1 }));

    await handler(sqsEvent(message));

    expect(mockedReconcile).toHaveBeenCalledTimes(3);
    const statuses = mockedPut.mock.calls.map(([job]) => job.status);
    expect(statuses).toEqual(["running", "complete"]);
  });

  it("writes a failed record with the error message when reconcileKeywordIndex throws", async () => {
    mockedReconcile.mockRejectedValue(new Error("S3 GetObject denied"));

    await handler(sqsEvent(message));

    const statuses = mockedPut.mock.calls.map(([job]) => job.status);
    expect(statuses).toEqual(["running", "failed"]);
    const finalJob = mockedPut.mock.calls[1][0];
    expect(finalJob.failureMessage).toBe("S3 GetObject denied");
    expect(finalJob.finishedAt).not.toBeNull();
  });
});
