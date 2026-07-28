import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/app/lib/db/tenants", () => ({
  getTenant: vi.fn(),
}));

vi.mock("@/app/lib/bedrock-kb", () => ({
  getKbDataSource: vi.fn(),
  ingestKnowledgeBaseDocuments: vi.fn(),
  deleteKnowledgeBaseDocuments: vi.fn(),
  getKnowledgeBaseDocumentsStatus: vi.fn(),
}));

vi.mock("@/app/lib/kb-keyword-index", () => ({
  reconcileKeywordIndex: vi.fn(),
  trackTenantObjects: vi.fn(),
}));

import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import {
  getKbDataSource,
  ingestKnowledgeBaseDocuments,
  deleteKnowledgeBaseDocuments,
  getKnowledgeBaseDocumentsStatus,
} from "@/app/lib/bedrock-kb";
import { reconcileKeywordIndex, trackTenantObjects } from "@/app/lib/kb-keyword-index";
import { POST, GET } from "./route";

const mockedAuth = vi.mocked(auth);
const mockedGetTenant = vi.mocked(getTenant);
const mockedGetKbDataSource = vi.mocked(getKbDataSource);
const mockedIngest = vi.mocked(ingestKnowledgeBaseDocuments);
const mockedDelete = vi.mocked(deleteKnowledgeBaseDocuments);
const mockedGetStatus = vi.mocked(getKnowledgeBaseDocumentsStatus);
const mockedReconcile = vi.mocked(reconcileKeywordIndex);
const mockedTrackTenantObjects = vi.mocked(trackTenantObjects);

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
  mockedIngest.mockReset();
  mockedDelete.mockReset();
  mockedGetStatus.mockReset();
  mockedReconcile.mockReset();
  mockedTrackTenantObjects.mockReset();

  mockedAuth.mockResolvedValue({
    user: { role: "admin", tenantId: "acme" },
  } as never);
  mockedGetKbDataSource.mockResolvedValue({
    dataSourceId: "ds-1",
    bucketName: "pooled-bucket",
  } as never);
  mockedIngest.mockResolvedValue([{ key: "tenants/acme/a.pdf", status: "STARTING" }] as never);
  mockedDelete.mockResolvedValue([] as never);
  mockedReconcile.mockResolvedValue(diffResult() as never);
  mockedTrackTenantObjects.mockResolvedValue(diffResult() as never);
  mockedGetTenant.mockResolvedValue({
    tenantId: "acme",
    knowledgeBaseId: "kb-acme",
    awsRegion: "us-east-2",
  } as never);
});

describe("POST /api/admin/kb/sync", () => {
  it("ingests only the changed keys by default (incremental mode)", async () => {
    mockedReconcile.mockResolvedValue(
      diffResult({ listedKeys: ["a", "b"], changedKeys: ["b"] }) as never,
    );

    const res = await POST(makeRequest());
    const data = await res.json();

    expect(mockedIngest).toHaveBeenCalledWith(
      expect.objectContaining({ keys: ["b"] }),
    );
    expect(data.vectorSync.mode).toBe("incremental");
    expect(data.vectorSync.submittedCount).toBe(1);
  });

  it("ingests every listed key in full mode, not just the changed ones", async () => {
    mockedReconcile.mockResolvedValue(
      diffResult({ listedKeys: ["a", "b"], changedKeys: ["b"] }) as never,
    );

    const res = await POST(makeRequest({ mode: "full" }));
    const data = await res.json();

    expect(mockedIngest).toHaveBeenCalledWith(
      expect.objectContaining({ keys: ["a", "b"] }),
    );
    expect(data.vectorSync.mode).toBe("full");
  });

  it("deletes keys that were removed from S3", async () => {
    mockedReconcile.mockResolvedValue(
      diffResult({ deletedKeys: ["tenants/acme/gone.pdf"] }) as never,
    );

    await POST(makeRequest());

    expect(mockedDelete).toHaveBeenCalledWith(
      expect.objectContaining({ keys: ["tenants/acme/gone.pdf"] }),
    );
  });

  it("never touches vector sync when the diff came back partial", async () => {
    mockedReconcile.mockResolvedValue(diffResult({ partial: true }) as never);

    const res = await POST(makeRequest());
    const data = await res.json();

    expect(mockedIngest).not.toHaveBeenCalled();
    expect(mockedDelete).not.toHaveBeenCalled();
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
    expect(mockedIngest).toHaveBeenCalledWith(
      expect.objectContaining({ keys: ["tenants/acme/a.pdf"] }),
    );
    expect(data.vectorSync.submittedCount).toBe(1);
  });

  it("does not run vector sync (or trackTenantObjects) on a keyword-index-only resume", async () => {
    await POST(makeRequest({ resumeKeywordIndexOnly: true }));

    expect(mockedIngest).not.toHaveBeenCalled();
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests before touching AWS", async () => {
    mockedAuth.mockResolvedValue(null as never);

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(mockedIngest).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/kb/sync", () => {
  function makeStatusRequest(keys: string): Request {
    return new Request(
      `http://localhost/api/admin/kb/sync?keys=${encodeURIComponent(keys)}`,
    );
  }

  it("polls status for the given comma-separated keys", async () => {
    mockedGetStatus.mockResolvedValue([
      { key: "tenants/acme/a.pdf", status: "INDEXED" },
    ] as never);

    const res = await GET(makeStatusRequest("tenants/acme/a.pdf"));
    const data = await res.json();

    expect(mockedGetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ keys: ["tenants/acme/a.pdf"] }),
    );
    expect(data.documents).toEqual([{ key: "tenants/acme/a.pdf", status: "INDEXED" }]);
  });

  it("rejects a request with no keys", async () => {
    const res = await GET(new Request("http://localhost/api/admin/kb/sync"));
    expect(res.status).toBe(400);
  });
});
