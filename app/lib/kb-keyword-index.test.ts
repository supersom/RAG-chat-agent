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
  HeadObjectCommand: vi.fn().mockImplementation(function (input) {
    return { __type: "HeadObjectCommand", input };
  }),
  ListObjectsV2Command: vi.fn().mockImplementation(function (input) {
    return { __type: "ListObjectsV2Command", input };
  }),
  PutObjectCommand: vi.fn().mockImplementation(function (input) {
    return { __type: "PutObjectCommand", input };
  }),
}));

const ingestMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("@/app/lib/bedrock-kb", () => ({
  ingestKnowledgeBaseDocuments: (...args: unknown[]) => ingestMock(...args),
  deleteKnowledgeBaseDocuments: (...args: unknown[]) => deleteMock(...args),
}));

import {
  reconcileKeywordIndex,
  searchKeywordIndex,
  extractText,
  trackTenantObjects,
  submitVectorSync,
  awsCredentials,
} from "./kb-keyword-index";
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

function tempTrackingDbPathFor(tenantId: string, knowledgeBaseId: string) {
  const hash = crypto
    .createHash("sha256")
    .update(`tracking:${tenantId}:${knowledgeBaseId}`)
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
  ingestMock.mockReset();
  deleteMock.mockReset();
  process.env.BAWS_ACCESS_KEY_ID = "AKIA_TEST";
  process.env.BAWS_SECRET_ACCESS_KEY = "secret";
  cleanupTempDb();
});

afterEach(() => {
  cleanupTempDb();
});

describe("awsCredentials", () => {
  const originalAccessKey = process.env.BAWS_ACCESS_KEY_ID;
  const originalSecretKey = process.env.BAWS_SECRET_ACCESS_KEY;

  afterEach(() => {
    if (originalAccessKey === undefined) delete process.env.BAWS_ACCESS_KEY_ID;
    else process.env.BAWS_ACCESS_KEY_ID = originalAccessKey;
    if (originalSecretKey === undefined) delete process.env.BAWS_SECRET_ACCESS_KEY;
    else process.env.BAWS_SECRET_ACCESS_KEY = originalSecretKey;
  });

  it("returns explicit credentials when provided", () => {
    expect(
      awsCredentials({ accessKeyId: "explicit-key", secretAccessKey: "explicit-secret" }),
    ).toEqual({ accessKeyId: "explicit-key", secretAccessKey: "explicit-secret" });
  });

  it("falls back to BAWS_* env vars when no explicit credentials given", () => {
    process.env.BAWS_ACCESS_KEY_ID = "env-key";
    process.env.BAWS_SECRET_ACCESS_KEY = "env-secret";

    expect(awsCredentials(undefined)).toEqual({
      accessKeyId: "env-key",
      secretAccessKey: "env-secret",
    });
  });

  it("returns undefined when neither explicit credentials nor BAWS_* env vars are present, so the AWS SDK's own default provider chain (e.g. a Lambda execution role) takes over", () => {
    delete process.env.BAWS_ACCESS_KEY_ID;
    delete process.env.BAWS_SECRET_ACCESS_KEY;

    expect(awsCredentials(undefined)).toBeUndefined();
  });
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

describe("reconcileKeywordIndex full mode", () => {
  it("re-processes every listed object in full mode, even ones S3 reports unchanged - unlike the default (incremental) behavior, which skips them", async () => {
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

    // First run (default/incremental): indexes both objects, nothing to
    // skip yet since nothing was tracked before this.
    const first = await reconcileKeywordIndex({
      tenantId: TENANT_ID,
      knowledgeBaseId: KB_ID,
      bucketName: BUCKET,
      timeBudgetMs: 60_000,
      now: () => 1_000_000,
    });
    expect(first.indexedObjectCount).toBe(2);

    // Second run, same (unchanged) S3 state, default mode: both objects
    // are now tracked with matching etag/size/lastModified, so the
    // existing incremental diff skips them entirely.
    const incremental = await reconcileKeywordIndex({
      tenantId: TENANT_ID,
      knowledgeBaseId: KB_ID,
      bucketName: BUCKET,
      timeBudgetMs: 60_000,
      now: () => 1_000_000,
    });
    expect(incremental.changedObjectCount).toBe(0);
    expect(incremental.unchangedObjectCount).toBe(2);
    expect(incremental.indexedObjectCount).toBe(0);

    // Third run, same unchanged S3 state, mode: "full" - every listed
    // object must be treated as needing reprocessing, not just genuinely
    // changed ones. This is what lets an admin recover a document whose
    // chunks were silently lost to a since-fixed bug (e.g. the pdf.worker
    // require() bug), without needing to touch S3 at all.
    const full = await reconcileKeywordIndex({
      tenantId: TENANT_ID,
      knowledgeBaseId: KB_ID,
      bucketName: BUCKET,
      timeBudgetMs: 60_000,
      now: () => 1_000_000,
      mode: "full",
    });
    expect(full.changedObjectCount).toBe(2);
    expect(full.unchangedObjectCount).toBe(0);
    expect(full.indexedObjectCount).toBe(2);
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

describe("reconcileKeywordIndex object diff (for vector-sync reuse)", () => {
  const DIFF_TENANT = "test-tenant-diff";
  const DIFF_KB_ID = "test-kb-diff";
  const DIFF_BUCKET = "test-bucket-diff";

  function diffDbPath() {
    return tempDbPathFor(DIFF_TENANT, DIFF_KB_ID);
  }

  beforeEach(() => {
    if (fs.existsSync(diffDbPath())) fs.unlinkSync(diffDbPath());
  });
  afterEach(() => {
    if (fs.existsSync(diffDbPath())) fs.unlinkSync(diffDbPath());
  });

  it("returns the listed/changed/deleted key lists on a fresh run, empty on a resumed run", async () => {
    let storedIndexBody: Buffer | null = null;
    const s3Objects = [
      {
        Key: `tenants/${DIFF_TENANT}/a.txt`,
        ETag: '"etag-a"',
        Size: 10,
        LastModified: new Date("2026-01-01T00:00:00Z"),
      },
      {
        Key: `tenants/${DIFF_TENANT}/b.txt`,
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
        return { Body: Buffer.from("content", "utf8") };
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

    // Round 1: zero time budget - fresh run computes and returns the diff,
    // then checkpoints before processing any object.
    const result1 = await reconcileKeywordIndex({
      tenantId: DIFF_TENANT,
      knowledgeBaseId: DIFF_KB_ID,
      bucketName: DIFF_BUCKET,
      timeBudgetMs: 0,
      now: () => 1_000_000,
    });

    expect(result1.partial).toBe(true);
    expect(result1.listedKeys.sort()).toEqual(
      [`tenants/${DIFF_TENANT}/a.txt`, `tenants/${DIFF_TENANT}/b.txt`].sort(),
    );
    expect(result1.changedKeys.sort()).toEqual(result1.listedKeys.sort());
    expect(result1.deletedKeys).toEqual([]);

    // Round 2: resumes from checkpoint - diff was already computed in round
    // 1 and isn't recomputed, so these come back empty rather than stale.
    const result2 = await reconcileKeywordIndex({
      tenantId: DIFF_TENANT,
      knowledgeBaseId: DIFF_KB_ID,
      bucketName: DIFF_BUCKET,
      timeBudgetMs: 60_000,
      now: () => 1_000_000,
    });

    expect(result2.partial).toBe(false);
    expect(result2.listedKeys).toEqual([]);
    expect(result2.changedKeys).toEqual([]);
    expect(result2.deletedKeys).toEqual([]);
  });
});

describe("trackTenantObjects", () => {
  const TRACK_TENANT = "test-tenant-track";
  const TRACK_KB_ID = "test-kb-track";
  const TRACK_BUCKET = "test-bucket-track";

  function trackDbPath() {
    return tempTrackingDbPathFor(TRACK_TENANT, TRACK_KB_ID);
  }

  function reconcileDbPath() {
    return tempDbPathFor(TRACK_TENANT, TRACK_KB_ID);
  }

  beforeEach(() => {
    if (fs.existsSync(trackDbPath())) fs.unlinkSync(trackDbPath());
    if (fs.existsSync(reconcileDbPath())) fs.unlinkSync(reconcileDbPath());
  });
  afterEach(() => {
    if (fs.existsSync(trackDbPath())) fs.unlinkSync(trackDbPath());
    if (fs.existsSync(reconcileDbPath())) fs.unlinkSync(reconcileDbPath());
  });

  it("records tracking rows without downloading file content, and reports the object as unchanged next time", async () => {
    let storedIndexBody: Buffer | null = null;
    let objects = [
      {
        Key: `tenants/${TRACK_TENANT}/a.txt`,
        ETag: '"etag-a"',
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
        throw new Error(`trackTenantObjects should never download file content: ${key}`);
      }
      if (type === "ListObjectsV2Command") {
        return { Contents: objects, IsTruncated: false };
      }
      if (type === "PutObjectCommand") {
        storedIndexBody = Buffer.from(command.input.Body);
        return {};
      }
      throw new Error(`Unexpected command: ${type}`);
    });

    const first = await trackTenantObjects({
      tenantId: TRACK_TENANT,
      knowledgeBaseId: TRACK_KB_ID,
      bucketName: TRACK_BUCKET,
    });

    expect(first.listedKeys).toEqual([`tenants/${TRACK_TENANT}/a.txt`]);
    expect(first.changedKeys).toEqual([`tenants/${TRACK_TENANT}/a.txt`]);
    expect(first.deletedKeys).toEqual([]);

    const second = await trackTenantObjects({
      tenantId: TRACK_TENANT,
      knowledgeBaseId: TRACK_KB_ID,
      bucketName: TRACK_BUCKET,
    });

    expect(second.changedKeys).toEqual([]);
    expect(second.deletedKeys).toEqual([]);

    // Object removed from S3 - should now be reported as deleted.
    objects = [];
    const third = await trackTenantObjects({
      tenantId: TRACK_TENANT,
      knowledgeBaseId: TRACK_KB_ID,
      bucketName: TRACK_BUCKET,
    });

    expect(third.deletedKeys).toEqual([`tenants/${TRACK_TENANT}/a.txt`]);
  });

  it("never downloads reconcileKeywordIndex's file, even when a large one already exists for this tenant", async () => {
    // Simulate a tenant that had keyword search enabled earlier: a large,
    // real chunks-laden file already sits at keywordIndexLocation's key.
    // trackTenantObjects must use a structurally separate location and
    // never touch that file at all - not "download it and purge it",
    // which live-testing showed can itself be too slow (~80-90s to
    // download and open a real 75MB file, close to Amplify's ~28s wall).
    sendMock.mockImplementation(async (command: any) => {
      const type = command.__type;
      if (type === "GetObjectCommand") {
        const key = command.input.Key as string;
        if (!key.endsWith("-tracking.sqlite")) {
          throw new Error(
            `trackTenantObjects must never request reconcileKeywordIndex's file, requested: ${key}`,
          );
        }
        const err: any = new Error("NoSuchKey");
        err.name = "NoSuchKey";
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      if (type === "ListObjectsV2Command") {
        return {
          Contents: [
            {
              Key: `tenants/${TRACK_TENANT}/a.txt`,
              ETag: '"etag-a"',
              Size: 10,
              LastModified: new Date("2026-01-01T00:00:00Z"),
            },
          ],
          IsTruncated: false,
        };
      }
      if (type === "PutObjectCommand") {
        const key = command.input.Key as string;
        expect(key.endsWith("-tracking.sqlite")).toBe(true);
        return {};
      }
      throw new Error(`Unexpected command: ${type}`);
    });

    const result = await trackTenantObjects({
      tenantId: TRACK_TENANT,
      knowledgeBaseId: TRACK_KB_ID,
      bucketName: TRACK_BUCKET,
    });

    expect(result.changedKeys).toEqual([`tenants/${TRACK_TENANT}/a.txt`]);
  });
});

describe("reconcileKeywordIndex error reporting", () => {
  const ERR_TENANT = "test-tenant-errors";
  const ERR_KB_ID = "test-kb-errors";
  const ERR_BUCKET = "test-bucket-errors";

  function errDbPaths() {
    return [tempDbPathFor(ERR_TENANT, ERR_KB_ID), tempTrackingDbPathFor(ERR_TENANT, ERR_KB_ID)];
  }
  function removeErrDbs() {
    for (const p of errDbPaths()) if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  beforeEach(removeErrDbs);
  afterEach(removeErrDbs);

  it("caps the returned errors array while errorCount stays the true total, so the DynamoDB job item can't blow past 400KB", async () => {
    const failingObjects = Array.from({ length: 60 }, (_, index) => ({
      Key: `tenants/${ERR_TENANT}/doc-${index}.txt`,
      ETag: `"etag-${index}"`,
      Size: 10,
      LastModified: new Date("2026-01-01T00:00:00Z"),
    }));

    sendMock.mockImplementation(async (command: any) => {
      const type = command.__type;
      if (type === "GetObjectCommand") {
        const key = command.input.Key as string;
        if (key.endsWith(".sqlite")) {
          const err: any = new Error("NoSuchKey");
          err.name = "NoSuchKey";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        throw new Error(`AccessDenied fetching ${key}`);
      }
      if (type === "ListObjectsV2Command") {
        return { Contents: failingObjects, IsTruncated: false };
      }
      if (type === "PutObjectCommand") return {};
      throw new Error(`Unexpected command: ${type}`);
    });

    const result = await reconcileKeywordIndex({
      tenantId: ERR_TENANT,
      knowledgeBaseId: ERR_KB_ID,
      bucketName: ERR_BUCKET,
      timeBudgetMs: 60_000,
      now: () => 1_000_000,
    });

    expect(result.errorCount).toBe(60);
    expect(result.errors).toHaveLength(50);
    expect(result.errors[0]).toContain("doc-0.txt");
  });
});

describe("seedTrackingFileIfMissing (via reconcileKeywordIndex)", () => {
  const SEED_TENANT = "test-tenant-seed";
  const SEED_KB_ID = "test-kb-seed";
  const SEED_BUCKET = "test-bucket-seed";
  const SEED_KEY = `tenants/${SEED_TENANT}/handbook.txt`;

  const s3Objects = [
    {
      Key: SEED_KEY,
      ETag: '"etag-handbook"',
      Size: 34,
      LastModified: new Date("2026-01-01T00:00:00Z"),
    },
  ];

  function seedIndexPath() {
    return tempDbPathFor(SEED_TENANT, SEED_KB_ID);
  }
  function seedTrackingPath() {
    return tempTrackingDbPathFor(SEED_TENANT, SEED_KB_ID);
  }
  function removeSeedDbs() {
    for (const p of [seedIndexPath(), seedTrackingPath(), seedTrackingPath() + ".uploaded"]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }

  beforeEach(removeSeedDbs);
  afterEach(removeSeedDbs);

  // Two independent S3 objects, keyed the way the real code keys them: the
  // keyword-index file and the (separate) tracking file. Existing tests in
  // this file collapse both into one `storedIndexBody`, which would hide the
  // very distinction these tests are about.
  function mockS3({ trackingExists }: { trackingExists: boolean }) {
    const store: Record<string, Buffer | null> = {
      index: null,
      tracking: trackingExists ? emptyTrackingFileBody() : null,
    };
    const putKeys: string[] = [];

    const slotFor = (key: string) => (key.endsWith("-tracking.sqlite") ? "tracking" : "index");

    sendMock.mockImplementation(async (command: any) => {
      const type = command.__type;
      if (type === "GetObjectCommand") {
        const key = command.input.Key as string;
        if (key.endsWith(".sqlite")) {
          const body = store[slotFor(key)];
          if (!body) {
            const err: any = new Error("NoSuchKey");
            err.name = "NoSuchKey";
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          return { Body: body };
        }
        return { Body: Buffer.from("refund policy handbook materiality", "utf8") };
      }
      if (type === "HeadObjectCommand") {
        const key = command.input.Key as string;
        if (!store[slotFor(key)]) {
          const err: any = new Error("NotFound");
          err.name = "NotFound";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return {};
      }
      if (type === "ListObjectsV2Command") {
        const prefix = (command.input.Prefix as string) || "";
        return {
          Contents: s3Objects.filter((object) => object.Key.startsWith(prefix)),
          IsTruncated: false,
        };
      }
      if (type === "PutObjectCommand") {
        const key = command.input.Key as string;
        putKeys.push(key);
        store[slotFor(key)] = Buffer.from(command.input.Body);
        return {};
      }
      throw new Error(`Unexpected command: ${type}`);
    });

    return {
      trackingPutCount: () => putKeys.filter((key) => key.endsWith("-tracking.sqlite")).length,
      openTracking: () => {
        const uploadedPath = seedTrackingPath() + ".uploaded";
        fs.writeFileSync(uploadedPath, store.tracking!);
        return new Database(uploadedPath);
      },
      trackingBody: () => store.tracking,
    };
  }

  // A tracking file that already exists but carries no documents rows - the
  // "already initialised, do not touch" case, distinct from "absent".
  function emptyTrackingFileBody(): Buffer {
    const tmp = path.join(os.tmpdir(), `seed-existing-tracking-${Date.now()}.sqlite`);
    const db = new Database(tmp);
    db.exec(`
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
    `);
    db.close();
    const body = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return body;
  }

  it("seeds a missing tracking file from the keyword-index file's documents table, preserving etag/size/last_modified exactly", async () => {
    const s3 = mockS3({ trackingExists: false });

    // Round 1 builds the keyword-index file. The documents table is still
    // empty when seeding runs here, so nothing is seeded yet - exactly what
    // a brand-new tenant looks like.
    await reconcileKeywordIndex({
      tenantId: SEED_TENANT,
      knowledgeBaseId: SEED_KB_ID,
      bucketName: SEED_BUCKET,
      timeBudgetMs: 60_000,
      now: () => 1_000_000,
    });
    expect(s3.trackingPutCount()).toBe(0);

    // Round 2 is the pre-existing-keyword-tenant case: real change-tracking
    // history now sits in the keyword-index file, and no tracking file has
    // ever existed.
    await reconcileKeywordIndex({
      tenantId: SEED_TENANT,
      knowledgeBaseId: SEED_KB_ID,
      bucketName: SEED_BUCKET,
      timeBudgetMs: 60_000,
      now: () => 1_000_000,
    });

    expect(s3.trackingPutCount()).toBe(1);

    const tracking = s3.openTracking();
    const rows = tracking
      .prepare(
        `SELECT s3_key, etag, size, last_modified FROM documents
         WHERE tenant_id = ? AND knowledge_base_id = ? AND bucket = ?`,
      )
      .all(SEED_TENANT, SEED_KB_ID, SEED_BUCKET) as Array<{
      s3_key: string;
      etag: string | null;
      size: number | null;
      last_modified: string | null;
    }>;
    tracking.close();

    // These three columns are precisely what hasObjectChanged compares - if
    // any of them were dropped or rewritten during the copy, the next diff
    // would call the object "changed" and re-embed it.
    expect(rows).toEqual([
      {
        s3_key: SEED_KEY,
        etag: '"etag-handbook"',
        size: 34,
        last_modified: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("makes the tenant's next trackTenantObjects diff report the corpus unchanged, instead of re-embedding all of it", async () => {
    const s3 = mockS3({ trackingExists: false });

    await reconcileKeywordIndex({
      tenantId: SEED_TENANT, knowledgeBaseId: SEED_KB_ID, bucketName: SEED_BUCKET,
      timeBudgetMs: 60_000, now: () => 1_000_000,
    });
    await reconcileKeywordIndex({
      tenantId: SEED_TENANT, knowledgeBaseId: SEED_KB_ID, bucketName: SEED_BUCKET,
      timeBudgetMs: 60_000, now: () => 1_000_000,
    });
    expect(s3.trackingPutCount()).toBe(1);

    if (fs.existsSync(seedTrackingPath())) fs.unlinkSync(seedTrackingPath());
    const diff = await trackTenantObjects({
      tenantId: SEED_TENANT,
      knowledgeBaseId: SEED_KB_ID,
      bucketName: SEED_BUCKET,
    });

    expect(diff.listedKeys).toEqual([SEED_KEY]);
    expect(diff.changedKeys).toEqual([]); // the whole point: no re-embed
    expect(diff.deletedKeys).toEqual([]);
  });

  it("never writes over a tracking file that already exists", async () => {
    const s3 = mockS3({ trackingExists: true });
    const before = s3.trackingBody();

    await reconcileKeywordIndex({
      tenantId: SEED_TENANT, knowledgeBaseId: SEED_KB_ID, bucketName: SEED_BUCKET,
      timeBudgetMs: 60_000, now: () => 1_000_000,
    });
    await reconcileKeywordIndex({
      tenantId: SEED_TENANT, knowledgeBaseId: SEED_KB_ID, bucketName: SEED_BUCKET,
      timeBudgetMs: 60_000, now: () => 1_000_000,
    });

    expect(s3.trackingPutCount()).toBe(0);
    expect(s3.trackingBody()).toBe(before);
  });

  // These two tests cover the real production call order, not just the
  // seed function in isolation: app/api/admin/kb/sync/route.ts calls
  // trackTenantObjects BEFORE the async worker (which runs
  // reconcileKeywordIndex, containing the seed step) ever gets a chance to
  // run. Without deferIfKeywordIndexExists, trackTenantObjects would create
  // an empty tracking file itself, right here, before the seed ever fires -
  // permanently defeating it. This is what deferIfKeywordIndexExists exists
  // to prevent.
  it("defers (partial: true) instead of creating an empty tracking file, when deferIfKeywordIndexExists is set and a keyword-index file already exists", async () => {
    const s3 = mockS3({ trackingExists: false });

    // One reconcileKeywordIndex round: uploads a real keyword-index file
    // with the one object's row in its documents table. Crucially, this
    // round's OWN seed check ran too early (documents table was still empty
    // when it checked) and did not seed the tracking file - reproducing
    // the exact state a tenant is in immediately after this branch ships:
    // real keyword-index history exists, no tracking file has ever been
    // written.
    await reconcileKeywordIndex({
      tenantId: SEED_TENANT, knowledgeBaseId: SEED_KB_ID, bucketName: SEED_BUCKET,
      timeBudgetMs: 60_000, now: () => 1_000_000,
    });
    expect(s3.trackingPutCount()).toBe(0);

    const diff = await trackTenantObjects({
      tenantId: SEED_TENANT,
      knowledgeBaseId: SEED_KB_ID,
      bucketName: SEED_BUCKET,
      deferIfKeywordIndexExists: true,
    });

    expect(diff.partial).toBe(true);
    expect(diff.changedKeys).toEqual([]);
    // The whole point: trackTenantObjects must not create/upload an empty
    // tracking file itself here - that would permanently defeat the async
    // worker's own seed step, which hasn't run yet.
    expect(s3.trackingPutCount()).toBe(0);
  });

  it("falls back to the old mark-everything-changed behavior when deferIfKeywordIndexExists is not set, even if a keyword-index file exists", async () => {
    const s3 = mockS3({ trackingExists: false });

    await reconcileKeywordIndex({
      tenantId: SEED_TENANT, knowledgeBaseId: SEED_KB_ID, bucketName: SEED_BUCKET,
      timeBudgetMs: 60_000, now: () => 1_000_000,
    });

    // deferIfKeywordIndexExists intentionally omitted - matches a tenant
    // with keyword search disabled, where no async job will ever run to
    // resolve a deferral, so deferring here would stall vector-sync
    // forever instead of just once. This tenant gets the old, already-
    // accepted one-time re-embed behavior instead.
    const diff = await trackTenantObjects({
      tenantId: SEED_TENANT,
      knowledgeBaseId: SEED_KB_ID,
      bucketName: SEED_BUCKET,
    });

    expect(diff.partial).toBe(false);
    expect(diff.changedKeys).toEqual([SEED_KEY]);
    expect(s3.trackingPutCount()).toBe(1);
  });
});

describe("submitVectorSync", () => {
  const SYNC_TENANT = "test-tenant-vectorsync";
  const SYNC_KB_ID = "test-kb-vectorsync";
  const SYNC_BUCKET = "test-bucket-vectorsync";

  function syncDbPath() {
    return tempTrackingDbPathFor(SYNC_TENANT, SYNC_KB_ID);
  }

  beforeEach(() => {
    if (fs.existsSync(syncDbPath())) fs.unlinkSync(syncDbPath());
  });
  afterEach(() => {
    if (fs.existsSync(syncDbPath())) fs.unlinkSync(syncDbPath());
  });

  // Wires up a fresh (or seeded) SQLite tracking file as the GetObjectCommand
  // response, and captures whatever gets uploaded so tests can inspect the
  // resulting state (queue/pending rows) after a call.
  function mockS3(seedDb?: Database.Database) {
    let storedIndexBody: Buffer | null = seedDb ? fs.readFileSync(seedDb.name) : null;
    sendMock.mockImplementation(async (command: any) => {
      const type = command.__type;
      if (type === "GetObjectCommand") {
        if (!storedIndexBody) {
          const err: any = new Error("NoSuchKey");
          err.name = "NoSuchKey";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return { Body: storedIndexBody };
      }
      if (type === "PutObjectCommand") {
        storedIndexBody = Buffer.from(command.input.Body);
        return {};
      }
      throw new Error(`Unexpected S3 command: ${type}`);
    });
    return {
      openUploaded: () => {
        fs.writeFileSync(syncDbPath() + ".uploaded", storedIndexBody!);
        return new Database(syncDbPath() + ".uploaded");
      },
    };
  }

  function ingestResultsFor(keys: string[]) {
    return keys.map((key) => ({ key, status: "STARTING" }));
  }

  it("seeds the queue from the diff on a fresh incremental run and submits everything within budget", async () => {
    mockS3();
    ingestMock.mockImplementation(async (params: any) => ingestResultsFor(params.keys));
    deleteMock.mockImplementation(async (params: any) => ingestResultsFor(params.keys));

    const result = await submitVectorSync({
      tenantId: SYNC_TENANT,
      knowledgeBaseId: SYNC_KB_ID,
      dataSourceId: "ds-1",
      bucketName: SYNC_BUCKET,
      mode: "incremental",
      usesTrackingFile: true,
      diff: {
        listedKeys: [`tenants/${SYNC_TENANT}/a.pdf`, `tenants/${SYNC_TENANT}/b.pdf`],
        changedKeys: [`tenants/${SYNC_TENANT}/a.pdf`, `tenants/${SYNC_TENANT}/b.pdf`],
        deletedKeys: [`tenants/${SYNC_TENANT}/c.pdf`],
      },
    });

    expect(ingestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        keys: [`tenants/${SYNC_TENANT}/a.pdf`, `tenants/${SYNC_TENANT}/b.pdf`],
      }),
      expect.anything(),
    );
    expect(deleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ keys: [`tenants/${SYNC_TENANT}/c.pdf`] }),
      expect.anything(),
    );
    expect(result.submittedCount).toBe(2);
    expect(result.deletedCount).toBe(1);
    expect(result.partial).toBe(false);
  });

  it("full mode ingests every listedKey, not just changedKeys", async () => {
    mockS3();
    ingestMock.mockImplementation(async (params: any) => ingestResultsFor(params.keys));
    deleteMock.mockResolvedValue([]);

    await submitVectorSync({
      tenantId: SYNC_TENANT,
      knowledgeBaseId: SYNC_KB_ID,
      dataSourceId: "ds-1",
      bucketName: SYNC_BUCKET,
      mode: "full",
      usesTrackingFile: true,
      diff: {
        listedKeys: [`tenants/${SYNC_TENANT}/a.pdf`, `tenants/${SYNC_TENANT}/b.pdf`],
        changedKeys: [`tenants/${SYNC_TENANT}/b.pdf`],
        deletedKeys: [],
      },
    });

    expect(ingestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        keys: [`tenants/${SYNC_TENANT}/a.pdf`, `tenants/${SYNC_TENANT}/b.pdf`],
      }),
      expect.anything(),
    );
  });

  it("retries a key still marked pending from an earlier interrupted attempt, even though S3 hasn't changed it again", async () => {
    // Simulate a prior run that queued this key for ingestion but never
    // confirmed submission (crash, timeout, whatever) - vector_pending still
    // has it, even though this fresh diff sees it as unchanged.
    const seedDb = new Database(syncDbPath());
    seedDb.exec(`
      CREATE TABLE vector_pending (
        tenant_id TEXT NOT NULL, knowledge_base_id TEXT NOT NULL, s3_key TEXT NOT NULL,
        PRIMARY KEY (tenant_id, knowledge_base_id, s3_key)
      );
    `);
    seedDb
      .prepare(`INSERT INTO vector_pending (tenant_id, knowledge_base_id, s3_key) VALUES (?, ?, ?)`)
      .run(SYNC_TENANT, SYNC_KB_ID, `tenants/${SYNC_TENANT}/stale.pdf`);

    mockS3(seedDb);
    seedDb.close();
    ingestMock.mockImplementation(async (params: any) => ingestResultsFor(params.keys));
    deleteMock.mockResolvedValue([]);

    await submitVectorSync({
      tenantId: SYNC_TENANT,
      knowledgeBaseId: SYNC_KB_ID,
      dataSourceId: "ds-1",
      bucketName: SYNC_BUCKET,
      mode: "incremental",
      usesTrackingFile: true,
      diff: {
        listedKeys: [`tenants/${SYNC_TENANT}/stale.pdf`],
        changedKeys: [], // S3 says nothing changed
        deletedKeys: [],
      },
    });

    expect(ingestMock).toHaveBeenCalledWith(
      expect.objectContaining({ keys: [`tenants/${SYNC_TENANT}/stale.pdf`] }),
      expect.anything(),
    );
  });

  it("does not re-ingest a pending key that's since been deleted from S3", async () => {
    const seedDb = new Database(syncDbPath());
    seedDb.exec(`
      CREATE TABLE vector_pending (
        tenant_id TEXT NOT NULL, knowledge_base_id TEXT NOT NULL, s3_key TEXT NOT NULL,
        PRIMARY KEY (tenant_id, knowledge_base_id, s3_key)
      );
    `);
    seedDb
      .prepare(`INSERT INTO vector_pending (tenant_id, knowledge_base_id, s3_key) VALUES (?, ?, ?)`)
      .run(SYNC_TENANT, SYNC_KB_ID, `tenants/${SYNC_TENANT}/gone.pdf`);

    mockS3(seedDb);
    seedDb.close();
    ingestMock.mockResolvedValue([]);
    deleteMock.mockImplementation(async (params: any) => ingestResultsFor(params.keys));

    await submitVectorSync({
      tenantId: SYNC_TENANT,
      knowledgeBaseId: SYNC_KB_ID,
      dataSourceId: "ds-1",
      bucketName: SYNC_BUCKET,
      mode: "incremental",
      usesTrackingFile: true,
      diff: {
        listedKeys: [], // no longer in S3
        changedKeys: [],
        deletedKeys: [`tenants/${SYNC_TENANT}/gone.pdf`],
      },
    });

    expect(ingestMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ keys: [`tenants/${SYNC_TENANT}/gone.pdf`] }),
      expect.anything(),
    );
  });

  it("checkpoints when not everything gets submitted, and a resume (no diff) continues without re-seeding", async () => {
    mockS3();
    // First round: only "a" gets submitted (simulates the real deadline-aware
    // batching in bedrock-kb.ts returning fewer results than requested).
    ingestMock.mockImplementationOnce(async () => [
      { key: `tenants/${SYNC_TENANT}/a.pdf`, status: "STARTING" },
    ]);
    deleteMock.mockResolvedValue([]);

    const first = await submitVectorSync({
      tenantId: SYNC_TENANT,
      knowledgeBaseId: SYNC_KB_ID,
      dataSourceId: "ds-1",
      bucketName: SYNC_BUCKET,
      mode: "incremental",
      usesTrackingFile: true,
      diff: {
        listedKeys: [`tenants/${SYNC_TENANT}/a.pdf`, `tenants/${SYNC_TENANT}/b.pdf`],
        changedKeys: [`tenants/${SYNC_TENANT}/a.pdf`, `tenants/${SYNC_TENANT}/b.pdf`],
        deletedKeys: [],
      },
    });

    expect(first.partial).toBe(true);
    expect(first.submittedCount).toBe(1);

    // Resume: no diff passed at all - must continue draining the existing
    // queue (just "b" left), not re-seed from a (missing) diff.
    ingestMock.mockImplementationOnce(async (params: any) => ingestResultsFor(params.keys));
    const second = await submitVectorSync({
      tenantId: SYNC_TENANT,
      knowledgeBaseId: SYNC_KB_ID,
      dataSourceId: "ds-1",
      bucketName: SYNC_BUCKET,
      mode: "incremental",
      usesTrackingFile: true,
    });

    expect(ingestMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ keys: [`tenants/${SYNC_TENANT}/b.pdf`] }),
      expect.anything(),
    );
    expect(second.partial).toBe(false);
  });

  it("only clears vector_pending for keys that were actually confirmed submitted", async () => {
    const s3 = mockS3();
    // "a" succeeds, "b" doesn't come back in the results at all (as if that
    // batch never got a chance to run before the deadline).
    ingestMock.mockImplementationOnce(async () => [
      { key: `tenants/${SYNC_TENANT}/a.pdf`, status: "STARTING" },
    ]);
    deleteMock.mockResolvedValue([]);

    await submitVectorSync({
      tenantId: SYNC_TENANT,
      knowledgeBaseId: SYNC_KB_ID,
      dataSourceId: "ds-1",
      bucketName: SYNC_BUCKET,
      mode: "incremental",
      usesTrackingFile: true,
      diff: {
        listedKeys: [`tenants/${SYNC_TENANT}/a.pdf`, `tenants/${SYNC_TENANT}/b.pdf`],
        changedKeys: [`tenants/${SYNC_TENANT}/a.pdf`, `tenants/${SYNC_TENANT}/b.pdf`],
        deletedKeys: [],
      },
    });

    const uploaded = s3.openUploaded();
    const pendingKeys = (
      uploaded
        .prepare(`SELECT s3_key FROM vector_pending WHERE tenant_id = ?`)
        .all(SYNC_TENANT) as Array<{ s3_key: string }>
    ).map((row) => row.s3_key);
    uploaded.close();
    fs.unlinkSync(syncDbPath() + ".uploaded");

    expect(pendingKeys).toEqual([`tenants/${SYNC_TENANT}/b.pdf`]);
  });
});
