import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/app/lib/db/tenants", () => ({
  getTenant: vi.fn(),
}));

vi.mock("@/app/lib/bedrock-kb", () => ({
  getKbDataSource: vi.fn(),
  getKnowledgeBaseDocumentsStatus: vi.fn(),
}));

import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import { getKbDataSource, getKnowledgeBaseDocumentsStatus } from "@/app/lib/bedrock-kb";
import { POST } from "./route";

const mockedAuth = vi.mocked(auth);
const mockedGetTenant = vi.mocked(getTenant);
const mockedGetKbDataSource = vi.mocked(getKbDataSource);
const mockedGetStatus = vi.mocked(getKnowledgeBaseDocumentsStatus);

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/kb/sync/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedGetTenant.mockReset();
  mockedGetKbDataSource.mockReset();
  mockedGetStatus.mockReset();

  mockedAuth.mockResolvedValue({
    user: { role: "admin", tenantId: "acme" },
  } as never);
  mockedGetTenant.mockResolvedValue({
    tenantId: "acme",
    knowledgeBaseId: "kb-acme",
  } as never);
  mockedGetKbDataSource.mockResolvedValue({
    dataSourceId: "ds-1",
    bucketName: "pooled-bucket",
  } as never);
});

describe("POST /api/admin/kb/sync/status", () => {
  it("polls status for the given keys, carried in the body rather than a URL", async () => {
    mockedGetStatus.mockResolvedValue([
      { key: "tenants/acme/a.pdf", status: "INDEXED" },
    ] as never);

    const res = await POST(makeRequest({ keys: ["tenants/acme/a.pdf"] }));
    const data = await res.json();

    expect(mockedGetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ keys: ["tenants/acme/a.pdf"] }),
    );
    expect(data.documents).toEqual([{ key: "tenants/acme/a.pdf", status: "INDEXED" }]);
  });

  it("handles a very large key list that would never fit in a URL query string", async () => {
    const keys = Array.from({ length: 2000 }, (_, i) => `tenants/acme/pdfs/file-${i}.pdf`);
    mockedGetStatus.mockResolvedValue([]);

    const res = await POST(makeRequest({ keys }));

    expect(res.status).toBe(200);
    expect(mockedGetStatus).toHaveBeenCalledWith(expect.objectContaining({ keys }));
  });

  it("rejects a request with no keys", async () => {
    const res = await POST(makeRequest({ keys: [] }));
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated requests before touching AWS", async () => {
    mockedAuth.mockResolvedValue(null as never);

    const res = await POST(makeRequest({ keys: ["a"] }));

    expect(res.status).toBe(401);
    expect(mockedGetStatus).not.toHaveBeenCalled();
  });
});
