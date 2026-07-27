#!/usr/bin/env -S npx tsx
// One-off migration: copy each legacy tenant's KB content into the shared
// pool bucket/KB and repoint the tenant at it. Run manually, once, per
// tenant set. See .superpowers/sdd/shimmying-toasting-squid/task-5-brief.md.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/migrate-tenants-to-pool.ts \
//     --tenant-id <tenantId> [--tenant-id <tenantId> ...] \
//     --pool-kb-id <POOL_KB_ID> --pool-bucket <POOL_BUCKET_NAME> \
//     [--dry-run]
//
// Tenant IDs, pool KB ID, and pool bucket name may also come from
// TENANT_IDS (comma-separated), POOL_KB_ID, and POOL_BUCKET_NAME env vars.
// Tenant IDs are required, explicit input (not discovered by scanning the
// Tenants table) -- see the "tenant discovery" note in the task 5 report:
// the table now holds more rows than distinct legacy KBs (test tenants
// created during earlier dev sessions share the same two legacy KBs), so a
// scan-by-knowledgeBaseId heuristic would silently sweep in tenants nobody
// asked to migrate. The human operator names exactly who moves.
//
// --dry-run performs steps 1-2 only (resolve each tenant's source bucket,
// list what would be copied) and makes no AWS writes: no CopyObject, no
// PutObject, no updateTenant, no StartIngestionJob.
//
// A real (non-dry-run) invocation also needs `retrieveContext`'s own
// AWS SDK call, not the app's `app/lib/rag.ts` wrapper: that module does
// `import "server-only"`, a package Next.js resolves via its own build
// pipeline and that isn't an installed npm dependency -- it can't be
// imported outside `next build`/`next dev`. This script builds the same
// RetrieveCommand call directly instead, per the brief's "or a direct
// RetrieveCommand" fallback.

import { fileURLToPath } from "url";
import {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { getKbDataSource, startKbIngestion, getKbIngestionStatus } from "../app/lib/bedrock-kb";
import { getTenant, updateTenant } from "../app/lib/db/tenants";
import type { KbDataSource } from "../app/lib/bedrock-kb";
import type { Tenant } from "../app/lib/db/schema";

// Matches the default in app/lib/kb-keyword-index.ts. That module lets this
// be overridden via KEYWORD_INDEX_S3_PREFIX; this one-off script doesn't
// bother threading that override through since neither legacy bucket uses
// a non-default prefix today.
const KEYWORD_INDEX_PREFIX = ".customer-support-agent/keyword-indexes/";

export interface MigrationConfig {
  tenantIds: string[];
  poolKbId: string;
  poolBucket: string;
  dryRun: boolean;
}

export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): MigrationConfig {
  const tenantIds: string[] = [];
  let poolKbId = env.POOL_KB_ID;
  let poolBucket = env.POOL_BUCKET_NAME;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--tenant-id":
      case "--tenant-ids": {
        const value = argv[++i];
        if (!value) throw new Error(`${arg} requires a value`);
        tenantIds.push(
          ...value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      }
      case "--pool-kb-id": {
        const value = argv[++i];
        if (!value) throw new Error(`${arg} requires a value`);
        poolKbId = value;
        break;
      }
      case "--pool-bucket": {
        const value = argv[++i];
        if (!value) throw new Error(`${arg} requires a value`);
        poolBucket = value;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      default:
        throw new Error(`Unrecognized argument: ${arg}`);
    }
  }

  if (tenantIds.length === 0 && env.TENANT_IDS) {
    tenantIds.push(
      ...env.TENANT_IDS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  const uniqueTenantIds = Array.from(new Set(tenantIds));

  if (uniqueTenantIds.length === 0) {
    throw new Error(
      "At least one tenant ID is required: pass --tenant-id <id> (repeatable, or comma-separated) or set TENANT_IDS.",
    );
  }
  if (!poolKbId) {
    throw new Error("Pool KB ID is required: pass --pool-kb-id <id> or set POOL_KB_ID.");
  }
  if (!poolBucket) {
    throw new Error(
      "Pool bucket name is required: pass --pool-bucket <name> or set POOL_BUCKET_NAME.",
    );
  }

  return { tenantIds: uniqueTenantIds, poolKbId, poolBucket, dryRun };
}

// Excludes the internal keyword-search index (rebuilt automatically per
// tenant/KB by app/lib/kb-keyword-index.ts -- not tenant content) and any
// pre-existing metadata sidecar (this script writes its own sidecar for
// every copied object, so a source-side sidecar would be a stale
// duplicate, not something to carry forward).
export function isMigratableObject(key: string): boolean {
  if (!key || key.endsWith("/")) return false;
  if (key.startsWith(KEYWORD_INDEX_PREFIX)) return false;
  if (key.endsWith(".metadata.json")) return false;
  return true;
}

export function destinationKey(tenantId: string, sourceKey: string): string {
  return `tenants/${tenantId}/${sourceKey}`;
}

export interface CopyPlanItem {
  sourceKey: string;
  destKey: string;
  sidecarKey: string;
}

export function buildCopyPlan(tenantId: string, sourceKeys: string[]): CopyPlanItem[] {
  return sourceKeys.filter(isMigratableObject).map((sourceKey) => {
    const destKey = destinationKey(tenantId, sourceKey);
    return { sourceKey, destKey, sidecarKey: `${destKey}.metadata.json` };
  });
}

function awsRegion(): string {
  return process.env.AWS_REGION || process.env.BAWS_REGION || "us-east-2";
}

function awsCredentials() {
  return {
    accessKeyId: process.env.BAWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.BAWS_SECRET_ACCESS_KEY!,
  };
}

function makeS3Client(): S3Client {
  return new S3Client({ region: awsRegion(), credentials: awsCredentials() });
}

function makeBedrockRuntimeClient(): BedrockAgentRuntimeClient {
  return new BedrockAgentRuntimeClient({ region: awsRegion(), credentials: awsCredentials() });
}

export async function listAllObjectKeys(client: S3Client, bucket: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
    );
    for (const obj of page.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

// S3's CopySource header takes a `/bucket/key` path where the key must be
// URI-encoded per path segment (slashes preserved) -- this corpus has plenty
// of keys with spaces and parens (real PDF filenames seen in the legacy
// buckets), which will 400 without this.
function encodeS3Key(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export async function copyObjectWithSidecar(
  client: S3Client,
  params: { sourceBucket: string; destBucket: string; tenantId: string; item: CopyPlanItem },
): Promise<void> {
  const { sourceBucket, destBucket, tenantId, item } = params;
  await client.send(
    new CopyObjectCommand({
      Bucket: destBucket,
      Key: item.destKey,
      CopySource: `/${sourceBucket}/${encodeS3Key(item.sourceKey)}`,
    }),
  );
  // Written directly, matching app/api/admin/kb/upload-url/route.ts's
  // sidecar convention -- Bedrock reads this during ingestion to attach
  // tenantId metadata to every chunk generated from the object next to it.
  await client.send(
    new PutObjectCommand({
      Bucket: destBucket,
      Key: item.sidecarKey,
      Body: JSON.stringify({ metadataAttributes: { tenantId } }),
      ContentType: "application/json",
    }),
  );
}

async function pollIngestionUntilComplete(
  kbId: string,
  dataSourceId: string,
  jobId: string,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<"COMPLETE" | "FAILED" | "TIMEOUT"> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const status = await getKbIngestionStatus(kbId, dataSourceId, jobId);
    if (status.status === "COMPLETE") return "COMPLETE";
    if (status.status === "FAILED") return "FAILED";
    if (Date.now() >= deadline) return "TIMEOUT";
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
  }
}

interface RetrievedResult {
  uri: string;
  score: number;
}

async function retrieveForTenant(
  client: BedrockAgentRuntimeClient,
  knowledgeBaseId: string,
  tenantId: string,
  query: string,
  n = 5,
): Promise<RetrievedResult[]> {
  const response = await client.send(
    new RetrieveCommand({
      knowledgeBaseId,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: n,
          filter: { equals: { key: "tenantId", value: tenantId } },
        },
      },
    }),
  );
  return (response.retrievalResults ?? []).map((r) => ({
    uri: r.location?.s3Location?.uri || "",
    score: r.score || 0,
  }));
}

// Picks a query string likely to hit real content: the filename of the
// first non-junk copied object, humanized the same way app/lib/rag.ts
// humanizes fileName for display. Falls back to a generic term if a
// tenant's plan is empty or entirely made up of un-queryable paths (e.g.
// the `.git` dumps found in one of the two real legacy buckets).
function sampleQueryFor(items: CopyPlanItem[]): string {
  const candidate = items.find((item) => !item.sourceKey.includes("/.git/"));
  if (!candidate) return "policy";
  const base = candidate.sourceKey.split("/").pop() || "";
  const withoutExt = base.replace(/\.[^./]+$/, "");
  const humanized = withoutExt.replace(/[_-]+/g, " ").trim();
  return humanized || "policy";
}

async function main() {
  const config = parseArgs(process.argv.slice(2));

  console.log(`Pool KB ID:   ${config.poolKbId}`);
  console.log(`Pool bucket:  ${config.poolBucket}`);
  console.log(`Tenants:      ${config.tenantIds.join(", ")}`);
  console.log(`Mode:         ${config.dryRun ? "DRY RUN (read-only)" : "LIVE"}`);
  console.log("");

  const s3 = makeS3Client();
  const plans = new Map<
    string,
    { tenant: Tenant; dataSource: KbDataSource; items: CopyPlanItem[] }
  >();

  // Steps 1-2: resolve each tenant's source bucket and build its copy plan.
  for (const tenantId of config.tenantIds) {
    console.log(`--- ${tenantId} ---`);
    const tenant = await getTenant(tenantId);
    if (!tenant) {
      throw new Error(`Tenant not found: ${tenantId}`);
    }
    console.log(`  name:                ${tenant.name}`);
    console.log(`  current KB:          ${tenant.knowledgeBaseId}`);

    const dataSource = await getKbDataSource(tenant.knowledgeBaseId);
    if (!dataSource) {
      throw new Error(
        `Could not resolve a data source for tenant ${tenantId}'s KB ${tenant.knowledgeBaseId}`,
      );
    }
    console.log(`  source bucket:       ${dataSource.bucketName}`);
    console.log(`  source dataSourceId: ${dataSource.dataSourceId}`);

    const sourceKeys = await listAllObjectKeys(s3, dataSource.bucketName);
    const plan = buildCopyPlan(tenantId, sourceKeys);
    const excluded = sourceKeys.length - plan.length;
    console.log(
      `  objects in bucket:   ${sourceKeys.length} (${excluded} excluded: keyword-index / sidecar artifacts)`,
    );
    console.log(`  objects to copy:     ${plan.length}`);
    const preview = plan.slice(0, 10);
    for (const item of preview) {
      console.log(`    ${item.sourceKey} -> ${item.destKey}`);
    }
    if (plan.length > preview.length) {
      console.log(`    ... and ${plan.length - preview.length} more`);
    }
    console.log("");

    plans.set(tenantId, { tenant, dataSource, items: plan });
  }

  if (config.dryRun) {
    console.log("Dry run complete. No AWS writes were performed.");
    return;
  }

  // Step 2 (writes): copy every planned object + its metadata sidecar.
  for (const tenantId of config.tenantIds) {
    const { dataSource, items } = plans.get(tenantId)!;
    console.log(`Copying ${items.length} objects for ${tenantId}...`);
    for (const item of items) {
      await copyObjectWithSidecar(s3, {
        sourceBucket: dataSource.bucketName,
        destBucket: config.poolBucket,
        tenantId,
        item,
      });
    }
  }

  // Step 3: repoint each tenant at the pool KB.
  for (const tenantId of config.tenantIds) {
    await updateTenant(tenantId, { knowledgeBaseId: config.poolKbId });
    console.log(`Updated tenant ${tenantId} -> knowledgeBaseId ${config.poolKbId}`);
  }

  // Step 4: trigger ingestion once, on the pool KB's own data source.
  const poolDataSource = await getKbDataSource(config.poolKbId);
  if (!poolDataSource) {
    throw new Error(`Could not resolve a data source for pool KB ${config.poolKbId}`);
  }
  const jobId = await startKbIngestion(config.poolKbId, poolDataSource.dataSourceId);
  console.log(`Started ingestion job ${jobId} on pool KB ${config.poolKbId}`);

  console.log("Waiting for ingestion to complete before verification (up to 20 minutes)...");
  const outcome = await pollIngestionUntilComplete(
    config.poolKbId,
    poolDataSource.dataSourceId,
    jobId,
    { timeoutMs: 20 * 60 * 1000, intervalMs: 15_000 },
  );
  console.log(`Ingestion outcome: ${outcome}`);

  if (outcome !== "COMPLETE") {
    console.warn(
      "Skipping step 5 verification: ingestion did not complete. Re-run verification manually (or re-run this script) once it does.",
    );
    return;
  }

  // Step 5: verify per-tenant isolation against the pool KB.
  console.log("Verifying tenant isolation...");
  const bedrockRuntime = makeBedrockRuntimeClient();
  for (const tenantId of config.tenantIds) {
    const { items } = plans.get(tenantId)!;
    const query = sampleQueryFor(items);
    const results = await retrieveForTenant(bedrockRuntime, config.poolKbId, tenantId, query, 5);
    const ownPrefix = `/tenants/${tenantId}/`;
    const own = results.filter((r) => r.uri.includes(ownPrefix));
    const unexpected = results.filter((r) => !r.uri.includes(ownPrefix));
    console.log(
      `  [${tenantId}] query="${query}" -> ${results.length} result(s), ${own.length} under this tenant's prefix, ${unexpected.length} unexpected`,
    );
    if (unexpected.length > 0) {
      console.warn(`  WARNING: possible cross-tenant leakage for ${tenantId}:`);
      for (const r of unexpected) console.warn(`    ${r.uri}`);
    }
    // The symmetric failure: the filter is holding but this tenant's own
    // content never came back, i.e. the copy or the sidecar metadata did not
    // take. Nothing else in this run would flag that, and migrations are
    // expected to run tenant-by-tenant rather than all at once.
    if (own.length === 0) {
      console.warn(
        `  WARNING: no content under tenants/${tenantId}/ came back for ${tenantId} - check that its objects and .metadata.json sidecars ingested successfully.`,
      );
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
