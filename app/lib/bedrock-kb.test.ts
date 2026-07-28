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

  it("never has more than KB_SYNC_BATCH_CONCURRENCY batches in flight at once", async () => {
    // A tenant with ~2,000 files needs ~200 batched calls; running them
    // fully sequentially live-timed-out against Amplify's ~28s platform
    // limit. This pins the fix: bounded concurrency, not unbounded
    // Promise.all (which risks unknown Bedrock throttling) and not fully
    // sequential (too slow at this scale).
    process.env.KB_SYNC_BATCH_CONCURRENCY = "4";
    process.env.KB_SYNC_BATCH_PACING_MS = "0"; // isolate concurrency from pacing for this test
    let inFlight = 0;
    let maxInFlight = 0;

    sendMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { documentDetails: [] };
    });

    const keys = Array.from({ length: 97 }, (_, i) => `tenants/acme/file-${i}.pdf`);
    await ingestKnowledgeBaseDocuments({
      knowledgeBaseId: "kb-1",
      dataSourceId: "ds-1",
      bucketName: "pool-bucket",
      keys,
    });

    expect(sendMock).toHaveBeenCalledTimes(10); // ceil(97 / 10)
    expect(maxInFlight).toBe(4);

    delete process.env.KB_SYNC_BATCH_CONCURRENCY;
    delete process.env.KB_SYNC_BATCH_PACING_MS;
  });

  it("paces successive dispatches instead of refiring the instant a slot frees", async () => {
    // Live-confirmed: concurrency alone (even well under AWS's stated cap)
    // still triggered throttling with zero slack between dispatches.
    process.env.KB_SYNC_BATCH_CONCURRENCY = "1";
    process.env.KB_SYNC_BATCH_PACING_MS = "50";
    const dispatchTimes: number[] = [];

    sendMock.mockImplementation(async () => {
      dispatchTimes.push(Date.now());
      return { documentDetails: [] };
    });

    const keys = Array.from({ length: 30 }, (_, i) => `tenants/acme/file-${i}.pdf`);
    await ingestKnowledgeBaseDocuments({
      knowledgeBaseId: "kb-1",
      dataSourceId: "ds-1",
      bucketName: "pool-bucket",
      keys,
    });

    expect(dispatchTimes.length).toBe(3); // ceil(30 / 10)
    for (let i = 1; i < dispatchTimes.length; i++) {
      expect(dispatchTimes[i] - dispatchTimes[i - 1]).toBeGreaterThanOrEqual(45);
    }

    delete process.env.KB_SYNC_BATCH_CONCURRENCY;
    delete process.env.KB_SYNC_BATCH_PACING_MS;
  });

  it("stops picking up new batches once the deadline passes, but returns whatever completed", async () => {
    // A large tenant needs more batches than the account-wide rate limit
    // can clear inside one request - this is what lets a caller checkpoint:
    // submit as many batches as fit in a time budget, see exactly which
    // keys got processed via the returned results, and pick up the rest
    // (never seen here) on the next round.
    process.env.KB_SYNC_BATCH_CONCURRENCY = "1";
    process.env.KB_SYNC_BATCH_PACING_MS = "0";
    let callCount = 0;
    let clock = 0;
    const now = () => clock;

    sendMock.mockImplementation(async (command: any) => {
      callCount += 1;
      clock += 10; // simulate each call taking some time
      return {
        documentDetails: command.input.documents.map((doc: any) => ({
          identifier: { dataSourceType: "S3", s3: { uri: doc.content.s3.s3Location.uri } },
          status: "STARTING",
        })),
      };
    });

    const keys = Array.from({ length: 50 }, (_, i) => `tenants/acme/file-${i}.pdf`); // 5 batches
    const results = await ingestKnowledgeBaseDocuments(
      { knowledgeBaseId: "kb-1", dataSourceId: "ds-1", bucketName: "pool-bucket", keys },
      { deadline: 25, now },
    );

    expect(callCount).toBeLessThan(5);
    expect(results.length).toBe(callCount * 10); // only actually-dispatched batches show up

    delete process.env.KB_SYNC_BATCH_CONCURRENCY;
    delete process.env.KB_SYNC_BATCH_PACING_MS;
  });

  it("isolates one batch's failure - other concurrent batches' results still come back", async () => {
    // A single batch exhausting all retries (e.g. sustained throttling)
    // must not discard results from every other batch's concurrent worker -
    // Promise.all rejecting on one thrown worker would otherwise lose all of
    // them, forcing an entire round to be redone instead of just the one
    // batch that actually failed.
    process.env.KB_SYNC_BATCH_CONCURRENCY = "3";
    process.env.KB_SYNC_BATCH_PACING_MS = "0";

    sendMock.mockImplementation(async (command: any) => {
      const firstKey = command.input.documents[0].content.s3.s3Location.uri as string;
      if (firstKey.includes("file-10")) {
        throw new Error("ThrottlingException: exhausted retries");
      }
      return {
        documentDetails: command.input.documents.map((doc: any) => ({
          identifier: { dataSourceType: "S3", s3: { uri: doc.content.s3.s3Location.uri } },
          status: "STARTING",
        })),
      };
    });

    const keys = Array.from({ length: 30 }, (_, i) => `tenants/acme/file-${i}.pdf`); // 3 batches
    const results = await ingestKnowledgeBaseDocuments({
      knowledgeBaseId: "kb-1",
      dataSourceId: "ds-1",
      bucketName: "pool-bucket",
      keys,
    });

    // Batch 2 (keys 10-19) failed; batches 1 and 3 still succeeded.
    expect(results.length).toBe(20);
    expect(results.some((r) => r.key.includes("file-10"))).toBe(false);
    expect(results.some((r) => r.key.includes("file-0"))).toBe(true);
    expect(results.some((r) => r.key.includes("file-20"))).toBe(true);

    delete process.env.KB_SYNC_BATCH_CONCURRENCY;
    delete process.env.KB_SYNC_BATCH_PACING_MS;
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
