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

import { reconcileKeywordIndex } from "./kb-keyword-index";

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
