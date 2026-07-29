import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/app/lib/db/tenants", () => ({
  getTenant: vi.fn(),
}));

vi.mock("@/app/lib/bedrock-kb", () => ({
  getKbDataSource: vi.fn(),
}));

vi.mock("@/app/lib/kb-keyword-index", () => ({
  trackTenantObjects: vi.fn(),
  submitVectorSync: vi.fn(),
  DEFAULT_VECTOR_SYNC_TIME_BUDGET_MS: 15_000,
}));

vi.mock("@/app/lib/kb-sync-queue", () => ({
  sendKeywordSyncJob: vi.fn(),
}));

vi.mock("@/app/lib/db/keyword-sync-jobs", () => ({
  getKeywordSyncJob: vi.fn(),
  putKeywordSyncJob: vi.fn(),
}));

import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import { getKbDataSource } from "@/app/lib/bedrock-kb";
import { trackTenantObjects, submitVectorSync } from "@/app/lib/kb-keyword-index";
import { sendKeywordSyncJob } from "@/app/lib/kb-sync-queue";
import { getKeywordSyncJob, putKeywordSyncJob } from "@/app/lib/db/keyword-sync-jobs";
import { POST } from "./route";

const mockedAuth = vi.mocked(auth);
const mockedGetTenant = vi.mocked(getTenant);
const mockedGetKbDataSource = vi.mocked(getKbDataSource);
const mockedTrackTenantObjects = vi.mocked(trackTenantObjects);
const mockedSubmitVectorSync = vi.mocked(submitVectorSync);
const mockedSendKeywordSyncJob = vi.mocked(sendKeywordSyncJob);
const mockedGetKeywordSyncJob = vi.mocked(getKeywordSyncJob);
const mockedPutKeywordSyncJob = vi.mocked(putKeywordSyncJob);

function makeRequest(body?: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/kb/sync", {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Matches trackTenantObjects's real return type exactly (app/lib/kb-keyword-index.ts)
// - listedObjectCount, listedKeys, changedKeys, deletedKeys, partial. No
// indexBucket/mode/indexedObjectCount/etc. - those are reconcileKeywordIndex-only
// fields and reconcileKeywordIndex doesn't run in this route anymore.
function diffResult(overrides: Partial<{
  listedKeys: string[];
  changedKeys: string[];
  deletedKeys: string[];
  partial: boolean;
}> = {}) {
  return {
    listedObjectCount: 1,
    partial: false,
    listedKeys: ["tenants/acme/a.pdf"],
    changedKeys: ["tenants/acme/a.pdf"],
    deletedKeys: [],
    ...overrides,
  };
}

// A job row the dedup check would treat as in-flight; startedAt is the only
// field that varies between the "genuinely in progress" and "stuck" cases.
function inFlightJob(overrides: { startedAt: string }) {
  return {
    tenantId: "acme", status: "running", mode: "incremental", finishedAt: null,
    listedObjectCount: 0, changedObjectCount: 0, unchangedObjectCount: 0, deletedObjectCount: 0,
    indexedObjectCount: 0, indexedChunkCount: 0, skippedObjectCount: 0, errorCount: 0, errors: [],
    failureMessage: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedGetTenant.mockReset();
  mockedGetKbDataSource.mockReset();
  mockedTrackTenantObjects.mockReset();
  mockedSubmitVectorSync.mockReset();
  mockedSendKeywordSyncJob.mockReset();
  mockedGetKeywordSyncJob.mockReset();
  mockedPutKeywordSyncJob.mockReset();

  mockedAuth.mockResolvedValue({
    user: { role: "admin", tenantId: "acme" },
  } as never);
  mockedGetKbDataSource.mockResolvedValue({
    dataSourceId: "ds-1",
    bucketName: "pooled-bucket",
  } as never);
  mockedTrackTenantObjects.mockResolvedValue(diffResult() as never);
  mockedSubmitVectorSync.mockResolvedValue({
    submittedCount: 1,
    deletedCount: 0,
    documents: [{ key: "tenants/acme/a.pdf", status: "STARTING" }],
    partial: false,
  } as never);
  mockedGetTenant.mockResolvedValue({
    tenantId: "acme",
    knowledgeBaseId: "kb-acme",
    awsRegion: "us-east-2",
    disableKeywordSearch: false,
  } as never);
  mockedSendKeywordSyncJob.mockResolvedValue(undefined);
  mockedGetKeywordSyncJob.mockResolvedValue(null);
  mockedPutKeywordSyncJob.mockResolvedValue(undefined);
});

describe("POST /api/admin/kb/sync", () => {
  it("always calls trackTenantObjects for the vector-sync diff, regardless of disableKeywordSearch", async () => {
    mockedGetTenant.mockResolvedValue({
      tenantId: "acme", knowledgeBaseId: "kb-acme", awsRegion: "us-east-2", disableKeywordSearch: true,
    } as never);

    await POST(makeRequest());

    expect(mockedTrackTenantObjects).toHaveBeenCalledTimes(1);
    expect(mockedSubmitVectorSync).toHaveBeenCalledTimes(1);
  });

  it("passes the diff and mode through to submitVectorSync", async () => {
    mockedTrackTenantObjects.mockResolvedValue(
      diffResult({ listedKeys: ["a", "b"], changedKeys: ["b"] }) as never,
    );

    const res = await POST(makeRequest());
    const data = await res.json();

    expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "incremental",
        usesTrackingFile: true,
        diff: expect.objectContaining({ listedKeys: ["a", "b"], changedKeys: ["b"] }),
      }),
    );
    expect(data.vectorSync.submittedCount).toBe(1);
  });

  it("passes mode: full through when requested", async () => {
    const res = await POST(makeRequest({ mode: "full" }));
    const data = await res.json();

    expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "full" }),
    );
    expect(data.vectorSync).not.toBeNull();
  });

  it("never touches vector sync when trackTenantObjects's diff came back partial", async () => {
    mockedTrackTenantObjects.mockResolvedValue(diffResult({ partial: true }) as never);

    const res = await POST(makeRequest());
    const data = await res.json();

    expect(mockedSubmitVectorSync).not.toHaveBeenCalled();
    expect(data.vectorSync).toBeNull();
  });

  it("resumes vector sync directly, skipping the diff step entirely, on a vector-sync-only resume", async () => {
    const res = await POST(makeRequest({ resumeVectorSyncOnly: true, mode: "full" }));
    const data = await res.json();

    expect(mockedTrackTenantObjects).not.toHaveBeenCalled();
    expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "full" }),
    );
    expect(mockedSubmitVectorSync.mock.calls[0][0]).not.toHaveProperty("diff");
    expect(data.keywordIndex).toBeNull();
    expect(data.vectorSync).not.toBeNull();
  });

  it("rejects unauthenticated requests before touching AWS", async () => {
    mockedAuth.mockResolvedValue(null as never);

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(mockedSubmitVectorSync).not.toHaveBeenCalled();
  });

  describe("keyword-index enqueueing", () => {
    it("enqueues a keyword-sync job when keyword search is enabled and none is already in flight", async () => {
      const res = await POST(makeRequest());
      const data = await res.json();

      expect(mockedSendKeywordSyncJob).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "acme", knowledgeBaseId: "kb-acme" }),
      );
      expect(mockedPutKeywordSyncJob).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "acme", status: "queued" }),
      );
      expect(data.keywordIndex).toEqual({ status: "queued" });
    });

    it("does not enqueue a second job when one is already queued or running", async () => {
      mockedGetKeywordSyncJob.mockResolvedValue(
        inFlightJob({ startedAt: new Date(Date.now() - 60 * 1000).toISOString() }) as never,
      );

      const res = await POST(makeRequest());
      const data = await res.json();

      expect(mockedSendKeywordSyncJob).not.toHaveBeenCalled();
      expect(mockedPutKeywordSyncJob).not.toHaveBeenCalled();
      expect(data.keywordIndex).toEqual({ status: "running" });
    });

    it("re-enqueues over a stale queued/running job instead of blocking forever", async () => {
      mockedGetKeywordSyncJob.mockResolvedValue(
        inFlightJob({
          // 40 min ago, past the route's 35-min staleness threshold
          startedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
        }) as never,
      );

      const res = await POST(makeRequest());
      const data = await res.json();

      expect(mockedSendKeywordSyncJob).toHaveBeenCalled();
      expect(data.keywordIndex).toEqual({ status: "queued" });
    });

    it("does not enqueue anything when the tenant has keyword search disabled", async () => {
      mockedGetTenant.mockResolvedValue({
        tenantId: "acme", knowledgeBaseId: "kb-acme", awsRegion: "us-east-2", disableKeywordSearch: true,
      } as never);

      const res = await POST(makeRequest());
      const data = await res.json();

      expect(mockedSendKeywordSyncJob).not.toHaveBeenCalled();
      expect(data.keywordIndex).toBeNull();
    });

    it("reports keywordIndexError and still returns a successful vectorSync when sendKeywordSyncJob throws", async () => {
      mockedSendKeywordSyncJob.mockRejectedValue(new Error("SQS unavailable"));

      const res = await POST(makeRequest());
      const data = await res.json();

      expect(data.keywordIndexError).toBe("SQS unavailable");
      expect(data.keywordIndex).toBeNull();
      expect(data.vectorSync.submittedCount).toBe(1);
    });

    it("never writes a queued job record when sendKeywordSyncJob throws, so the tenant isn't permanently stuck", async () => {
      mockedSendKeywordSyncJob.mockRejectedValue(new Error("SQS unavailable"));

      await POST(makeRequest());

      expect(mockedPutKeywordSyncJob).not.toHaveBeenCalled();
    });
  });

  describe("shared time budget between trackTenantObjects and vector sync", () => {
    const originalEnv = process.env.KB_SYNC_TOTAL_BUDGET_MS;

    afterEach(() => {
      vi.restoreAllMocks();
      if (originalEnv === undefined) delete process.env.KB_SYNC_TOTAL_BUDGET_MS;
      else process.env.KB_SYNC_TOTAL_BUDGET_MS = originalEnv;
    });

    it("never gives submitVectorSync more than its own tuned default, even when trackTenantObjects finished instantly", async () => {
      process.env.KB_SYNC_TOTAL_BUDGET_MS = "22000";
      vi.spyOn(Date, "now").mockReturnValue(1_000_000);

      await POST(makeRequest());

      expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
        expect.objectContaining({ timeBudgetMs: 15_000 }),
      );
    });

    it("reduces submitVectorSync's timeBudgetMs by however long trackTenantObjects actually took", async () => {
      process.env.KB_SYNC_TOTAL_BUDGET_MS = "22000";
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      mockedTrackTenantObjects.mockImplementation(async () => {
        now += 9_000;
        return diffResult() as never;
      });

      await POST(makeRequest());

      expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
        expect.objectContaining({ timeBudgetMs: 13_000 }),
      );
    });

    it("clamps submitVectorSync's timeBudgetMs to 0 instead of negative when trackTenantObjects used the whole budget", async () => {
      process.env.KB_SYNC_TOTAL_BUDGET_MS = "22000";
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      mockedTrackTenantObjects.mockImplementation(async () => {
        now += 30_000;
        return diffResult() as never;
      });

      await POST(makeRequest());

      expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
        expect.objectContaining({ timeBudgetMs: 0 }),
      );
    });
  });
});
