import { describe, expect, it, vi, beforeEach } from "vitest";

const { sendMock, getSignedUrlMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getSignedUrlMock: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/app/lib/db/tenants", () => ({
  getTenant: vi.fn(),
  isKnowledgeBaseSharedWithOtherTenants: vi.fn(),
}));

vi.mock("@/app/lib/bedrock-kb", () => ({
  getKbDataSource: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(function () {
    return { send: sendMock };
  }),
  PutObjectCommand: vi.fn().mockImplementation(function (input) {
    return { input };
  }),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { auth } from "@/auth";
import { getTenant, isKnowledgeBaseSharedWithOtherTenants } from "@/app/lib/db/tenants";
import { getKbDataSource } from "@/app/lib/bedrock-kb";
import { POST } from "./route";

const mockedAuth = vi.mocked(auth);
const mockedGetTenant = vi.mocked(getTenant);
const mockedIsShared = vi.mocked(isKnowledgeBaseSharedWithOtherTenants);
const mockedGetKbDataSource = vi.mocked(getKbDataSource);
const mockedPutObjectCommand = vi.mocked(PutObjectCommand);

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/kb/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
  getSignedUrlMock.mockReset();
  getSignedUrlMock.mockResolvedValue("https://signed.example.com/upload");
  mockedPutObjectCommand.mockClear();
  mockedAuth.mockReset();
  mockedGetTenant.mockReset();
  mockedIsShared.mockReset();
  mockedIsShared.mockResolvedValue(false);
  mockedGetKbDataSource.mockReset();
  mockedGetKbDataSource.mockResolvedValue({
    dataSourceId: "ds-1",
    bucketName: "pooled-bucket",
  });

  mockedAuth.mockResolvedValue({
    user: { role: "admin", tenantId: "acme" },
  } as never);
  mockedGetTenant.mockResolvedValue({
    tenantId: "acme",
    name: "Acme",
    knowledgeBaseId: "kb-acme",
  } as never);
});

describe("POST /api/admin/kb/upload-url", () => {
  it("namespaces the object key under the server-resolved tenantId", async () => {
    const res = await POST(makeRequest({ filename: "handbook.pdf" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.key).toBe("tenants/acme/handbook.pdf");
  });

  it("writes a metadata sidecar via a direct (non-presigned) PutObjectCommand", async () => {
    await POST(makeRequest({ filename: "handbook.pdf" }));

    expect(sendMock).toHaveBeenCalledTimes(1);
    const sidecarInput = mockedPutObjectCommand.mock.calls[1][0] as {
      Bucket: string;
      Key: string;
      Body: string;
      ContentType: string;
    };

    expect(sidecarInput.Bucket).toBe("pooled-bucket");
    expect(sidecarInput.Key).toBe("tenants/acme/handbook.pdf.metadata.json");
    expect(sidecarInput.ContentType).toBe("application/json");
    expect(JSON.parse(sidecarInput.Body)).toEqual({
      metadataAttributes: { tenantId: "acme" },
    });
  });

  it("sources the sidecar tenantId from the server-resolved tenant, not the client body", async () => {
    // The request schema has no tenantId field at all, but this test pins
    // the behavior: even if a client body carried one, it must be ignored
    // in favor of what getTenant() resolved server-side.
    await POST(
      makeRequest({ filename: "handbook.pdf", tenantId: "attacker-tenant" }),
    );

    const sidecarInput = mockedPutObjectCommand.mock.calls[1][0] as {
      Body: string;
    };
    expect(JSON.parse(sidecarInput.Body)).toEqual({
      metadataAttributes: { tenantId: "acme" },
    });
  });

  it("presigns only the document PUT, not the sidecar", async () => {
    await POST(makeRequest({ filename: "handbook.pdf" }));

    expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
    const presignedInput = mockedPutObjectCommand.mock.calls[0][0] as {
      Key: string;
    };
    expect(presignedInput.Key).toBe("tenants/acme/handbook.pdf");
  });

  it("rejects unauthenticated requests before touching S3", async () => {
    mockedAuth.mockResolvedValue(null as never);

    const res = await POST(makeRequest({ filename: "handbook.pdf" }));

    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });

  it("rejects non-admin requests before touching S3", async () => {
    mockedAuth.mockResolvedValue({
      user: { role: "end_user", tenantId: "acme" },
    } as never);

    const res = await POST(makeRequest({ filename: "handbook.pdf" }));

    expect(res.status).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
