import { describe, expect, it, vi, beforeEach } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@aws-sdk/client-bedrock-agent", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-bedrock-agent")>(
    "@aws-sdk/client-bedrock-agent",
  );
  return {
    ...actual,
    BedrockAgentClient: vi.fn().mockImplementation(function () {
      return { send: sendMock };
    }),
  };
});

import {
  IngestKnowledgeBaseDocumentsCommand,
  DeleteKnowledgeBaseDocumentsCommand,
  GetKnowledgeBaseDocumentsCommand,
} from "@aws-sdk/client-bedrock-agent";
import {
  ingestKnowledgeBaseDocuments,
  deleteKnowledgeBaseDocuments,
  getKnowledgeBaseDocumentsStatus,
} from "./bedrock-kb";

function detailFor(bucketName: string, key: string, status = "STARTING") {
  return {
    identifier: { dataSourceType: "S3", s3: { uri: `s3://${bucketName}/${key}` } },
    status,
  };
}

beforeEach(() => {
  sendMock.mockReset();
  process.env.BAWS_ACCESS_KEY_ID = "test-key";
  process.env.BAWS_SECRET_ACCESS_KEY = "test-secret";
});

describe("ingestKnowledgeBaseDocuments", () => {
  it("returns an empty result without calling AWS when given no keys", async () => {
    const result = await ingestKnowledgeBaseDocuments({
      knowledgeBaseId: "kb-1",
      dataSourceId: "ds-1",
      bucketName: "pool-bucket",
      keys: [],
    });

    expect(result).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("points metadata at the object's .metadata.json sidecar, not inline attributes", async () => {
    // Live-verified against real Bedrock: an S3 data source rejects inline
    // metadata attributes paired with S3-sourced content ("You can only
    // upload content and metadata from S3 if your knowledge base is
    // connected to an S3 data source").
    sendMock.mockResolvedValue({
      documentDetails: [detailFor("pool-bucket", "tenants/acme/a.pdf")],
    });

    await ingestKnowledgeBaseDocuments({
      knowledgeBaseId: "kb-1",
      dataSourceId: "ds-1",
      bucketName: "pool-bucket",
      keys: ["tenants/acme/a.pdf"],
    });

    const command = sendMock.mock.calls[0][0];
    expect(command).toBeInstanceOf(IngestKnowledgeBaseDocumentsCommand);
    expect(command.input.documents[0]).toMatchObject({
      content: {
        dataSourceType: "S3",
        s3: { s3Location: { uri: "s3://pool-bucket/tenants/acme/a.pdf" } },
      },
      metadata: {
        type: "S3_LOCATION",
        s3Location: { uri: "s3://pool-bucket/tenants/acme/a.pdf.metadata.json" },
      },
    });
  });

  it("batches more than 10 keys into multiple calls", async () => {
    sendMock.mockResolvedValue({ documentDetails: [] });
    const keys = Array.from({ length: 23 }, (_, i) => `tenants/acme/file-${i}.pdf`);

    await ingestKnowledgeBaseDocuments({
      knowledgeBaseId: "kb-1",
      dataSourceId: "ds-1",
      bucketName: "pool-bucket",
      keys,
    });

    expect(sendMock).toHaveBeenCalledTimes(3);
    const batchSizes = sendMock.mock.calls.map((call) => call[0].input.documents.length);
    expect(batchSizes).toEqual([10, 10, 3]);
  });

  it("maps returned document details back to their S3 key", async () => {
    sendMock.mockResolvedValue({
      documentDetails: [detailFor("pool-bucket", "tenants/acme/a.pdf", "INDEXED")],
    });

    const result = await ingestKnowledgeBaseDocuments({
      knowledgeBaseId: "kb-1",
      dataSourceId: "ds-1",
      bucketName: "pool-bucket",
      keys: ["tenants/acme/a.pdf"],
    });

    expect(result).toEqual([
      { key: "tenants/acme/a.pdf", status: "INDEXED", statusReason: undefined },
    ]);
  });
});

describe("deleteKnowledgeBaseDocuments", () => {
  it("identifies documents to delete by S3 URI, not tenantId", async () => {
    sendMock.mockResolvedValue({
      documentDetails: [detailFor("pool-bucket", "tenants/acme/old.pdf", "DELETING")],
    });

    await deleteKnowledgeBaseDocuments({
      knowledgeBaseId: "kb-1",
      dataSourceId: "ds-1",
      bucketName: "pool-bucket",
      keys: ["tenants/acme/old.pdf"],
    });

    const command = sendMock.mock.calls[0][0];
    expect(command).toBeInstanceOf(DeleteKnowledgeBaseDocumentsCommand);
    expect(command.input.documentIdentifiers[0]).toEqual({
      dataSourceType: "S3",
      s3: { uri: "s3://pool-bucket/tenants/acme/old.pdf" },
    });
  });

  it("returns an empty result without calling AWS when given no keys", async () => {
    const result = await deleteKnowledgeBaseDocuments({
      knowledgeBaseId: "kb-1",
      dataSourceId: "ds-1",
      bucketName: "pool-bucket",
      keys: [],
    });

    expect(result).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("getKnowledgeBaseDocumentsStatus", () => {
  it("polls status for the given keys via GetKnowledgeBaseDocuments", async () => {
    sendMock.mockResolvedValue({
      documentDetails: [detailFor("pool-bucket", "tenants/acme/a.pdf", "INDEXED")],
    });

    const result = await getKnowledgeBaseDocumentsStatus({
      knowledgeBaseId: "kb-1",
      dataSourceId: "ds-1",
      bucketName: "pool-bucket",
      keys: ["tenants/acme/a.pdf"],
    });

    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(GetKnowledgeBaseDocumentsCommand);
    expect(result).toEqual([
      { key: "tenants/acme/a.pdf", status: "INDEXED", statusReason: undefined },
    ]);
  });
});
