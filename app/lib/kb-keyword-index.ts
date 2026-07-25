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
import { PDFParse } from "pdf-parse";
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
  `);
  return db;
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

export async function reconcileKeywordIndex({
  tenantId,
  knowledgeBaseId,
  bucketName,
  credentials,
  region,
}: KeywordIndexParams): Promise<KeywordIndexUpdateResult> {
  const { indexBucket, indexKey } = keywordIndexLocation(tenantId, knowledgeBaseId, bucketName);
  const client = s3Client(region, credentials);
  const dbPath = tempIndexPath(tenantId, knowledgeBaseId);
  await downloadExistingIndex({ client, indexBucket, indexKey, dbPath });

  const { objects, partial } = await listSupportedObjects({ client, bucketName });
  const db = initDatabase(dbPath);
  const maxObjectBytes = Number(process.env.KEYWORD_INDEX_MAX_OBJECT_BYTES || 50 * 1024 * 1024);
  const errors: string[] = [];
  let indexedObjectCount = 0;
  let indexedChunkCount = 0;
  let skippedObjectCount = 0;
  let unchangedObjectCount = 0;
  let deletedObjectCount = 0;
  let changedObjectCount = 0;

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

  try {
    const existing = existingDocuments(db, { tenantId, knowledgeBaseId, bucketName });
    const s3Keys = new Set(objects.map((object) => object.key));

    if (!partial) {
      for (const key of Array.from(existing.keys())) {
        if (!s3Keys.has(key)) {
          deleteOne(key);
          deletedObjectCount += 1;
        }
      }
    }

    for (const object of objects) {
      const previous = existing.get(object.key);
      if (!hasObjectChanged(object, previous)) {
        unchangedObjectCount += 1;
        continue;
      }

      changedObjectCount += 1;
      const size = object.size ?? 0;
      if (size > maxObjectBytes) {
        deleteOne(object.key);
        skippedObjectCount += 1;
        continue;
      }

      try {
        const downloaded = await client.send(
          new GetObjectCommand({ Bucket: bucketName, Key: object.key }),
        );
        const buffer = await streamToBuffer(downloaded.Body);
        const text = await extractText(buffer, object.key);
        const chunks = chunkText(text);
        if (chunks.length === 0) {
          deleteOne(object.key);
          skippedObjectCount += 1;
          continue;
        }

        replaceOne({ ...object, chunks });
        indexedObjectCount += 1;
        indexedChunkCount += chunks.length;
      } catch (err) {
        errors.push(`${object.key}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
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
    indexBucket,
    indexKey,
    mode: objects.length === 0 ? "skipped" : "reconcile",
    listedObjectCount: objects.length,
    changedObjectCount,
    unchangedObjectCount,
    deletedObjectCount,
    indexedObjectCount,
    indexedChunkCount,
    skippedObjectCount,
    errorCount: errors.length,
    partial,
    errors,
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
