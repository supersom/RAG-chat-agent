import "server-only";

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { RAGSource } from "@/app/lib/rag-types";

const DEFAULT_REGION = "us-east-2";
const DEFAULT_INDEX_PREFIX = ".customer-support-agent/keyword-indexes";
const SUPPORTED_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".html",
  ".htm",
  ".xml",
  ".log",
  ".pdf",
]);

type AwsCredentials = {
  accessKeyId?: string;
  secretAccessKey?: string;
};

type S3InventoryObject = {
  key: string;
  etag?: string;
  size?: number;
  lastModified?: Date;
};

type ExistingDocument = {
  s3Key: string;
  etag: string | null;
  size: number | null;
  lastModified: string | null;
};

export type KeywordIndexUpdateResult = {
  indexBucket: string;
  indexKey: string;
  mode: "reconcile" | "skipped";
  listedObjectCount: number;
  changedObjectCount: number;
  unchangedObjectCount: number;
  deletedObjectCount: number;
  indexedObjectCount: number;
  indexedChunkCount: number;
  skippedObjectCount: number;
  errorCount: number;
  partial: boolean;
  errors: string[];
};

type KeywordSearchParams = {
  tenantId: string;
  knowledgeBaseId: string;
  bucketName: string;
  query: string;
  limit?: number;
  credentials?: AwsCredentials;
  region?: string;
};

type KeywordIndexParams = {
  tenantId: string;
  knowledgeBaseId: string;
  bucketName: string;
  credentials?: AwsCredentials;
  region?: string;
  timeBudgetMs?: number;
  now?: () => number;
};

type ReconcileRunState = {
  listedObjectCount: number;
  changedObjectCount: number;
  unchangedObjectCount: number;
  deletedObjectCount: number;
  indexedObjectCount: number;
  indexedChunkCount: number;
  skippedObjectCount: number;
  listingPartial: boolean;
  errors: string[];
};

function awsCredentials(credentials?: AwsCredentials): { accessKeyId: string; secretAccessKey: string } {
  return {
    accessKeyId: (credentials?.accessKeyId || process.env.BAWS_ACCESS_KEY_ID)!,
    secretAccessKey: (credentials?.secretAccessKey || process.env.BAWS_SECRET_ACCESS_KEY)!,
  };
}

function s3Client(region?: string, credentials?: AwsCredentials): S3Client {
  return new S3Client({
    region: region || process.env.AWS_REGION || process.env.BAWS_REGION || DEFAULT_REGION,
    credentials: awsCredentials(credentials),
  });
}

function keywordIndexPrefix(): string {
  return (process.env.KEYWORD_INDEX_S3_PREFIX || DEFAULT_INDEX_PREFIX).replace(/\/+$/, "");
}

function keywordIndexLocation(tenantId: string, knowledgeBaseId: string, bucketName: string) {
  const indexBucket = process.env.KEYWORD_INDEX_S3_BUCKET || bucketName;
  const safeTenant = encodeURIComponent(tenantId);
  const safeKb = encodeURIComponent(knowledgeBaseId);
  return {
    indexBucket,
    indexKey: `${keywordIndexPrefix()}/${safeTenant}/${safeKb}.sqlite`,
  };
}

function tempIndexPath(tenantId: string, knowledgeBaseId: string) {
  const hash = crypto
    .createHash("sha256")
    .update(`${tenantId}:${knowledgeBaseId}`)
    .digest("hex")
    .slice(0, 12);
  return path.join(os.tmpdir(), `customer-support-agent-keyword-${hash}.sqlite`);
}

function extensionForKey(key: string): string {
  return path.extname(key.split("?")[0] || "").toLowerCase();
}

function isSupportedObject(key: string): boolean {
  if (!key || key.endsWith("/")) return false;
  if (key.startsWith(`${keywordIndexPrefix()}/`)) return false;
  return SUPPORTED_EXTENSIONS.has(extensionForKey(key));
}

function fileNameForKey(key: string): string {
  return key.split("/").pop()?.replace(/_/g, " ") || key;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (body instanceof Uint8Array) return Buffer.from(body);
  const stream = body as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function cleanText(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractText(buffer: Buffer, key: string): Promise<string> {
  const ext = extensionForKey(key);
  if (ext === ".pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const parsed = await parser.getText();
      return cleanText(parsed.text || "");
    } finally {
      await parser.destroy();
    }
  }
  return cleanText(buffer.toString("utf8"));
}

function chunkText(text: string): string[] {
  const size = Number(process.env.KEYWORD_INDEX_CHUNK_CHARS || 2000);
  const overlap = Number(process.env.KEYWORD_INDEX_CHUNK_OVERLAP_CHARS || 200);
  const maxChunks = Number(process.env.KEYWORD_INDEX_MAX_CHUNKS_PER_OBJECT || 200);
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length && chunks.length < maxChunks) {
    const end = Math.min(start + size, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
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

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      tenant_id UNINDEXED,
      knowledge_base_id UNINDEXED,
      bucket UNINDEXED,
      s3_key UNINDEXED,
      chunk_index UNINDEXED,
      file_name,
      body,
      tokenize = 'unicode61'
    );

    CREATE TABLE IF NOT EXISTS reconcile_queue (
      s3_key TEXT PRIMARY KEY,
      etag TEXT,
      size INTEGER,
      last_modified TEXT
    );

    CREATE TABLE IF NOT EXISTS reconcile_run (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      listed_object_count INTEGER NOT NULL,
      changed_object_count INTEGER NOT NULL,
      unchanged_object_count INTEGER NOT NULL,
      deleted_object_count INTEGER NOT NULL,
      indexed_object_count INTEGER NOT NULL,
      indexed_chunk_count INTEGER NOT NULL,
      skipped_object_count INTEGER NOT NULL,
      listing_partial INTEGER NOT NULL,
      errors TEXT NOT NULL
    );
  `);
  return db;
}

// Resume state for a reconcile run that had to checkpoint mid-way through
// processing (time budget exceeded). Both tables live inside the same
// .sqlite file that already gets round-tripped through S3, so checkpointing
// is just "upload the file" - no separate sidecar state to keep in sync.

function readReconcileRun(db: Database.Database): ReconcileRunState | null {
  const row = db.prepare(`SELECT * FROM reconcile_run WHERE id = 1`).get() as
    | {
        listed_object_count: number;
        changed_object_count: number;
        unchanged_object_count: number;
        deleted_object_count: number;
        indexed_object_count: number;
        indexed_chunk_count: number;
        skipped_object_count: number;
        listing_partial: number;
        errors: string;
      }
    | undefined;
  if (!row) return null;
  return {
    listedObjectCount: row.listed_object_count,
    changedObjectCount: row.changed_object_count,
    unchangedObjectCount: row.unchanged_object_count,
    deletedObjectCount: row.deleted_object_count,
    indexedObjectCount: row.indexed_object_count,
    indexedChunkCount: row.indexed_chunk_count,
    skippedObjectCount: row.skipped_object_count,
    listingPartial: Boolean(row.listing_partial),
    errors: JSON.parse(row.errors || "[]"),
  };
}

function writeReconcileRun(db: Database.Database, run: ReconcileRunState) {
  db.prepare(
    `
      INSERT INTO reconcile_run (
        id, listed_object_count, changed_object_count, unchanged_object_count,
        deleted_object_count, indexed_object_count, indexed_chunk_count,
        skipped_object_count, listing_partial, errors
      )
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        listed_object_count = excluded.listed_object_count,
        changed_object_count = excluded.changed_object_count,
        unchanged_object_count = excluded.unchanged_object_count,
        deleted_object_count = excluded.deleted_object_count,
        indexed_object_count = excluded.indexed_object_count,
        indexed_chunk_count = excluded.indexed_chunk_count,
        skipped_object_count = excluded.skipped_object_count,
        listing_partial = excluded.listing_partial,
        errors = excluded.errors
    `,
  ).run(
    run.listedObjectCount,
    run.changedObjectCount,
    run.unchangedObjectCount,
    run.deletedObjectCount,
    run.indexedObjectCount,
    run.indexedChunkCount,
    run.skippedObjectCount,
    run.listingPartial ? 1 : 0,
    JSON.stringify(run.errors),
  );
}

function clearReconcileRun(db: Database.Database) {
  db.prepare(`DELETE FROM reconcile_run WHERE id = 1`).run();
}

function enqueueObjects(db: Database.Database, objects: S3InventoryObject[]) {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO reconcile_queue (s3_key, etag, size, last_modified) VALUES (?, ?, ?, ?)`,
  );
  const insertMany = db.transaction((items: S3InventoryObject[]) => {
    for (const item of items) {
      insert.run(
        item.key,
        item.etag ?? null,
        item.size ?? null,
        item.lastModified?.toISOString() ?? null,
      );
    }
  });
  insertMany(objects);
}

function readQueue(db: Database.Database): S3InventoryObject[] {
  const rows = db
    .prepare(`SELECT s3_key, etag, size, last_modified FROM reconcile_queue`)
    .all() as Array<{
    s3_key: string;
    etag: string | null;
    size: number | null;
    last_modified: string | null;
  }>;
  return rows.map((row) => ({
    key: row.s3_key,
    etag: row.etag ?? undefined,
    size: row.size ?? undefined,
    lastModified: row.last_modified ? new Date(row.last_modified) : undefined,
  }));
}

function removeFromQueue(db: Database.Database, key: string) {
  db.prepare(`DELETE FROM reconcile_queue WHERE s3_key = ?`).run(key);
}

function clearQueue(db: Database.Database) {
  db.prepare(`DELETE FROM reconcile_queue`).run();
}

async function downloadExistingIndex({
  client,
  indexBucket,
  indexKey,
  dbPath,
}: {
  client: S3Client;
  indexBucket: string;
  indexKey: string;
  dbPath: string;
}) {
  try {
    const existing = await client.send(
      new GetObjectCommand({ Bucket: indexBucket, Key: indexKey }),
    );
    const body = await streamToBuffer(existing.Body);
    fs.writeFileSync(dbPath, body);
  } catch (err: any) {
    const status = err?.$metadata?.httpStatusCode;
    if (status !== 404 && err?.name !== "NoSuchKey") {
      throw err;
    }
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
}

async function listSupportedObjects({
  client,
  bucketName,
}: {
  client: S3Client;
  bucketName: string;
}): Promise<{ objects: S3InventoryObject[]; partial: boolean }> {
  const maxObjects = Number(process.env.KEYWORD_INDEX_MAX_RECONCILE_OBJECTS || 0);
  const objects: S3InventoryObject[] = [];
  let continuationToken: string | undefined;
  let partial = false;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken: continuationToken,
      }),
    );

    for (const object of page.Contents ?? []) {
      const key = object.Key;
      if (!key || !isSupportedObject(key)) continue;
      objects.push({
        key,
        etag: object.ETag,
        size: object.Size,
        lastModified: object.LastModified,
      });

      if (maxObjects > 0 && objects.length >= maxObjects) {
        partial = true;
        return { objects, partial };
      }
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return { objects, partial };
}

function existingDocuments(
  db: Database.Database,
  params: { tenantId: string; knowledgeBaseId: string; bucketName: string },
): Map<string, ExistingDocument> {
  const rows = db.prepare(
    `
      SELECT
        s3_key as s3Key,
        etag,
        size,
        last_modified as lastModified
      FROM documents
      WHERE tenant_id = ? AND knowledge_base_id = ? AND bucket = ?
    `,
  ).all(params.tenantId, params.knowledgeBaseId, params.bucketName) as ExistingDocument[];

  return new Map(rows.map((row) => [row.s3Key, row]));
}

function hasObjectChanged(object: S3InventoryObject, existing?: ExistingDocument): boolean {
  if (!existing) return true;
  return (
    (object.etag || null) !== existing.etag ||
    (object.size ?? null) !== existing.size ||
    (object.lastModified?.toISOString() || null) !== existing.lastModified
  );
}

function deleteObjectRows(
  db: Database.Database,
  params: { tenantId: string; knowledgeBaseId: string; bucketName: string; key: string },
) {
  db.prepare(
    `
      DELETE FROM chunks
      WHERE tenant_id = ? AND knowledge_base_id = ? AND bucket = ? AND s3_key = ?
    `,
  ).run(params.tenantId, params.knowledgeBaseId, params.bucketName, params.key);
  db.prepare(
    `
      DELETE FROM documents
      WHERE tenant_id = ? AND knowledge_base_id = ? AND bucket = ? AND s3_key = ?
    `,
  ).run(params.tenantId, params.knowledgeBaseId, params.bucketName, params.key);
}

function insertObjectRows({
  db,
  tenantId,
  knowledgeBaseId,
  bucketName,
  key,
  etag,
  size,
  lastModified,
  chunks,
}: {
  db: Database.Database;
  tenantId: string;
  knowledgeBaseId: string;
  bucketName: string;
  key: string;
  etag?: string;
  size?: number;
  lastModified?: Date;
  chunks: string[];
}) {
  const inserted = db.prepare(
    `
      INSERT INTO documents (
        tenant_id, knowledge_base_id, bucket, s3_key, etag, size, last_modified, indexed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    tenantId,
    knowledgeBaseId,
    bucketName,
    key,
    etag || null,
    size ?? null,
    lastModified?.toISOString() || null,
    new Date().toISOString(),
  );

  const documentId = Number(inserted.lastInsertRowid);
  const insertChunk = db.prepare(
    `
      INSERT INTO chunks (
        rowid, tenant_id, knowledge_base_id, bucket, s3_key, chunk_index, file_name, body
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );

  chunks.forEach((chunk, index) => {
    insertChunk.run(
      documentId * 100000 + index,
      tenantId,
      knowledgeBaseId,
      bucketName,
      key,
      index,
      fileNameForKey(key),
      chunk,
    );
  });
}

function ftsMatchQuery(query: string): string | null {
  const tokens = query
    .match(/[a-zA-Z0-9][a-zA-Z0-9._/-]*/g)
    ?.map((token) => token.replace(/"/g, "").slice(0, 80))
    .filter(Boolean)
    .slice(0, 24);

  if (!tokens?.length) return null;
  return tokens.map((token) => `"${token}"`).join(" OR ");
}

const DEFAULT_TIME_BUDGET_MS = 20_000;

export async function reconcileKeywordIndex({
  tenantId,
  knowledgeBaseId,
  bucketName,
  credentials,
  region,
  timeBudgetMs,
  now = Date.now,
}: KeywordIndexParams): Promise<KeywordIndexUpdateResult> {
  const { indexBucket, indexKey } = keywordIndexLocation(tenantId, knowledgeBaseId, bucketName);
  const client = s3Client(region, credentials);
  const dbPath = tempIndexPath(tenantId, knowledgeBaseId);
  await downloadExistingIndex({ client, indexBucket, indexKey, dbPath });

  const db = initDatabase(dbPath);
  const maxObjectBytes = Number(process.env.KEYWORD_INDEX_MAX_OBJECT_BYTES || 50 * 1024 * 1024);
  const budgetMs =
    timeBudgetMs ?? Number(process.env.KEYWORD_INDEX_TIME_BUDGET_MS || DEFAULT_TIME_BUDGET_MS);
  const deadline = now() + budgetMs;

  const replaceOne = db.transaction((params: S3InventoryObject & { chunks: string[] }) => {
    deleteObjectRows(db, { tenantId, knowledgeBaseId, bucketName, key: params.key });
    insertObjectRows({
      db,
      tenantId,
      knowledgeBaseId,
      bucketName,
      key: params.key,
      etag: params.etag,
      size: params.size,
      lastModified: params.lastModified,
      chunks: params.chunks,
    });
  });

  const deleteOne = db.transaction((key: string) => {
    deleteObjectRows(db, { tenantId, knowledgeBaseId, bucketName, key });
  });

  let run: ReconcileRunState;
  let partial: boolean;

  try {
    const resumed = readReconcileRun(db);

    if (resumed) {
      run = resumed;
    } else {
      // Fresh run: list the bucket once, decide what changed, and run the
      // stale-object deletion sweep - all of this depends on having the full
      // current listing, so none of it is repeated on a resumed invocation.
      const { objects, partial: listingPartial } = await listSupportedObjects({ client, bucketName });
      const existing = existingDocuments(db, { tenantId, knowledgeBaseId, bucketName });
      const s3Keys = new Set(objects.map((object) => object.key));

      let deletedObjectCount = 0;
      if (!listingPartial) {
        for (const key of Array.from(existing.keys())) {
          if (!s3Keys.has(key)) {
            deleteOne(key);
            deletedObjectCount += 1;
          }
        }
      }

      const toEnqueue: S3InventoryObject[] = [];
      let unchangedObjectCount = 0;
      for (const object of objects) {
        const previous = existing.get(object.key);
        if (!hasObjectChanged(object, previous)) {
          unchangedObjectCount += 1;
          continue;
        }
        toEnqueue.push(object);
      }

      clearQueue(db);
      enqueueObjects(db, toEnqueue);

      run = {
        listedObjectCount: objects.length,
        changedObjectCount: toEnqueue.length,
        unchangedObjectCount,
        deletedObjectCount,
        indexedObjectCount: 0,
        indexedChunkCount: 0,
        skippedObjectCount: 0,
        listingPartial,
        errors: [],
      };
    }

    const queued = readQueue(db);
    let processedCount = 0;

    for (const object of queued) {
      if (now() >= deadline) break;

      const size = object.size ?? 0;
      if (size > maxObjectBytes) {
        deleteOne(object.key);
        run.skippedObjectCount += 1;
      } else {
        try {
          const downloaded = await client.send(
            new GetObjectCommand({ Bucket: bucketName, Key: object.key }),
          );
          const buffer = await streamToBuffer(downloaded.Body);
          const text = await extractText(buffer, object.key);
          const chunks = chunkText(text);
          if (chunks.length === 0) {
            deleteOne(object.key);
            run.skippedObjectCount += 1;
          } else {
            replaceOne({ ...object, chunks });
            run.indexedObjectCount += 1;
            run.indexedChunkCount += chunks.length;
          }
        } catch (err) {
          run.errors.push(
            `${object.key}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
          );
        }
      }

      removeFromQueue(db, object.key);
      processedCount += 1;
    }

    const remaining = queued.length - processedCount;
    partial = run.listingPartial || remaining > 0;

    if (remaining > 0) {
      writeReconcileRun(db, run);
    } else {
      clearReconcileRun(db);
    }

    db.pragma("optimize");
  } finally {
    db.close();
  }

  // Checkpoint: upload progress whether this run finished or had to stop for
  // the time budget, so a timed-out invocation never discards completed work.
  await client.send(
    new PutObjectCommand({
      Bucket: indexBucket,
      Key: indexKey,
      Body: fs.readFileSync(dbPath),
      ContentType: "application/vnd.sqlite3",
    }),
  );

  return {
    indexBucket,
    indexKey,
    mode: run.listedObjectCount === 0 ? "skipped" : "reconcile",
    listedObjectCount: run.listedObjectCount,
    changedObjectCount: run.changedObjectCount,
    unchangedObjectCount: run.unchangedObjectCount,
    deletedObjectCount: run.deletedObjectCount,
    indexedObjectCount: run.indexedObjectCount,
    indexedChunkCount: run.indexedChunkCount,
    skippedObjectCount: run.skippedObjectCount,
    errorCount: run.errors.length,
    partial,
    errors: run.errors,
  };
}

export async function searchKeywordIndex({
  tenantId,
  knowledgeBaseId,
  bucketName,
  query,
  limit = 3,
  credentials,
  region,
}: KeywordSearchParams): Promise<RAGSource[]> {
  const match = ftsMatchQuery(query);
  if (!match) return [];

  const { indexBucket, indexKey } = keywordIndexLocation(tenantId, knowledgeBaseId, bucketName);
  const client = s3Client(region, credentials);
  const dbPath = tempIndexPath(tenantId, knowledgeBaseId);

  try {
    await downloadExistingIndex({ client, indexBucket, indexKey, dbPath });
    if (!fs.existsSync(dbPath)) return [];

    const db = initDatabase(dbPath);
    try {
      const rows = db.prepare(
        `
          SELECT
            rowid,
            s3_key as s3Key,
            file_name as fileName,
            snippet(chunks, 6, '', '', '...', 48) as snippet,
            bm25(chunks) as rank
          FROM chunks
          WHERE chunks MATCH ?
            AND tenant_id = ?
            AND knowledge_base_id = ?
            AND bucket = ?
          ORDER BY rank ASC
          LIMIT ?
        `,
      ).all(match, tenantId, knowledgeBaseId, bucketName, limit) as Array<{
        rowid: number;
        s3Key: string;
        fileName: string;
        snippet: string;
        rank: number;
      }>;

      return rows.map((row, index) => ({
        id: `keyword:${row.rowid}`,
        fileName: row.fileName,
        snippet: cleanText(row.snippet),
        score: Number((1 / (index + 1)).toFixed(3)),
        retrievalType: "keyword",
        s3Uri: `s3://${bucketName}/${row.s3Key}`,
      }));
    } finally {
      db.close();
    }
  } catch (err: any) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404 || err?.name === "NoSuchKey") return [];
    console.error("Keyword index search failed:", err);
    return [];
  }
}
