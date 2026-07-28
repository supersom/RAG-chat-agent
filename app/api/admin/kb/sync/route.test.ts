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
  reconcileKeywordIndex: vi.fn(),
  trackTenantObjects: vi.fn(),
  submitVectorSync: vi.fn(),
  DEFAULT_VECTOR_SYNC_TIME_BUDGET_MS: 15_000,
}));

import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import { getKbDataSource } from "@/app/lib/bedrock-kb";
import { reconcileKeywordIndex, trackTenantObjects, submitVectorSync } from "@/app/lib/kb-keyword-index";
import { POST } from "./route";

const mockedAuth = vi.mocked(auth);
const mockedGetTenant = vi.mocked(getTenant);
const mockedGetKbDataSource = vi.mocked(getKbDataSource);
const mockedReconcile = vi.mocked(reconcileKeywordIndex);
const mockedTrackTenantObjects = vi.mocked(trackTenantObjects);
const mockedSubmitVectorSync = vi.mocked(submitVectorSync);

function makeRequest(body?: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/kb/sync", {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function diffResult(overrides: Partial<{
  listedKeys: string[];
  changedKeys: string[];
  deletedKeys: string[];
  partial: boolean;
}> = {}) {
  return {
    indexBucket: "pooled-bucket",
    indexKey: "index-key",
    mode: "reconcile" as const,
    listedObjectCount: 1,
    changedObjectCount: 1,
    unchangedObjectCount: 0,
    deletedObjectCount: 0,
    indexedObjectCount: 1,
    indexedChunkCount: 1,
    skippedObjectCount: 0,
    errorCount: 0,
    errors: [],
    partial: false,
    listedKeys: ["tenants/acme/a.pdf"],
    changedKeys: ["tenants/acme/a.pdf"],
    deletedKeys: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedGetTenant.mockReset();
  mockedGetKbDataSource.mockReset();
  mockedReconcile.mockReset();
  mockedTrackTenantObjects.mockReset();
  mockedSubmitVectorSync.mockReset();

  mockedAuth.mockResolvedValue({
    user: { role: "admin", tenantId: "acme" },
  } as never);
  mockedGetKbDataSource.mockResolvedValue({
    dataSourceId: "ds-1",
    bucketName: "pooled-bucket",
  } as never);
  mockedReconcile.mockResolvedValue(diffResult() as never);
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
  } as never);
});

describe("POST /api/admin/kb/sync", () => {
  it("passes the diff and mode through to submitVectorSync", async () => {
    mockedReconcile.mockResolvedValue(
      diffResult({ listedKeys: ["a", "b"], changedKeys: ["b"] }) as never,
    );

    const res = await POST(makeRequest());
    const data = await res.json();

    expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "incremental",
        usesTrackingFile: false,
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

  it("never touches vector sync when the diff came back partial", async () => {
    mockedReconcile.mockResolvedValue(diffResult({ partial: true }) as never);

    const res = await POST(makeRequest());
    const data = await res.json();

    expect(mockedSubmitVectorSync).not.toHaveBeenCalled();
    expect(data.vectorSync).toBeNull();
  });

  it("still computes the object diff via trackTenantObjects when keyword search is disabled, so vector sync isn't starved", async () => {
    mockedGetTenant.mockResolvedValue({
      tenantId: "acme",
      knowledgeBaseId: "kb-acme",
      awsRegion: "us-east-2",
      disableKeywordSearch: true,
    } as never);
    mockedTrackTenantObjects.mockResolvedValue(
      diffResult({ listedKeys: ["tenants/acme/a.pdf"], changedKeys: ["tenants/acme/a.pdf"] }) as never,
    );

    const res = await POST(makeRequest());
    const data = await res.json();

    expect(mockedReconcile).not.toHaveBeenCalled();
    expect(mockedTrackTenantObjects).toHaveBeenCalledTimes(1);
    expect(data.keywordIndex).toBeNull();
    expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
      expect.objectContaining({ usesTrackingFile: true }),
    );
    expect(data.vectorSync.submittedCount).toBe(1);
  });

  it("does not run vector sync (or trackTenantObjects) on a keyword-index-only resume", async () => {
    await POST(makeRequest({ resumeKeywordIndexOnly: true }));

    expect(mockedSubmitVectorSync).not.toHaveBeenCalled();
  });

  it("resumes vector sync directly, skipping keyword-index/diff work entirely, on a vector-sync-only resume", async () => {
    const res = await POST(makeRequest({ resumeVectorSyncOnly: true, mode: "full" }));
    const data = await res.json();

    expect(mockedReconcile).not.toHaveBeenCalled();
    expect(mockedTrackTenantObjects).not.toHaveBeenCalled();
    expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "full" }),
    );
    // No diff is passed on a resume - submitVectorSync continues its own
    // checkpointed queue instead of re-seeding.
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

  describe("shared time budget between reconcile and vector sync", () => {
    const originalEnv = process.env.KB_SYNC_TOTAL_BUDGET_MS;

    afterEach(() => {
      vi.restoreAllMocks();
      if (originalEnv === undefined) delete process.env.KB_SYNC_TOTAL_BUDGET_MS;
      else process.env.KB_SYNC_TOTAL_BUDGET_MS = originalEnv;
    });

    it("never gives submitVectorSync more than its own tuned default, even when reconcile finished instantly", async () => {
      process.env.KB_SYNC_TOTAL_BUDGET_MS = "22000";
      vi.spyOn(Date, "now").mockReturnValue(1_000_000);

      await POST(makeRequest());

      // Total budget (22s) minus ~0 elapsed would be 22s, but that's more
      // than submitVectorSync's own live-verified-safe 15s default - the
      // route must cap at the smaller of the two, not just hand over
      // whatever's left of the shared budget.
      expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
        expect.objectContaining({ timeBudgetMs: 15_000 }),
      );
    });

    it("reduces submitVectorSync's timeBudgetMs by however long reconcileKeywordIndex actually took", async () => {
      process.env.KB_SYNC_TOTAL_BUDGET_MS = "22000";
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      mockedReconcile.mockImplementation(async () => {
        now += 9_000; // simulate reconcile spending 9s of the shared budget
        return diffResult() as never;
      });

      await POST(makeRequest());

      expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
        expect.objectContaining({ timeBudgetMs: 13_000 }),
      );
    });

    it("clamps submitVectorSync's timeBudgetMs to 0 instead of negative when reconcile used the whole budget", async () => {
      process.env.KB_SYNC_TOTAL_BUDGET_MS = "22000";
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      mockedReconcile.mockImplementation(async () => {
        now += 30_000; // reconcile overran the entire shared budget
        return diffResult() as never;
      });

      await POST(makeRequest());

      expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
        expect.objectContaining({ timeBudgetMs: 0 }),
      );
    });
  });
});
