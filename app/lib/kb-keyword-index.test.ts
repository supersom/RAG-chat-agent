import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(function () {
    return { send: sendMock };
  }),
  GetObjectCommand: vi.fn().mockImplementation(function (input) {
    return { __type: "GetObjectCommand", input };
  }),
  ListObjectsV2Command: vi.fn().mockImplementation(function (input) {
    return { __type: "ListObjectsV2Command", input };
  }),
  PutObjectCommand: vi.fn().mockImplementation(function (input) {
    return { __type: "PutObjectCommand", input };
  }),
}));

import { reconcileKeywordIndex, searchKeywordIndex, extractText } from "./kb-keyword-index";
import DOMMatrixShim from "@thednp/dommatrix";
import Database from "better-sqlite3";

// Minimal single-page PDF with one text line - enough for pdfjs-dist to
// parse without needing a real PDF fixture on disk.
const MINIMAL_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 40 >>
stream
BT /F1 18 Tf 20 100 Td (hello world) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f
trailer
<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF`,
  "utf8",
);

const TENANT_ID = "test-tenant-checkpoint";
const KB_ID = "test-kb-checkpoint";
const BUCKET = "test-bucket";

function tempDbPathFor(tenantId: string, knowledgeBaseId: string) {
  const hash = crypto
    .createHash("sha256")
    .update(`${tenantId}:${knowledgeBaseId}`)
    .digest("hex")
    .slice(0, 12);
  return path.join(os.tmpdir(), `customer-support-agent-keyword-${hash}.sqlite`);
}

function cleanupTempDb() {
  const dbPath = tempDbPathFor(TENANT_ID, KB_ID);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
}

beforeEach(() => {
  sendMock.mockReset();
  process.env.BAWS_ACCESS_KEY_ID = "AKIA_TEST";
  process.env.BAWS_SECRET_ACCESS_KEY = "secret";
  cleanupTempDb();
});

afterEach(() => {
  cleanupTempDb();
});

describe("reconcileKeywordIndex checkpointing", () => {
  it("resumes from a checkpoint instead of re-listing and re-processing already-completed objects", async () => {
    let storedIndexBody: Buffer | null = null;

    const s3Objects = [
      {
        Key: "a.txt",
        ETag: '"etag-a"',
        Size: 10,
        LastModified: new Date("2026-01-01T00:00:00Z"),
      },
      {
        Key: "b.txt",
        ETag: '"etag-b"',
        Size: 10,
        LastModified: new Date("2026-01-01T00:00:00Z"),
      },
    ];

    sendMock.mockImplementation(async (command: any) => {
      const type = command.__type;
      if (type === "GetObjectCommand") {
        const key = command.input.Key as string;
        if (key.endsWith(".sqlite")) {
          if (!storedIndexBody) {
            const err: any = new Error("NoSuchKey");
            err.name = "NoSuchKey";
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          return { Body: storedIndexBody };
        }
        const content = key === "a.txt" ? "alpha content" : "beta content";
        return { Body: Buffer.from(content, "utf8") };
      }
      if (type === "ListObjectsV2Command") {
        return { Contents: s3Objects, IsTruncated: false };
      }
      if (type === "PutObjectCommand") {
        storedIndexBody = Buffer.from(command.input.Body);
        return {};
      }
      throw new Error(`Unexpected command: ${type}`);
    });

    // Round 1: zero time budget - should stop before processing any object,
    // checkpoint both queued objects into the .sqlite file, and report partial.
    const result1 = await reconcileKeywordIndex({
      tenantId: TENANT_ID,
      knowledgeBaseId: KB_ID,
      bucketName: BUCKET,
      timeBudgetMs: 0,
      now: () => 1_000_000,
    });

    expect(result1.partial).toBe(true);
    expect(result1.listedObjectCount).toBe(2);
    expect(result1.changedObjectCount).toBe(2);
    expect(result1.indexedObjectCount).toBe(0);

    const listCallsAfterRound1 = sendMock.mock.calls.filter(
      ([cmd]: any) => cmd.__type === "ListObjectsV2Command",
    ).length;
    expect(listCallsAfterRound1).toBe(1);

    // Round 2: generous time budget - should resume from the checkpoint (no
    // re-listing), finish both remaining queued objects, and report totals
    // accumulated across both rounds, not just this round's work.
    const result2 = await reconcileKeywordIndex({
      tenantId: TENANT_ID,
      knowledgeBaseId: KB_ID,
      bucketName: BUCKET,
      timeBudgetMs: 60_000,
      now: () => 1_000_000,
    });

    expect(result2.partial).toBe(false);
    expect(result2.listedObjectCount).toBe(2);
    expect(result2.changedObjectCount).toBe(2);
    expect(result2.indexedObjectCount).toBe(2);
    expect(result2.indexedChunkCount).toBe(2);

    const listCallsAfterRound2 = sendMock.mock.calls.filter(
      ([cmd]: any) => cmd.__type === "ListObjectsV2Command",
    ).length;
    expect(listCallsAfterRound2).toBe(1);
  });
});

describe("extractText DOMMatrix polyfill", () => {
  const originalDOMMatrix = (globalThis as any).DOMMatrix;

  afterEach(() => {
    if (originalDOMMatrix === undefined) {
      delete (globalThis as any).DOMMatrix;
    } else {
      (globalThis as any).DOMMatrix = originalDOMMatrix;
    }
  });

  it("installs a global DOMMatrix polyfill before parsing a PDF, when none is set", async () => {
    delete (globalThis as any).DOMMatrix;

    await extractText(MINIMAL_PDF, "doc.pdf");

    expect((globalThis as any).DOMMatrix).toBe(DOMMatrixShim);
  });

  it("does not overwrite an already-present global DOMMatrix", async () => {
    class ExistingDOMMatrix {}
    (globalThis as any).DOMMatrix = ExistingDOMMatrix;

    await extractText(MINIMAL_PDF, "doc.pdf");

    expect((globalThis as any).DOMMatrix).toBe(ExistingDOMMatrix);
  });
});

describe("extractText PDF worker handler", () => {
  const originalPdfjsWorker = (globalThis as any).pdfjsWorker;

  afterEach(() => {
    if (originalPdfjsWorker === undefined) {
      delete (globalThis as any).pdfjsWorker;
    } else {
      (globalThis as any).pdfjsWorker = originalPdfjsWorker;
    }
  });

  it("installs a main-thread pdfjsWorker handler before parsing a PDF, when none is set", async () => {
    delete (globalThis as any).pdfjsWorker;

    await extractText(MINIMAL_PDF, "doc.pdf");

    expect(typeof (globalThis as any).pdfjsWorker?.WorkerMessageHandler).toBe("function");
  });

  it("does not overwrite an already-present pdfjsWorker handler", async () => {
    const sentinel = { WorkerMessageHandler: function ExistingHandler() {} };
    (globalThis as any).pdfjsWorker = sentinel;

    await extractText(MINIMAL_PDF, "doc.pdf");

    expect((globalThis as any).pdfjsWorker).toBe(sentinel);
  });
});

describe("reconcileKeywordIndex oversized-PDF skip", () => {
  const OVERSIZE_TENANT_ID = "test-tenant-oversize";
  const OVERSIZE_KB_ID = "test-kb-oversize";

  function oversizeDbPath() {
    return tempDbPathFor(OVERSIZE_TENANT_ID, OVERSIZE_KB_ID);
  }

  beforeEach(() => {
    if (fs.existsSync(oversizeDbPath())) fs.unlinkSync(oversizeDbPath());
  });

  afterEach(() => {
    if (fs.existsSync(oversizeDbPath())) fs.unlinkSync(oversizeDbPath());
  });

  it("skips a PDF over the size cap without downloading it, but still processes a small one", async () => {
    let storedIndexBody: Buffer | null = null;
    const downloadedKeys: string[] = [];

    const s3Objects = [
      {
        Key: "huge.pdf",
        ETag: '"etag-huge"',
        Size: 20 * 1024 * 1024,
        LastModified: new Date("2026-01-01T00:00:00Z"),
      },
      {
        Key: "small.pdf",
        ETag: '"etag-small"',
        Size: 1000,
        LastModified: new Date("2026-01-01T00:00:00Z"),
      },
    ];

    sendMock.mockImplementation(async (command: any) => {
      const type = command.__type;
      if (type === "GetObjectCommand") {
        const key = command.input.Key as string;
        if (key.endsWith(".sqlite")) {
          if (!storedIndexBody) {
            const err: any = new Error("NoSuchKey");
            err.name = "NoSuchKey";
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          return { Body: storedIndexBody };
        }
        downloadedKeys.push(key);
        return { Body: MINIMAL_PDF };
      }
      if (type === "ListObjectsV2Command") {
        return { Contents: s3Objects, IsTruncated: false };
      }
      if (type === "PutObjectCommand") {
        storedIndexBody = Buffer.from(command.input.Body);
        return {};
      }
      throw new Error(`Unexpected command: ${type}`);
    });

    const result = await reconcileKeywordIndex({
      tenantId: OVERSIZE_TENANT_ID,
      knowledgeBaseId: OVERSIZE_KB_ID,
      bucketName: BUCKET,
      timeBudgetMs: 60_000,
      now: () => 1_000_000,
      maxPdfBytes: 12 * 1024 * 1024,
    });

    expect(result.skippedObjectCount).toBe(1);
    expect(result.indexedObjectCount).toBe(1);
    expect(downloadedKeys).toEqual(["small.pdf"]);
  });
});

describe("keyword index tenant isolation in a pooled bucket", () => {
  const TENANT_A = "tenant-a-pool";
  const TENANT_B = "tenant-b-pool";
  const POOL_KB_ID = "pool-kb";
  const POOL_BUCKET = "css-agent-kb-pool-src";

  const poolObjects = [
    {
      Key: `tenants/${TENANT_A}/a-materiality.txt`,
      ETag: '"etag-a"',
      Size: 40,
      LastModified: new Date("2026-01-01T00:00:00Z"),
    },
    {
      Key: `tenants/${TENANT_A}/a-materiality.txt.metadata.json`,
      ETag: '"etag-a-sidecar"',
      Size: 60,
      LastModified: new Date("2026-01-01T00:00:00Z"),
    },
    {
      Key: `tenants/${TENANT_B}/b-materiality.txt`,
      ETag: '"etag-b"',
      Size: 40,
      LastModified: new Date("2026-01-01T00:00:00Z"),
    },
    {
      Key: `tenants/${TENANT_B}/b-materiality.txt.metadata.json`,
      ETag: '"etag-b-sidecar"',
      Size: 60,
      LastModified: new Date("2026-01-01T00:00:00Z"),
    },
  ];

  const bodyForKey: Record<string, string> = {
    [`tenants/${TENANT_A}/a-materiality.txt`]:
      "tenant A materiality threshold is 5 percent of pre-tax income",
    [`tenants/${TENANT_B}/b-materiality.txt`]:
      "tenant B materiality threshold is 1 percent of total assets",
    [`tenants/${TENANT_A}/a-materiality.txt.metadata.json`]: JSON.stringify({
      metadataAttributes: { tenantId: TENANT_A },
    }),
    [`tenants/${TENANT_B}/b-materiality.txt.metadata.json`]: JSON.stringify({
      metadataAttributes: { tenantId: TENANT_B },
    }),
  };

  function poolDbPath(tenantId: string) {
    return tempDbPathFor(tenantId, POOL_KB_ID);
  }

  function removePoolDbs() {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      const dbPath = poolDbPath(tenantId);
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  }

  beforeEach(removePoolDbs);
  afterEach(removePoolDbs);

  it("indexes only the requesting tenant's namespace, never another tenant's objects", async () => {
    let storedIndexBody: Buffer | null = null;
    const downloadedKeys: string[] = [];

    sendMock.mockImplementation(async (command: any) => {
      const type = command.__type;
      if (type === "GetObjectCommand") {
        const key = command.input.Key as string;
        if (key.endsWith(".sqlite")) {
          if (!storedIndexBody) {
            const err: any = new Error("NoSuchKey");
            err.name = "NoSuchKey";
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          return { Body: storedIndexBody };
        }
        downloadedKeys.push(key);
        return { Body: Buffer.from(bodyForKey[key] ?? "", "utf8") };
      }
      if (type === "ListObjectsV2Command") {
        // Faithful S3 semantics: the server applies Prefix, the client does not.
        const prefix = (command.input.Prefix as string) || "";
        return {
          Contents: poolObjects.filter((object) => object.Key.startsWith(prefix)),
          IsTruncated: false,
        };
      }
      if (type === "PutObjectCommand") {
        storedIndexBody = Buffer.from(command.input.Body);
        return {};
      }
      throw new Error(`Unexpected command: ${type}`);
    });

    const result = await reconcileKeywordIndex({
      tenantId: TENANT_A,
      knowledgeBaseId: POOL_KB_ID,
      bucketName: POOL_BUCKET,
      timeBudgetMs: 60_000,
      now: () => 1_000_000,
    });

    // Only A's document: B's document and both .metadata.json sidecars are out.
    expect(result.listedObjectCount).toBe(1);
    expect(result.indexedObjectCount).toBe(1);
    expect(downloadedKeys).toEqual([`tenants/${TENANT_A}/a-materiality.txt`]);

    const listedPrefixes = sendMock.mock.calls
      .filter(([cmd]: any) => cmd.__type === "ListObjectsV2Command")
      .map(([cmd]: any) => cmd.input.Prefix);
    expect(listedPrefixes).toContain(`tenants/${TENANT_A}/`);

    const hits = await searchKeywordIndex({
      tenantId: TENANT_A,
      knowledgeBaseId: POOL_KB_ID,
      bucketName: POOL_BUCKET,
      query: "materiality threshold",
      limit: 10,
    });

    expect(hits.length).toBe(1);
    expect(hits[0].s3Uri).toBe(
      `s3://${POOL_BUCKET}/tenants/${TENANT_A}/a-materiality.txt`,
    );
    expect(hits.some((hit) => hit.s3Uri?.includes(`tenants/${TENANT_B}/`))).toBe(false);
  });

  it("does not return another tenant's rows from an index built before tenant scoping existed", async () => {
    // A pre-fix index: every object in the pool bucket was listed and stamped
    // with tenant A's id, including tenant B's document. The tenant_id column
    // alone cannot catch this - only the key prefix can.
    const stalePath = path.join(os.tmpdir(), `stale-pool-index-${Date.now()}.sqlite`);
    const stale = new Database(stalePath);
    stale.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        knowledge_base_id TEXT NOT NULL,
        bucket TEXT NOT NULL,
        s3_key TEXT NOT NULL,
        etag TEXT,
        size INTEGER,
        last_modified TEXT,
        indexed_at TEXT NOT NULL,
        UNIQUE(tenant_id, knowledge_base_id, bucket, s3_key)
      );
      CREATE VIRTUAL TABLE chunks USING fts5(
        tenant_id UNINDEXED,
        knowledge_base_id UNINDEXED,
        bucket UNINDEXED,
        s3_key UNINDEXED,
        chunk_index UNINDEXED,
        file_name,
        body,
        tokenize = 'unicode61'
      );
    `);
    const insertDoc = stale.prepare(
      `INSERT INTO documents (tenant_id, knowledge_base_id, bucket, s3_key, etag, size, last_modified, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertChunk = stale.prepare(
      `INSERT INTO chunks (rowid, tenant_id, knowledge_base_id, bucket, s3_key, chunk_index, file_name, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    [
      `tenants/${TENANT_A}/a-materiality.txt`,
      `tenants/${TENANT_B}/b-materiality.txt`,
    ].forEach((key, index) => {
      insertDoc.run(
        TENANT_A,
        POOL_KB_ID,
        POOL_BUCKET,
        key,
        null,
        null,
        null,
        new Date().toISOString(),
      );
      insertChunk.run(
        index + 1,
        TENANT_A,
        POOL_KB_ID,
        POOL_BUCKET,
        key,
        0,
        key.split("/").pop(),
        bodyForKey[key],
      );
    });
    stale.close();
    const staleBody = fs.readFileSync(stalePath);
    fs.unlinkSync(stalePath);

    sendMock.mockImplementation(async (command: any) => {
      if (command.__type === "GetObjectCommand") return { Body: staleBody };
      throw new Error(`Unexpected command: ${command.__type}`);
    });

    const hits = await searchKeywordIndex({
      tenantId: TENANT_A,
      knowledgeBaseId: POOL_KB_ID,
      bucketName: POOL_BUCKET,
      query: "materiality threshold",
      limit: 10,
    });

    expect(hits.map((hit) => hit.s3Uri)).toEqual([
      `s3://${POOL_BUCKET}/tenants/${TENANT_A}/a-materiality.txt`,
    ]);
  });
});

describe("keyword index on a legacy (non-namespaced) bucket", () => {
  const LEGACY_TENANT = "tenant-legacy";
  const LEGACY_KB_ID = "SLXQFWWXPR";
  const LEGACY_BUCKET = "claude-qkstrt-kb";

  const legacyObjects = [
    {
      Key: "handbook.txt",
      ETag: '"etag-handbook"',
      Size: 30,
      LastModified: new Date("2026-01-01T00:00:00Z"),
    },
    {
      Key: "policies/refunds.txt",
      ETag: '"etag-refunds"',
      Size: 30,
      LastModified: new Date("2026-01-01T00:00:00Z"),
    },
  ];

  function legacyDbPath() {
    return tempDbPathFor(LEGACY_TENANT, LEGACY_KB_ID);
  }

  function removeLegacyDb() {
    if (fs.existsSync(legacyDbPath())) fs.unlinkSync(legacyDbPath());
  }

  beforeEach(removeLegacyDb);
  afterEach(removeLegacyDb);

  it("still indexes and searches flat keys that have no tenants/ prefix", async () => {
    let storedIndexBody: Buffer | null = null;

    sendMock.mockImplementation(async (command: any) => {
      const type = command.__type;
      if (type === "GetObjectCommand") {
        const key = command.input.Key as string;
        if (key.endsWith(".sqlite")) {
          if (!storedIndexBody) {
            const err: any = new Error("NoSuchKey");
            err.name = "NoSuchKey";
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          return { Body: storedIndexBody };
        }
        return { Body: Buffer.from("refund policy handbook materiality", "utf8") };
      }
      if (type === "ListObjectsV2Command") {
        const prefix = (command.input.Prefix as string) || "";
        return {
          Contents: legacyObjects.filter((object) => object.Key.startsWith(prefix)),
          IsTruncated: false,
        };
      }
      if (type === "PutObjectCommand") {
        storedIndexBody = Buffer.from(command.input.Body);
        return {};
      }
      throw new Error(`Unexpected command: ${type}`);
    });

    const result = await reconcileKeywordIndex({
      tenantId: LEGACY_TENANT,
      knowledgeBaseId: LEGACY_KB_ID,
      bucketName: LEGACY_BUCKET,
      timeBudgetMs: 60_000,
      now: () => 1_000_000,
    });

    expect(result.listedObjectCount).toBe(2);
    expect(result.indexedObjectCount).toBe(2);

    const hits = await searchKeywordIndex({
      tenantId: LEGACY_TENANT,
      knowledgeBaseId: LEGACY_KB_ID,
      bucketName: LEGACY_BUCKET,
      query: "refund policy",
      limit: 10,
    });

    expect(hits.length).toBe(2);
  });
});
