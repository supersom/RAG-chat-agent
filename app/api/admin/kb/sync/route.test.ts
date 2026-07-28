import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/app/lib/db/tenants", () => ({
  getTenant: vi.fn(),
}));

vi.mock("@/app/lib/bedrock-kb", () => ({
  getKbDataSource: vi.fn(),
  startKbIngestion: vi.fn(),
  getKbIngestionStatus: vi.fn(),
}));

vi.mock("@/app/lib/kb-keyword-index", () => ({
  reconcileKeywordIndex: vi.fn(),
}));

import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import { getKbDataSource, startKbIngestion } from "@/app/lib/bedrock-kb";
import { reconcileKeywordIndex } from "@/app/lib/kb-keyword-index";
import { POST } from "./route";

const mockedAuth = vi.mocked(auth);
const mockedGetTenant = vi.mocked(getTenant);
const mockedGetKbDataSource = vi.mocked(getKbDataSource);
const mockedStartKbIngestion = vi.mocked(startKbIngestion);
const mockedReconcileKeywordIndex = vi.mocked(reconcileKeywordIndex);

function makeRequest(): Request {
  return new Request("http://localhost/api/admin/kb/sync", { method: "POST" });
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedGetTenant.mockReset();
  mockedGetKbDataSource.mockReset();
  mockedStartKbIngestion.mockReset();
  mockedReconcileKeywordIndex.mockReset();

  mockedAuth.mockResolvedValue({
    user: { role: "admin", tenantId: "acme" },
  } as never);
  mockedGetKbDataSource.mockResolvedValue({
    dataSourceId: "ds-1",
    bucketName: "pooled-bucket",
  } as never);
  mockedStartKbIngestion.mockResolvedValue("job-1" as never);
  mockedReconcileKeywordIndex.mockResolvedValue({
    mode: "reconcile",
    partial: false,
  } as never);
});

describe("POST /api/admin/kb/sync", () => {
  it("reconciles the keyword index by default", async () => {
    mockedGetTenant.mockResolvedValue({
      tenantId: "acme",
      knowledgeBaseId: "kb-acme",
      awsRegion: "us-east-2",
    } as never);

    const res = await POST(makeRequest());
    const data = await res.json();

    expect(mockedReconcileKeywordIndex).toHaveBeenCalledTimes(1);
    expect(data.keywordIndex).not.toBeNull();
  });

  it("skips keyword-index reconciliation when the tenant has disableKeywordSearch set", async () => {
    mockedGetTenant.mockResolvedValue({
      tenantId: "acme",
      knowledgeBaseId: "kb-acme",
      awsRegion: "us-east-2",
      disableKeywordSearch: true,
    } as never);

    const res = await POST(makeRequest());
    const data = await res.json();

    expect(mockedReconcileKeywordIndex).not.toHaveBeenCalled();
    expect(data.keywordIndex).toBeNull();
    expect(data.keywordIndexError).toBeNull();
    // The vector KB ingestion job is a separate toggle and must still run.
    expect(mockedStartKbIngestion).toHaveBeenCalledTimes(1);
  });
});
