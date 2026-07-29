import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/app/lib/db/keyword-sync-jobs", () => ({ getKeywordSyncJob: vi.fn() }));

import { auth } from "@/auth";
import { getKeywordSyncJob } from "@/app/lib/db/keyword-sync-jobs";
import { GET } from "./route";

const mockedAuth = vi.mocked(auth);
const mockedGetKeywordSyncJob = vi.mocked(getKeywordSyncJob);

beforeEach(() => {
  mockedAuth.mockReset();
  mockedGetKeywordSyncJob.mockReset();
  mockedAuth.mockResolvedValue({ user: { role: "admin", tenantId: "acme" } } as never);
});

describe("GET /api/admin/kb/sync/keyword-status", () => {
  it("returns the tenant's current job", async () => {
    const job = {
      tenantId: "acme", status: "running" as const, mode: "incremental" as const,
      startedAt: "x", finishedAt: null, listedObjectCount: 5, changedObjectCount: 1,
      unchangedObjectCount: 4, deletedObjectCount: 0, indexedObjectCount: 1,
      indexedChunkCount: 3, skippedObjectCount: 0, errorCount: 0, errors: [], failureMessage: null,
    };
    mockedGetKeywordSyncJob.mockResolvedValue(job);

    const res = await GET(new Request("http://localhost/api/admin/kb/sync/keyword-status"));
    const data = await res.json();

    expect(mockedGetKeywordSyncJob).toHaveBeenCalledWith("acme");
    expect(data.job).toEqual(job);
  });

  it("returns null when no job has ever run for the tenant", async () => {
    mockedGetKeywordSyncJob.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/api/admin/kb/sync/keyword-status"));
    const data = await res.json();

    expect(data.job).toBeNull();
  });

  it("rejects unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as never);

    const res = await GET(new Request("http://localhost/api/admin/kb/sync/keyword-status"));

    expect(res.status).toBe(401);
    expect(mockedGetKeywordSyncJob).not.toHaveBeenCalled();
  });
});
