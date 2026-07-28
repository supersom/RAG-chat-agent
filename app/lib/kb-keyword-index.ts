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
  // The tenant-scoped S3 object diff computed by this run, reused by the
  // vector-sync side (see app/api/admin/kb/sync/route.ts) so it never needs
  // its own separate listing/change-detection pass. Only populated on a
  // fresh (non-resumed) run - a resumed run continues an already-computed
  // diff rather than recomputing one, so these come back empty.
  listedKeys: string[];
  changedKeys: string[];
  deletedKeys: string[];
};

// The tenant-scoped diff between what's currently in S3 and what this
// tenant's tracking store (the `documents` table) last saw. Shared by
// reconcileKeywordIndex (which also builds the FTS chunks) and
// trackTenantObjects (which only needs the diff, for tenants with keyword
// search disabled) so there is exactly one place that computes it.
type TenantObjectDiff = {
  listedObjectCount: number;
  listedKeys: string[];
  changed: S3InventoryObject[];
  changedKeys: string[];
  unchangedObjectCount: number;
  deletedKeys: string[];
  partial: boolean;
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
  maxPdfBytes?: number;
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

// A dedicated file for trackTenantObjects, deliberately separate from
// keywordIndexLocation's - that file can carry a large FTS chunks table
// once a tenant has ever had keyword search enabled, and trackTenantObjects
// only ever needs a handful of small tracking columns. Downloading a large
// chunks-laden file just to read/write those columns is expensive and
// pointless; live-confirmed on a real 75MB file: ~80-90s just to download
// and open it, close to Amplify's ~28s platform wall by itself. A separate,
// always-small file avoids that cost structurally rather than requiring a
// one-time (and itself slow) purge migration through the same bottleneck.
function trackingLocation(tenantId: string, knowledgeBaseId: string, bucketName: string) {
  const indexBucket = process.env.KEYWORD_INDEX_S3_BUCKET || bucketName;
  const safeTenant = encodeURIComponent(tenantId);
  const safeKb = encodeURIComponent(knowledgeBaseId);
  return {
    indexBucket,
    indexKey: `${keywordIndexPrefix()}/${safeTenant}/${safeKb}-tracking.sqlite`,
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

// Distinct from tempIndexPath so a warm Lambda container never has
// trackTenantObjects and reconcileKeywordIndex fighting over (or
// accidentally reusing a stale local copy of) the same local file for what
// are, since trackingLocation, two different remote S3 objects.
function tempTrackingPath(tenantId: string, knowledgeBaseId: string) {
  const hash = crypto
    .createHash("sha256")
    .update(`tracking:${tenantId}:${knowledgeBaseId}`)
    .digest("hex")
    .slice(0, 12);
  return path.join(os.tmpdir(), `customer-support-agent-keyword-${hash}.sqlite`);
}

function extensionForKey(key: string): string {
  return path.extname(key.split("?")[0] || "").toLowerCase();
}

// Pool-bucket objects are namespaced under tenants/<tenantId>/ (see
// app/api/admin/kb/upload-url/route.ts and scripts/migrate-tenants-to-pool.ts);
// the legacy per-KB buckets keep their objects flat at the bucket root.
const TENANT_NAMESPACE_ROOT = "tenants/";

function tenantKeyPrefix(tenantId: string): string {
  return `${TENANT_NAMESPACE_ROOT}${tenantId}/`;
}

// A key namespaced under *another* tenant is never this tenant's content, in
// any bucket. A key with no namespace at all is, because only the legacy
// single-KB buckets have those. Deciding from the key shape rather than from
// tenant.kbTier keeps this failing closed: kbTier is unset for every tenant
// that exists today, so a tier-driven check would silently not filter.
function belongsToTenant(key: string, tenantId: string): boolean {
  if (!key.startsWith(TENANT_NAMESPACE_ROOT)) return true;
  return key.startsWith(tenantKeyPrefix(tenantId));
}

function isSupportedObject(key: string): boolean {
  if (!key || key.endsWith("/")) return false;
  if (key.startsWith(`${keywordIndexPrefix()}/`)) return false;
  // Bedrock ingestion sidecars, not tenant content - mirrors
  // isMigratableObject in scripts/migrate-tenants-to-pool.ts.
  if (key.endsWith(".metadata.json")) return false;
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

async function ensureDOMMatrixPolyfill(): Promise<void> {
  if (globalThis.DOMMatrix) return;
  const { default: DOMMatrixShim } = await import("@thednp/dommatrix");
  // pdfjs-dist's own Node fallback only tries to source DOMMatrix from
  // @napi-rs/canvas when `globalThis.DOMMatrix` isn't already set - so
  // priming it ourselves first sidesteps that native binary entirely,
  // regardless of whether it would have loaded in this environment.
  globalThis.DOMMatrix = DOMMatrixShim as unknown as typeof DOMMatrix;
}

async function ensurePdfWorkerHandler(): Promise<void> {
  if ((globalThis as any).pdfjsWorker?.WorkerMessageHandler) return;
  // pdfjs-dist's Node "fake worker" setup dynamically imports its own
  // worker script via a runtime string path (`GlobalWorkerOptions.workerSrc`,
  // defaulting to "./pdf.worker.mjs"), which Next's output file tracing
  // doesn't follow, so the file never makes it into the deployed bundle
  // ("Cannot find module '.../pdf.worker.mjs'"). It checks
  // `globalThis.pdfjsWorker.WorkerMessageHandler` first and skips that
  // dynamic import entirely if present, so importing the worker module
  // ourselves - via a static, bundler-traceable specifier - and assigning
  // it there sidesteps the broken path resolution rather than fixing it.
  const workerModule = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  (globalThis as any).pdfjsWorker = { WorkerMessageHandler: workerModule.WorkerMessageHandler };
}

export async function extractText(buffer: Buffer, key: string): Promise<string> {
  const ext = extensionForKey(key);
  if (ext === ".pdf") {
    await ensureDOMMatrixPolyfill();
    await ensurePdfWorkerHandler();
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

async function listObjectsUnder({
  client,
  bucketName,
  tenantId,
  prefix,
}: {
  client: S3Client;
  bucketName: string;
  tenantId: string;
  prefix?: string;
}): Promise<{ objects: S3InventoryObject[]; partial: boolean }> {
  const maxObjects = Number(process.env.KEYWORD_INDEX_MAX_RECONCILE_OBJECTS || 0);
  const objects: S3InventoryObject[] = [];
  let continuationToken: string | undefined;
  let partial = false;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const object of page.Contents ?? []) {
      const key = object.Key;
      if (!key || !isSupportedObject(key)) continue;
      if (!belongsToTenant(key, tenantId)) continue;
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

async function listSupportedObjects({
  client,
  bucketName,
  tenantId,
}: {
  client: S3Client;
  bucketName: string;
  tenantId: string;
}): Promise<{ objects: S3InventoryObject[]; partial: boolean }> {
  // Scope the listing to this tenant's namespace first: in the pool bucket
  // that is the only content this tenant may index, and an unscoped list
  // would hand every other tenant's documents to insertObjectRows, which
  // stamps whatever it is given with *this* tenant's id.
  const scoped = await listObjectsUnder({
    client,
    bucketName,
    tenantId,
    prefix: tenantKeyPrefix(tenantId),
  });
  if (scoped.objects.length > 0 || scoped.partial) return scoped;

  // Nothing under the namespace: either a legacy bucket, whose objects sit
  // flat at the root, or a pooled tenant that has not uploaded anything yet.
  // A full listing covers the first case; belongsToTenant still drops any
  // other tenant's namespaced keys, so the second case stays isolated too.
  return listObjectsUnder({ client, bucketName, tenantId });
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

async function diffTenantObjects(
  db: Database.Database,
  params: { client: S3Client; bucketName: string; tenantId: string; knowledgeBaseId: string },
): Promise<TenantObjectDiff> {
  const { objects, partial } = await listSupportedObjects({
    client: params.client,
    bucketName: params.bucketName,
    tenantId: params.tenantId,
  });
  const existing = existingDocuments(db, {
    tenantId: params.tenantId,
    knowledgeBaseId: params.knowledgeBaseId,
    bucketName: params.bucketName,
  });
  const s3Keys = new Set(objects.map((object) => object.key));
  const deletedKeys = Array.from(existing.keys()).filter((key) => !s3Keys.has(key));

  const changed: S3InventoryObject[] = [];
  let unchangedObjectCount = 0;
  for (const object of objects) {
    if (!hasObjectChanged(object, existing.get(object.key))) {
      unchangedObjectCount += 1;
      continue;
    }
    changed.push(object);
  }

  return {
    listedObjectCount: objects.length,
    listedKeys: objects.map((object) => object.key),
    changed,
    changedKeys: changed.map((object) => object.key),
    unchangedObjectCount,
    deletedKeys,
    partial,
  };
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

// A tenant id is arbitrary text, and LIKE treats "_" as a single-character
// wildcard - unescaped, tenant "acme_eu" would match "acme-eu"'s namespace.
function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
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

// Amplify Compute's real execution limit sits around 28-30s (observed live:
// a 28,005ms round completed normally, the very next round was hard-killed
// with "Request timed out"). The budget check only runs between objects, so
// a single slow object (e.g. a multi-megabyte PDF) can push a round well
// past a 20s soft budget before the next check - this leaves enough margin
// for that overrun to still land safely under the real wall.
const DEFAULT_TIME_BUDGET_MS = 12_000;

// The time budget can only stop the loop *between* objects - it can't
// interrupt a single object's synchronous PDF parsing once started. Measured
// live against real PDFs from this corpus: a 5MB PDF parsed in ~2s, 9.3MB in
// ~7.3s, but a 21MB reference-manual PDF took 54s - well over the entire
// platform timeout by itself, regardless of how low the time budget is set.
// Capping PDF size specifically (other extensions parse near-instantly
// regardless of size) keeps any single object's worst-case processing time
// well clear of that wall, based on where the measured blowup began.
const DEFAULT_MAX_PDF_BYTES = 12 * 1024 * 1024;

export async function reconcileKeywordIndex({
  tenantId,
  knowledgeBaseId,
  bucketName,
  credentials,
  region,
  timeBudgetMs,
  now = Date.now,
  maxPdfBytes,
}: KeywordIndexParams): Promise<KeywordIndexUpdateResult> {
  const { indexBucket, indexKey } = keywordIndexLocation(tenantId, knowledgeBaseId, bucketName);
  const client = s3Client(region, credentials);
  const dbPath = tempIndexPath(tenantId, knowledgeBaseId);
  await downloadExistingIndex({ client, indexBucket, indexKey, dbPath });

  const db = initDatabase(dbPath);
  const maxObjectBytes = Number(process.env.KEYWORD_INDEX_MAX_OBJECT_BYTES || 50 * 1024 * 1024);
  const maxPdfBytesLimit =
    maxPdfBytes ?? Number(process.env.KEYWORD_INDEX_MAX_PDF_BYTES || DEFAULT_MAX_PDF_BYTES);
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
  // Only populated on a fresh (non-resumed) run - see KeywordIndexUpdateResult.
  let listedKeys: string[] = [];
  let changedKeys: string[] = [];
  let deletedKeys: string[] = [];

  try {
    const resumed = readReconcileRun(db);

    if (resumed) {
      run = resumed;
    } else {
      // Fresh run: list the bucket once, decide what changed, and run the
      // stale-object deletion sweep - all of this depends on having the full
      // current listing, so none of it is repeated on a resumed invocation.
      const diff = await diffTenantObjects(db, { client, bucketName, tenantId, knowledgeBaseId });

      if (!diff.partial) {
        for (const key of diff.deletedKeys) deleteOne(key);
      }

      clearQueue(db);
      enqueueObjects(db, diff.changed);

      listedKeys = diff.listedKeys;
      changedKeys = diff.changedKeys;
      deletedKeys = diff.partial ? [] : diff.deletedKeys;

      run = {
        listedObjectCount: diff.listedObjectCount,
        changedObjectCount: diff.changedKeys.length,
        unchangedObjectCount: diff.unchangedObjectCount,
        deletedObjectCount: deletedKeys.length,
        indexedObjectCount: 0,
        indexedChunkCount: 0,
        skippedObjectCount: 0,
        listingPartial: diff.partial,
        errors: [],
      };
    }

    const queued = readQueue(db);
    let processedCount = 0;

    for (const object of queued) {
      if (now() >= deadline) break;

      const size = object.size ?? 0;
      const isOversizedPdf =
        extensionForKey(object.key) === ".pdf" && size > maxPdfBytesLimit;
      if (size > maxObjectBytes || isOversizedPdf) {
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
    listedKeys,
    changedKeys,
    deletedKeys,
  };
}

// The tenant-scoped equivalent of reconcileKeywordIndex for tenants with
// keyword search disabled: computes and records the same S3 object diff
// (so future syncs' change-detection stays correct and vector-sync always
// has a diff to work from, regardless of the keyword-search toggle) but
// skips downloading, extracting, and chunking file content entirely - there
// is no FTS index to build. Cheap enough (S3 listing + lightweight SQLite
// row writes) that it doesn't need the time-budget/checkpoint machinery
// reconcileKeywordIndex needs for its much more expensive per-object work.
export async function trackTenantObjects({
  tenantId,
  knowledgeBaseId,
  bucketName,
  credentials,
  region,
}: KeywordIndexParams): Promise<{
  listedObjectCount: number;
  listedKeys: string[];
  changedKeys: string[];
  deletedKeys: string[];
  partial: boolean;
}> {
  const { indexBucket, indexKey } = trackingLocation(tenantId, knowledgeBaseId, bucketName);
  const client = s3Client(region, credentials);
  const dbPath = tempTrackingPath(tenantId, knowledgeBaseId);
  await downloadExistingIndex({ client, indexBucket, indexKey, dbPath });

  const db = initDatabase(dbPath);
  let diff: TenantObjectDiff;

  try {
    diff = await diffTenantObjects(db, { client, bucketName, tenantId, knowledgeBaseId });

    if (!diff.partial) {
      const recordTracking = db.transaction((objects: S3InventoryObject[]) => {
        for (const object of objects) {
          deleteObjectRows(db, { tenantId, knowledgeBaseId, bucketName, key: object.key });
          insertObjectRows({
            db,
            tenantId,
            knowledgeBaseId,
            bucketName,
            key: object.key,
            etag: object.etag,
            size: object.size,
            lastModified: object.lastModified,
            chunks: [],
          });
        }
      });
      recordTracking(diff.changed);

      for (const key of diff.deletedKeys) {
        deleteObjectRows(db, { tenantId, knowledgeBaseId, bucketName, key });
      }
    }

    db.pragma("optimize");
  } finally {
    db.close();
  }

  await client.send(
    new PutObjectCommand({
      Bucket: indexBucket,
      Key: indexKey,
      Body: fs.readFileSync(dbPath),
      ContentType: "application/vnd.sqlite3",
    }),
  );

  return {
    listedObjectCount: diff.listedObjectCount,
    listedKeys: diff.listedKeys,
    changedKeys: diff.changedKeys,
    deletedKeys: diff.partial ? [] : diff.deletedKeys,
    partial: diff.partial,
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
            AND (s3_key NOT LIKE ? OR s3_key LIKE ? ESCAPE '\\')
          ORDER BY rank ASC
          LIMIT ?
        `,
      ).all(
        match,
        tenantId,
        knowledgeBaseId,
        bucketName,
        // tenant_id alone trusts whatever the indexer stamped on the row. An
        // index built before the listing was scoped (or by a future scoping
        // bug) holds other tenants' keys under this tenant's id, so the key's
        // own namespace has to be checked at read time as well.
        `${TENANT_NAMESPACE_ROOT}%`,
        `${escapeLikeLiteral(tenantKeyPrefix(tenantId))}%`,
        limit,
      ) as Array<{
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
