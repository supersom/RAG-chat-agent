# Async Keyword-Index Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `reconcileKeywordIndex` (building/updating a tenant's keyword-search FTS index) off the request/response cycle entirely, so a large tenant's whole-file S3 download+reupload (measured at 60-180s for a 75MB index — 3-6x Amplify's ~28s wall) can never hard-time-out a "Sync" click again.

**Architecture:** `POST /api/admin/kb/sync` enqueues an SQS message and returns immediately; a dedicated container-image Lambda worker (its own IAM execution role, 10-minute timeout, triggered by the queue) runs `reconcileKeywordIndex` in a loop until it reports `partial: false`, writing progress to a new `KeywordSyncJobs` DynamoDB table. The admin UI polls a new status route until the job is `complete`/`failed`. `trackTenantObjects` now runs unconditionally in-request to keep driving `submitVectorSync`'s diff (unchanged), fully decoupled from the (now async) keyword-index build.

**Tech Stack:** Next.js 14 (App Router, existing), AWS Lambda (new, Node.js 20, container image), SQS, DynamoDB, S3, Terraform (`~> 5.60` AWS provider, already pinned), Vitest.

## Global Constraints

- **Minimal for current scale (2 tenants), not the 10K-tenant plan** — no queue partitioning, no worker autoscaling tuning, no per-tenant fairness logic. See `~/.claude/plans/shimmying-toasting-squid.md` for that separate, later initiative.
- **Only `reconcileKeywordIndex` moves async.** `submitVectorSync` keeps its existing in-request checkpointing exactly as-is.
- **One in-flight keyword-sync job per tenant.** A second "Sync" click while one is `queued`/`running` must not enqueue a duplicate job against the same SQLite file.
- **The worker gets its own IAM execution role, not the shared `claude-qkstart-bedrock` IAM user's static keys.** This requires `awsCredentials`/`s3Client` in `app/lib/kb-keyword-index.ts` to omit the `credentials` field when neither an explicit override nor `BAWS_*` env vars are present, so the AWS SDK's default credential provider chain (which finds a Lambda execution role automatically) takes over. The existing Next.js app keeps using `BAWS_*` static keys unchanged — Amplify Compute doesn't expose a usable execution role for the app's own AWS calls today (established constraint, see `DEVLOG.md`/`iam.tf`).
- **DynamoDB table naming:** `CustomerSupportAgent-<Name>`, `PAY_PER_REQUEST` billing, `lifecycle { prevent_destroy = true }` — matches every existing table in `infra/terraform/dynamodb.tf`.
- **`terraform apply` and `docker push` are run by the user, not by an agent** — Claude Code's auto-mode classifier blocks `terraform apply` even after an approved plan (established constraint, see `DEVLOG.md` 2026-07-27/28 entries). Every infra step in this plan ends with a verification command an agent CAN run (`terraform validate`, `terraform plan`, `docker build` locally) and an explicit note that apply/push is the user's step.
- **No secrets in git.** `terraform.tfvars` stays gitignored, matching current practice.

---

## File Structure

```
app/lib/
  kb-sync-queue.ts              # NEW - SQS send wrapper (Next.js side, BAWS_*-based)
  kb-sync-queue.test.ts         # NEW
  kb-keyword-index.ts           # MODIFY - role-based credential fallback, export KeywordIndexParams
  kb-keyword-index.test.ts      # MODIFY - new tests for the credential fallback
  db/
    keyword-sync-jobs.ts        # NEW - KeywordSyncJob type + client-injectable CRUD
    keyword-sync-jobs.test.ts   # NEW

app/api/admin/kb/sync/
  route.ts                      # MODIFY - always trackTenantObjects, enqueue instead of reconcile inline
  route.test.ts                 # MODIFY
  keyword-status/
    route.ts                    # NEW - GET job status
    route.test.ts               # NEW

lambda/kb-keyword-sync-worker/  # NEW directory - standalone Lambda, not part of the Next.js build
  handler.ts                    # SQS-triggered entrypoint
  handler.test.ts
  db-client.ts                  # role-based DynamoDB client (no BAWS_* fallback)
  Dockerfile
  package.json                  # own minimal deps for the container image
  tsconfig.json

components/admin/
  KnowledgeBaseManager.tsx      # MODIFY - poll keyword-status instead of resume-chaining reconcile

infra/terraform/
  kb_keyword_sync.tf            # NEW - SQS queue+DLQ, DynamoDB table, ECR repo, IAM role, Lambda, event source mapping

amplify.yml                     # MODIFY - bake DYNAMODB_KEYWORD_SYNC_JOBS_TABLE / KB_KEYWORD_SYNC_QUEUE_URL
```

---

### Task 1: SQS send wrapper for the Next.js route

**Files:**
- Create: `app/lib/kb-sync-queue.ts`
- Test: `app/lib/kb-sync-queue.test.ts`
- Modify: `package.json` (add `@aws-sdk/client-sqs`)

**Interfaces:**
- Produces: `sendKeywordSyncJob(params: { tenantId: string; knowledgeBaseId: string; bucketName: string; region?: string; mode: "full" | "incremental" }): Promise<void>` — used by Task 6's route change.

- [ ] **Step 1: Add the SQS SDK dependency**

```bash
npm install @aws-sdk/client-sqs
```

- [ ] **Step 2: Write the failing test**

```typescript
// app/lib/kb-sync-queue.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  SendMessageCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

import { sendKeywordSyncJob } from "./kb-sync-queue";

describe("sendKeywordSyncJob", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.KB_KEYWORD_SYNC_QUEUE_URL = "https://sqs.us-east-2.amazonaws.com/123/test-queue";
  });

  it("sends one SQS message with the job payload as JSON", async () => {
    await sendKeywordSyncJob({
      tenantId: "acme",
      knowledgeBaseId: "kb-acme",
      bucketName: "pooled-bucket",
      region: "us-east-2",
      mode: "incremental",
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [{ input }] = sendMock.mock.calls[0];
    expect(input.QueueUrl).toBe("https://sqs.us-east-2.amazonaws.com/123/test-queue");
    expect(JSON.parse(input.MessageBody)).toEqual({
      tenantId: "acme",
      knowledgeBaseId: "kb-acme",
      bucketName: "pooled-bucket",
      region: "us-east-2",
      mode: "incremental",
    });
  });

  it("throws if KB_KEYWORD_SYNC_QUEUE_URL is not configured", async () => {
    delete process.env.KB_KEYWORD_SYNC_QUEUE_URL;

    await expect(
      sendKeywordSyncJob({
        tenantId: "acme",
        knowledgeBaseId: "kb-acme",
        bucketName: "pooled-bucket",
        mode: "incremental",
      }),
    ).rejects.toThrow("KB_KEYWORD_SYNC_QUEUE_URL");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/lib/kb-sync-queue.test.ts`
Expected: FAIL — `Cannot find module './kb-sync-queue'`

- [ ] **Step 4: Write the implementation**

```typescript
// app/lib/kb-sync-queue.ts
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

export type KeywordSyncJobMessage = {
  tenantId: string;
  knowledgeBaseId: string;
  bucketName: string;
  region?: string;
  mode: "full" | "incremental";
};

// Matches every other AWS client in app/lib/ (see kb-keyword-index.ts's
// s3Client): constructed inside the call site, not at module top level,
// since reading process.env at import time returned undefined credentials
// under Amplify's Web Compute bundling. Uses the same BAWS_* static keys as
// the rest of the Next.js app - unlike the worker Lambda, Amplify Compute
// doesn't expose a usable execution role for the app's own AWS calls today.
function sqsClient(region?: string): SQSClient {
  return new SQSClient({
    region: region || process.env.AWS_REGION || process.env.BAWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.BAWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.BAWS_SECRET_ACCESS_KEY!,
    },
  });
}

export async function sendKeywordSyncJob(message: KeywordSyncJobMessage): Promise<void> {
  const queueUrl = process.env.KB_KEYWORD_SYNC_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("KB_KEYWORD_SYNC_QUEUE_URL is not configured");
  }

  const client = sqsClient(message.region);
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
    }),
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/lib/kb-sync-queue.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json app/lib/kb-sync-queue.ts app/lib/kb-sync-queue.test.ts
git commit -m "Add SQS send wrapper for the async keyword-index sync job"
```

---

### Task 2: Role-based credential fallback in `kb-keyword-index.ts`

**Files:**
- Modify: `app/lib/kb-keyword-index.ts:127-139` (`awsCredentials`, `s3Client`)
- Test: `app/lib/kb-keyword-index.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `awsCredentials` becomes exported (for direct unit testing) and can return `undefined`. No change to `reconcileKeywordIndex`'s existing signature or behavior when `BAWS_*` env vars ARE set (the Next.js app's own behavior is unaffected).

- [ ] **Step 1: Write the failing test**

```typescript
// Add to app/lib/kb-keyword-index.test.ts
import { awsCredentials } from "./kb-keyword-index";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/kb-keyword-index.test.ts -t "awsCredentials"`
Expected: FAIL — `awsCredentials` is not exported / third test fails (currently returns `{accessKeyId: undefined!, secretAccessKey: undefined!}`, not `undefined`)

- [ ] **Step 3: Implement the fix**

In `app/lib/kb-keyword-index.ts`, replace:

```typescript
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
```

with:

```typescript
// Returns undefined (not a partially-undefined object) when neither an
// explicit override nor BAWS_* env vars are present, so callers can omit
// the `credentials` field entirely from the AWS SDK client constructor -
// that's what lets the SDK's own default provider chain discover a Lambda
// execution role's credentials automatically. Passing an explicit object
// with undefined fields (the old behavior) overrides that discovery and
// breaks in any context that isn't the Next.js app's own BAWS_*-keyed one
// (e.g. the async keyword-sync worker Lambda, which has its own execution
// role and no BAWS_* env vars at all).
export function awsCredentials(
  credentials?: AwsCredentials,
): { accessKeyId: string; secretAccessKey: string } | undefined {
  const accessKeyId = credentials?.accessKeyId || process.env.BAWS_ACCESS_KEY_ID;
  const secretAccessKey = credentials?.secretAccessKey || process.env.BAWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey };
}

function s3Client(region?: string, credentials?: AwsCredentials): S3Client {
  const resolvedCredentials = awsCredentials(credentials);
  return new S3Client({
    region: region || process.env.AWS_REGION || process.env.BAWS_REGION || DEFAULT_REGION,
    ...(resolvedCredentials ? { credentials: resolvedCredentials } : {}),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/kb-keyword-index.test.ts`
Expected: PASS, all tests in the file (existing + 3 new)

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All pass, no type errors (confirms nothing else constructed `AwsCredentials` in a way that assumed non-optional fields)

- [ ] **Step 6: Commit**

```bash
git add app/lib/kb-keyword-index.ts app/lib/kb-keyword-index.test.ts
git commit -m "Let AWS clients fall back to the SDK's default credential chain when no explicit or BAWS_* credentials are set"
```

---

### Task 3: `KeywordSyncJobs` DynamoDB table + data-access module

**Files:**
- Create: `infra/terraform/kb_keyword_sync.tf` (DynamoDB table only in this task — SQS/Lambda/IAM come in Task 5)
- Create: `app/lib/db/keyword-sync-jobs.ts`
- Test: `app/lib/db/keyword-sync-jobs.test.ts`

**Interfaces:**
- Produces: `KeywordSyncJob` type, `getKeywordSyncJob(tenantId, client?)`, `putKeywordSyncJob(job, client?)` — used by Task 4 (worker), Task 6 (sync route), Task 7 (status route).

- [ ] **Step 1: Add the DynamoDB table to Terraform**

```hcl
# infra/terraform/kb_keyword_sync.tf

# Tracks the async keyword-index sync job started by POST /api/admin/kb/sync
# and updated by the kb-keyword-sync-worker Lambda (see Task 5 in
# docs/superpowers/plans/2026-07-28-async-keyword-index-sync.md). One record
# per tenant - a tenant only ever has one in-flight job at a time.
resource "aws_dynamodb_table" "keyword_sync_jobs" {
  name         = "CustomerSupportAgent-KeywordSyncJobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tenantId"

  attribute {
    name = "tenantId"
    type = "S"
  }

  lifecycle {
    prevent_destroy = true
  }
}
```

- [ ] **Step 2: Run terraform validate**

Run: `cd infra/terraform && terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Write the failing test**

```typescript
// app/lib/db/keyword-sync-jobs.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("@aws-sdk/lib-dynamodb", async () => {
  const actual = await vi.importActual("@aws-sdk/lib-dynamodb");
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send: sendMock }) } };
});

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getKeywordSyncJob, putKeywordSyncJob, KeywordSyncJob } from "./keyword-sync-jobs";

const testClient = DynamoDBDocumentClient.from({} as never);

describe("getKeywordSyncJob", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.DYNAMODB_KEYWORD_SYNC_JOBS_TABLE = "CustomerSupportAgent-KeywordSyncJobs";
  });

  it("returns null when no job exists for the tenant", async () => {
    sendMock.mockResolvedValue({ Item: undefined });

    const result = await getKeywordSyncJob("acme", testClient);

    expect(result).toBeNull();
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "CustomerSupportAgent-KeywordSyncJobs",
          Key: { tenantId: "acme" },
        }),
      }),
    );
  });

  it("returns the job when one exists", async () => {
    const job: KeywordSyncJob = {
      tenantId: "acme",
      status: "running",
      mode: "incremental",
      startedAt: "2026-07-28T20:00:00.000Z",
      finishedAt: null,
      listedObjectCount: 10,
      changedObjectCount: 2,
      unchangedObjectCount: 8,
      deletedObjectCount: 0,
      indexedObjectCount: 1,
      indexedChunkCount: 5,
      skippedObjectCount: 0,
      errorCount: 0,
      errors: [],
      failureMessage: null,
    };
    sendMock.mockResolvedValue({ Item: job });

    const result = await getKeywordSyncJob("acme", testClient);

    expect(result).toEqual(job);
  });
});

describe("putKeywordSyncJob", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
    process.env.DYNAMODB_KEYWORD_SYNC_JOBS_TABLE = "CustomerSupportAgent-KeywordSyncJobs";
  });

  it("writes the full job record", async () => {
    const job: KeywordSyncJob = {
      tenantId: "acme",
      status: "queued",
      mode: "full",
      startedAt: "2026-07-28T20:00:00.000Z",
      finishedAt: null,
      listedObjectCount: 0,
      changedObjectCount: 0,
      unchangedObjectCount: 0,
      deletedObjectCount: 0,
      indexedObjectCount: 0,
      indexedChunkCount: 0,
      skippedObjectCount: 0,
      errorCount: 0,
      errors: [],
      failureMessage: null,
    };

    await putKeywordSyncJob(job, testClient);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "CustomerSupportAgent-KeywordSyncJobs",
          Item: job,
        }),
      }),
    );
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run app/lib/db/keyword-sync-jobs.test.ts`
Expected: FAIL — `Cannot find module './keyword-sync-jobs'`

- [ ] **Step 5: Write the implementation**

```typescript
// app/lib/db/keyword-sync-jobs.ts
import { GetCommand, PutCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ddbDocClient } from "./client";

export type KeywordSyncJob = {
  tenantId: string;
  status: "queued" | "running" | "complete" | "failed";
  mode: "full" | "incremental";
  startedAt: string;
  finishedAt: string | null;
  listedObjectCount: number;
  changedObjectCount: number;
  unchangedObjectCount: number;
  deletedObjectCount: number;
  indexedObjectCount: number;
  indexedChunkCount: number;
  skippedObjectCount: number;
  errorCount: number;
  errors: string[];
  failureMessage: string | null;
};

const TABLE_NAME = () => process.env.DYNAMODB_KEYWORD_SYNC_JOBS_TABLE!;

// `client` is injectable (defaults to the shared BAWS_*-keyed client used
// everywhere else in app/lib/db/) so the worker Lambda - which has its own
// role-based client (see lambda/kb-keyword-sync-worker/db-client.ts) and no
// BAWS_* env vars at all - can reuse this exact query/write logic instead of
// duplicating it.
export async function getKeywordSyncJob(
  tenantId: string,
  client: DynamoDBDocumentClient = ddbDocClient,
): Promise<KeywordSyncJob | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_NAME(),
      Key: { tenantId },
    }),
  );
  return (result.Item as KeywordSyncJob) || null;
}

export async function putKeywordSyncJob(
  job: KeywordSyncJob,
  client: DynamoDBDocumentClient = ddbDocClient,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: TABLE_NAME(),
      Item: job,
    }),
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run app/lib/db/keyword-sync-jobs.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add infra/terraform/kb_keyword_sync.tf app/lib/db/keyword-sync-jobs.ts app/lib/db/keyword-sync-jobs.test.ts
git commit -m "Add KeywordSyncJobs table and client-injectable data-access module"
```

---

### Task 4: Worker Lambda handler

**Files:**
- Create: `lambda/kb-keyword-sync-worker/db-client.ts`
- Create: `lambda/kb-keyword-sync-worker/handler.ts`
- Test: `lambda/kb-keyword-sync-worker/handler.test.ts`
- Create: `lambda/kb-keyword-sync-worker/package.json`
- Create: `lambda/kb-keyword-sync-worker/tsconfig.json`

**Interfaces:**
- Consumes: `reconcileKeywordIndex` from `../../app/lib/kb-keyword-index` (its param object is passed inline, matching `KeywordIndexParams`' shape structurally - no explicit type import needed); `KeywordSyncJob`, `getKeywordSyncJob`, `putKeywordSyncJob` from `../../app/lib/db/keyword-sync-jobs` (Task 3).
- Produces: `export const handler: SQSHandler` — wired to the SQS event source mapping in Task 5.

- [ ] **Step 1: Role-based DynamoDB client for the worker**

```typescript
// lambda/kb-keyword-sync-worker/db-client.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Unlike app/lib/db/client.ts, this never sets explicit credentials - this
// Lambda has its own IAM execution role (see infra/terraform/kb_keyword_sync.tf),
// and the AWS SDK's default credential provider chain discovers it
// automatically from the Lambda runtime environment. No BAWS_* env vars
// exist in this Lambda's environment at all.
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-2",
});

export const workerDbClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
```

- [ ] **Step 2: Write the failing test**

```typescript
// lambda/kb-keyword-sync-worker/handler.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../app/lib/kb-keyword-index", () => ({
  reconcileKeywordIndex: vi.fn(),
}));
vi.mock("../../app/lib/db/keyword-sync-jobs", () => ({
  putKeywordSyncJob: vi.fn(),
}));
vi.mock("./db-client", () => ({ workerDbClient: {} }));

import { reconcileKeywordIndex } from "../../app/lib/kb-keyword-index";
import { putKeywordSyncJob } from "../../app/lib/db/keyword-sync-jobs";
import { handler } from "./handler";

const mockedReconcile = vi.mocked(reconcileKeywordIndex);
const mockedPut = vi.mocked(putKeywordSyncJob);

function sqsEvent(body: Record<string, unknown>) {
  return {
    Records: [{ messageId: "m1", body: JSON.stringify(body) }],
  } as never;
}

function reconcileResult(overrides: Partial<Awaited<ReturnType<typeof reconcileKeywordIndex>>> = {}) {
  return {
    indexBucket: "pooled-bucket",
    indexKey: "index-key",
    mode: "reconcile" as const,
    listedObjectCount: 5,
    changedObjectCount: 2,
    unchangedObjectCount: 3,
    deletedObjectCount: 0,
    indexedObjectCount: 2,
    indexedChunkCount: 10,
    skippedObjectCount: 0,
    errorCount: 0,
    partial: false,
    errors: [],
    listedKeys: [],
    changedKeys: [],
    deletedKeys: [],
    ...overrides,
  };
}

const message = {
  tenantId: "acme",
  knowledgeBaseId: "kb-acme",
  bucketName: "pooled-bucket",
  region: "us-east-2",
  mode: "incremental" as const,
};

describe("kb-keyword-sync-worker handler", () => {
  beforeEach(() => {
    mockedReconcile.mockReset();
    mockedPut.mockReset();
    mockedPut.mockResolvedValue(undefined);
  });

  it("writes a running record, calls reconcileKeywordIndex once when it finishes non-partial, then writes complete", async () => {
    mockedReconcile.mockResolvedValue(reconcileResult({ partial: false }));

    await handler(sqsEvent(message));

    expect(mockedReconcile).toHaveBeenCalledTimes(1);
    expect(mockedReconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "acme",
        knowledgeBaseId: "kb-acme",
        bucketName: "pooled-bucket",
        region: "us-east-2",
      }),
    );

    const statuses = mockedPut.mock.calls.map(([job]) => job.status);
    expect(statuses).toEqual(["running", "complete"]);
    const finalJob = mockedPut.mock.calls[1][0];
    expect(finalJob.indexedObjectCount).toBe(2);
    expect(finalJob.finishedAt).not.toBeNull();
  });

  it("keeps calling reconcileKeywordIndex until partial is false", async () => {
    mockedReconcile
      .mockResolvedValueOnce(reconcileResult({ partial: true, indexedObjectCount: 1 }))
      .mockResolvedValueOnce(reconcileResult({ partial: true, indexedObjectCount: 1 }))
      .mockResolvedValueOnce(reconcileResult({ partial: false, indexedObjectCount: 1 }));

    await handler(sqsEvent(message));

    expect(mockedReconcile).toHaveBeenCalledTimes(3);
    const statuses = mockedPut.mock.calls.map(([job]) => job.status);
    expect(statuses).toEqual(["running", "complete"]);
  });

  it("writes a failed record with the error message when reconcileKeywordIndex throws", async () => {
    mockedReconcile.mockRejectedValue(new Error("S3 GetObject denied"));

    await handler(sqsEvent(message));

    const statuses = mockedPut.mock.calls.map(([job]) => job.status);
    expect(statuses).toEqual(["running", "failed"]);
    const finalJob = mockedPut.mock.calls[1][0];
    expect(finalJob.failureMessage).toBe("S3 GetObject denied");
    expect(finalJob.finishedAt).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd lambda/kb-keyword-sync-worker && npx vitest run handler.test.ts`
Expected: FAIL — `Cannot find module './handler'`

- [ ] **Step 4: Write the implementation**

```typescript
// lambda/kb-keyword-sync-worker/handler.ts
import type { SQSEvent, SQSHandler } from "aws-lambda";
import { reconcileKeywordIndex } from "../../app/lib/kb-keyword-index";
import { putKeywordSyncJob, KeywordSyncJob } from "../../app/lib/db/keyword-sync-jobs";
import { workerDbClient } from "./db-client";

type JobMessage = {
  tenantId: string;
  knowledgeBaseId: string;
  bucketName: string;
  region?: string;
  mode: "full" | "incremental";
};

function emptyJob(message: JobMessage, status: KeywordSyncJob["status"]): KeywordSyncJob {
  return {
    tenantId: message.tenantId,
    status,
    mode: message.mode,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    listedObjectCount: 0,
    changedObjectCount: 0,
    unchangedObjectCount: 0,
    deletedObjectCount: 0,
    indexedObjectCount: 0,
    indexedChunkCount: 0,
    skippedObjectCount: 0,
    errorCount: 0,
    errors: [],
    failureMessage: null,
  };
}

async function processMessage(message: JobMessage): Promise<void> {
  await putKeywordSyncJob(emptyJob(message, "running"), workerDbClient);

  let result;
  try {
    // No timeBudgetMs override: this Lambda's own timeout (10 minutes, see
    // infra/terraform/kb_keyword_sync.tf) is the only ceiling, comfortably
    // above the measured 60-180s worst case for this tenant's current index
    // size - unlike the in-request path this replaces, there's no shared
    // ~28s wall to budget against here.
    do {
      result = await reconcileKeywordIndex({
        tenantId: message.tenantId,
        knowledgeBaseId: message.knowledgeBaseId,
        bucketName: message.bucketName,
        region: message.region,
      });
    } while (result.partial);
  } catch (err) {
    await putKeywordSyncJob(
      {
        ...emptyJob(message, "failed"),
        finishedAt: new Date().toISOString(),
        failureMessage: err instanceof Error ? err.message : String(err),
      },
      workerDbClient,
    );
    return;
  }

  await putKeywordSyncJob(
    {
      tenantId: message.tenantId,
      status: "complete",
      mode: message.mode,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      listedObjectCount: result.listedObjectCount,
      changedObjectCount: result.changedObjectCount,
      unchangedObjectCount: result.unchangedObjectCount,
      deletedObjectCount: result.deletedObjectCount,
      indexedObjectCount: result.indexedObjectCount,
      indexedChunkCount: result.indexedChunkCount,
      skippedObjectCount: result.skippedObjectCount,
      errorCount: result.errorCount,
      errors: result.errors,
      failureMessage: null,
    },
    workerDbClient,
  );
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.body) as JobMessage;
    await processMessage(message);
  }
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd lambda/kb-keyword-sync-worker && npx vitest run handler.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Add the worker's own package.json and tsconfig.json**

```json
// lambda/kb-keyword-sync-worker/package.json
{
  "name": "kb-keyword-sync-worker",
  "private": true,
  "version": "1.0.0",
  "main": "dist/handler.js",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.1093.0",
    "@aws-sdk/lib-dynamodb": "^3.1093.0",
    "@aws-sdk/client-s3": "^3.1094.0",
    "better-sqlite3": "^13.0.1",
    "pdf-parse": "^2.4.5",
    "@thednp/dommatrix": "^3.0.4"
  },
  "devDependencies": {
    "@types/aws-lambda": "^8.10.145",
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^20",
    "typescript": "^5"
  }
}
```

```json
// lambda/kb-keyword-sync-worker/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "dist",
    "rootDir": "../..",
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "strict": true
  },
  "include": ["handler.ts", "db-client.ts", "../../app/lib/kb-keyword-index.ts", "../../app/lib/db/keyword-sync-jobs.ts", "../../app/lib/db/client.ts"]
}
```

Add `@types/aws-lambda` to the root `package.json` devDependencies too, since the worker's own `tsconfig.json` (Step 6 above) is a separate, standalone config, but its editor/IDE experience benefits from the root project knowing the types too:

```bash
npm install --save-dev @types/aws-lambda
```

- [ ] **Step 7: Exclude `lambda/` from the root tsconfig, include it in the root vitest config**

The root `tsconfig.json`'s `include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ...]` has no exclusion for `lambda/`, so a plain `npx tsc --noEmit` from the repo root would try to typecheck the worker's files under the *Next.js* app's compiler options (`moduleResolution: "bundler"`, etc.) instead of the worker's own (`moduleResolution: "node"`, `module: "commonjs"`) - two different configs asserting ownership of the same files. Keep them cleanly separate instead of hoping the settings happen to agree:

In `tsconfig.json` (root), change:
```json
  "exclude": ["node_modules"]
```
to:
```json
  "exclude": ["node_modules", "lambda"]
```

Separately, the root `vitest.config.ts`'s `test.include` (`["app/lib/**/*.test.ts", "app/api/**/*.test.ts", "scripts/**/*.test.ts"]`) doesn't match `lambda/**` either - confirmed directly, not assumed, since this project's root `npx vitest run` is a real command other tasks in this plan already rely on for a "full suite" check. Add the worker's tests to it:
```typescript
    include: ["app/lib/**/*.test.ts", "app/api/**/*.test.ts", "scripts/**/*.test.ts", "lambda/**/*.test.ts"],
```

- [ ] **Step 8: Run the full suite and typecheck, both from the repo root and standalone for the worker**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All pass, including `lambda/kb-keyword-sync-worker/handler.test.ts` now showing up in the root vitest run's output.

Run: `cd lambda/kb-keyword-sync-worker && npx tsc --noEmit -p tsconfig.json`
Expected: passes using the worker's own config (this is the one that actually validates the worker's real deploy-time compiler settings — the root run above only confirms the root app still typechecks cleanly with `lambda/` excluded).

- [ ] **Step 9: Commit**

```bash
git add lambda/ package.json package-lock.json tsconfig.json vitest.config.ts
git commit -m "Add kb-keyword-sync-worker Lambda handler"
```

---

### Task 5: Dockerfile, ECR, IAM role, Lambda function, SQS queue+DLQ

**Files:**
- Create: `lambda/kb-keyword-sync-worker/Dockerfile`
- Modify: `infra/terraform/kb_keyword_sync.tf` (add SQS, ECR, IAM role, Lambda function, event source mapping to the file started in Task 3)

This task is infra-only — no unit tests. Verification is `terraform validate`/`terraform plan` (agent-runnable) plus a local `docker build` (agent-runnable); `terraform apply`, `docker push`, and the actual image build-and-push to ECR are the **user's** steps per the Global Constraints.

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# lambda/kb-keyword-sync-worker/Dockerfile
#
# better-sqlite3 is a native module - building it inside this image (which
# matches the Lambda Node.js 20 runtime's actual OS/architecture) avoids the
# cross-compilation problems this project has hit before with native deps
# (see @napi-rs/canvas's DOMMatrix failures in DEVLOG.md). A zip-based
# deploy would need the native binary cross-compiled for Amazon Linux
# separately from this dev machine's own OS/arch - a container image sidesteps
# that entirely by compiling in the same environment the function runs in.
#
# Build context is the repo root (see the `docker build -f
# lambda/kb-keyword-sync-worker/Dockerfile .` command below) so this can
# COPY both lambda/kb-keyword-sync-worker/ and app/lib/ into the same image.
FROM public.ecr.aws/lambda/nodejs:20 AS build

WORKDIR /build
COPY lambda/kb-keyword-sync-worker/package.json lambda/kb-keyword-sync-worker/
RUN npm install --omit=dev --prefix lambda/kb-keyword-sync-worker
COPY lambda/kb-keyword-sync-worker/tsconfig.json lambda/kb-keyword-sync-worker/handler.ts lambda/kb-keyword-sync-worker/db-client.ts lambda/kb-keyword-sync-worker/
COPY app/lib/kb-keyword-index.ts app/lib/
COPY app/lib/db/keyword-sync-jobs.ts app/lib/db/client.ts app/lib/db/
RUN cd lambda/kb-keyword-sync-worker && npx tsc -p tsconfig.json

# tsc's rootDir ("../..", i.e. the repo root) makes it mirror the full
# source path under dist/ - verified directly (not assumed): compiling this
# exact layout produces dist/lambda/kb-keyword-sync-worker/handler.js and
# dist/app/lib/kb-keyword-index.js as siblings, NOT a flattened dist/handler.js.
# handler.js's compiled `require("../../app/lib/kb-keyword-index")` only
# resolves correctly if that same nesting is preserved in the deployed
# image - so this copies dist/ whole, not flattened, and the Lambda handler
# path below includes the subdirectory.
FROM public.ecr.aws/lambda/nodejs:20
COPY --from=build /build/lambda/kb-keyword-sync-worker/dist ${LAMBDA_TASK_ROOT}
COPY --from=build /build/lambda/kb-keyword-sync-worker/node_modules ${LAMBDA_TASK_ROOT}/node_modules
CMD ["lambda/kb-keyword-sync-worker/handler.handler"]
```

- [ ] **Step 2: Verify the image builds locally**

Run (from the repo root, so the build context includes both `lambda/` and `app/`):
```bash
docker build -f lambda/kb-keyword-sync-worker/Dockerfile -t kb-keyword-sync-worker:local .
```
Expected: build succeeds, ending in a tagged image. If `better-sqlite3`'s native build fails inside the container, check the base image's `node-gyp`/build-essential availability - the AWS base image includes these; a failure here means a real dependency problem to fix before proceeding, not something to route around.

- [ ] **Step 3: Add SQS queue + DLQ, ECR repo, IAM role, Lambda function, and event source mapping to Terraform**

```hcl
# Append to infra/terraform/kb_keyword_sync.tf

resource "aws_sqs_queue" "kb_keyword_sync_dlq" {
  name                      = "kb-keyword-sync-dlq"
  message_retention_seconds = 1209600 # 14 days - max, so a stuck job is inspectable, not lost
}

resource "aws_sqs_queue" "kb_keyword_sync" {
  name                       = "kb-keyword-sync"
  visibility_timeout_seconds = 900 # must exceed the worker Lambda's own 600s timeout with margin, so a still-running invocation is never redelivered as a duplicate
  message_retention_seconds  = 86400

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.kb_keyword_sync_dlq.arn
    maxReceiveCount      = 3
  })
}

resource "aws_ecr_repository" "kb_keyword_sync_worker" {
  name                 = "kb-keyword-sync-worker"
  image_tag_mutability = "MUTABLE"
}

resource "aws_iam_role" "kb_keyword_sync_worker" {
  name = "kb-keyword-sync-worker-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "kb_keyword_sync_worker_basic_execution" {
  role       = aws_iam_role.kb_keyword_sync_worker.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "kb_keyword_sync_worker" {
  name = "kb-keyword-sync-worker-policy"
  role = aws_iam_role.kb_keyword_sync_worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "KeywordIndexS3Access"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
        Resource = [
          aws_s3_bucket.pool_source.arn,
          "${aws_s3_bucket.pool_source.arn}/*",
          "arn:aws:s3:::claude-qkstrt-kb",
          "arn:aws:s3:::claude-qkstrt-kb/*",
          "arn:aws:s3:::css-agent-kb2-materiality-src",
          "arn:aws:s3:::css-agent-kb2-materiality-src/*",
        ]
      },
      {
        Sid      = "KeywordSyncJobsTableAccess"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
        Resource = [aws_dynamodb_table.keyword_sync_jobs.arn]
      },
      {
        Sid    = "ConsumeKeywordSyncQueue"
        Effect = "Allow"
        Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = [aws_sqs_queue.kb_keyword_sync.arn]
      },
    ]
  })
}

resource "aws_lambda_function" "kb_keyword_sync_worker" {
  function_name = "kb-keyword-sync-worker"
  role          = aws_iam_role.kb_keyword_sync_worker.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.kb_keyword_sync_worker.repository_url}:latest"
  timeout       = 600
  memory_size   = 1024

  environment {
    variables = {
      DYNAMODB_KEYWORD_SYNC_JOBS_TABLE = aws_dynamodb_table.keyword_sync_jobs.name
    }
  }

  # The image must already exist in ECR (pushed manually, see Task 9) before
  # this resource can be created - Terraform doesn't build/push images.
  depends_on = [aws_ecr_repository.kb_keyword_sync_worker]
}

resource "aws_lambda_event_source_mapping" "kb_keyword_sync" {
  event_source_arn = aws_sqs_queue.kb_keyword_sync.arn
  function_name    = aws_lambda_function.kb_keyword_sync_worker.arn
  batch_size       = 1 # one tenant's job per invocation - no reason to batch a 60-180s+ operation
}
```

- [ ] **Step 4: Verify**

Run: `cd infra/terraform && terraform validate && terraform fmt -check`
Expected: `Success! The configuration is valid.` and no formatting diffs (run `terraform fmt` to fix if there are)

Run: `terraform plan`
Expected: shows the new resources to add (SQS x2, ECR, IAM role + policy + attachment, Lambda function, event source mapping), zero changes to existing resources. **Do not run `terraform apply`** — that's the user's step (Task 9), and only after the image has actually been pushed to ECR (the Lambda resource references `:latest`, which must exist).

- [ ] **Step 5: Commit**

```bash
git add lambda/kb-keyword-sync-worker/Dockerfile infra/terraform/kb_keyword_sync.tf
git commit -m "Add worker Lambda infra: Dockerfile, SQS queue+DLQ, ECR repo, IAM role, event source mapping"
```

---

### Task 6: Sync route enqueues instead of running reconcile inline

**Files:**
- Modify: `app/api/admin/kb/sync/route.ts`
- Modify: `app/api/admin/kb/sync/route.test.ts`

**Interfaces:**
- Consumes: `sendKeywordSyncJob` (Task 1), `getKeywordSyncJob`/`putKeywordSyncJob` (Task 3).
- Produces: response shape for `keywordIndex` becomes `{ status: "queued" | "running" } | null` instead of the full `KeywordIndexUpdateResult` — Task 8's UI change consumes this.

- [ ] **Step 1: Replace the whole test file**

The route's diff-computation branching (`disableKeywordSearch` deciding `reconcileKeywordIndex` vs `trackTenantObjects`) is gone, `reconcileKeywordIndex`/`resumeKeywordIndexOnly` are gone, and — important, easy to miss — the existing "shared time budget" tests from the prior fix (`2db9489`) mock **`reconcileKeywordIndex`'s** timing to prove `submitVectorSync`'s budget shrinks correctly. That composition now happens between `trackTenantObjects` and `submitVectorSync` instead (reconcile doesn't run in-request at all anymore), so those tests must mock `trackTenantObjects`'s timing, not reconcile's, or they'd be testing a function the route no longer calls. Replace the entire file:

```typescript
// app/api/admin/kb/sync/route.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/app/lib/db/tenants", () => ({
  getTenant: vi.fn(),
}));

vi.mock("@/app/lib/bedrock-kb", () => ({
  getKbDataSource: vi.fn(),
}));

vi.mock("@/app/lib/kb-keyword-index", () => ({
  trackTenantObjects: vi.fn(),
  submitVectorSync: vi.fn(),
  DEFAULT_VECTOR_SYNC_TIME_BUDGET_MS: 15_000,
}));

vi.mock("@/app/lib/kb-sync-queue", () => ({
  sendKeywordSyncJob: vi.fn(),
}));

vi.mock("@/app/lib/db/keyword-sync-jobs", () => ({
  getKeywordSyncJob: vi.fn(),
  putKeywordSyncJob: vi.fn(),
}));

import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import { getKbDataSource } from "@/app/lib/bedrock-kb";
import { trackTenantObjects, submitVectorSync } from "@/app/lib/kb-keyword-index";
import { sendKeywordSyncJob } from "@/app/lib/kb-sync-queue";
import { getKeywordSyncJob, putKeywordSyncJob } from "@/app/lib/db/keyword-sync-jobs";
import { POST } from "./route";

const mockedAuth = vi.mocked(auth);
const mockedGetTenant = vi.mocked(getTenant);
const mockedGetKbDataSource = vi.mocked(getKbDataSource);
const mockedTrackTenantObjects = vi.mocked(trackTenantObjects);
const mockedSubmitVectorSync = vi.mocked(submitVectorSync);
const mockedSendKeywordSyncJob = vi.mocked(sendKeywordSyncJob);
const mockedGetKeywordSyncJob = vi.mocked(getKeywordSyncJob);
const mockedPutKeywordSyncJob = vi.mocked(putKeywordSyncJob);

function makeRequest(body?: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/kb/sync", {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Matches trackTenantObjects's real return type exactly (app/lib/kb-keyword-index.ts)
// - listedObjectCount, listedKeys, changedKeys, deletedKeys, partial. No
// indexBucket/mode/indexedObjectCount/etc. - those are reconcileKeywordIndex-only
// fields and reconcileKeywordIndex doesn't run in this route anymore.
function diffResult(overrides: Partial<{
  listedKeys: string[];
  changedKeys: string[];
  deletedKeys: string[];
  partial: boolean;
}> = {}) {
  return {
    listedObjectCount: 1,
    partial: false,
    listedKeys: ["tenants/acme/a.pdf"],
    changedKeys: ["tenants/acme/a.pdf"],
    deletedKeys: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockedAuth.mockReset();
  mockedGetTenant.mockReset();
  mockedGetKbDataSource.mockReset();
  mockedTrackTenantObjects.mockReset();
  mockedSubmitVectorSync.mockReset();
  mockedSendKeywordSyncJob.mockReset();
  mockedGetKeywordSyncJob.mockReset();
  mockedPutKeywordSyncJob.mockReset();

  mockedAuth.mockResolvedValue({
    user: { role: "admin", tenantId: "acme" },
  } as never);
  mockedGetKbDataSource.mockResolvedValue({
    dataSourceId: "ds-1",
    bucketName: "pooled-bucket",
  } as never);
  mockedTrackTenantObjects.mockResolvedValue(diffResult() as never);
  mockedSubmitVectorSync.mockResolvedValue({
    submittedCount: 1,
    deletedCount: 0,
    documents: [{ key: "tenants/acme/a.pdf", status: "STARTING" }],
    partial: false,
  } as never);
  mockedGetTenant.mockResolvedValue({
    tenantId: "acme",
    knowledgeBaseId: "kb-acme",
    awsRegion: "us-east-2",
    disableKeywordSearch: false,
  } as never);
  mockedSendKeywordSyncJob.mockResolvedValue(undefined);
  mockedGetKeywordSyncJob.mockResolvedValue(null);
  mockedPutKeywordSyncJob.mockResolvedValue(undefined);
});

describe("POST /api/admin/kb/sync", () => {
  it("always calls trackTenantObjects for the vector-sync diff, regardless of disableKeywordSearch", async () => {
    mockedGetTenant.mockResolvedValue({
      tenantId: "acme", knowledgeBaseId: "kb-acme", awsRegion: "us-east-2", disableKeywordSearch: true,
    } as never);

    await POST(makeRequest());

    expect(mockedTrackTenantObjects).toHaveBeenCalledTimes(1);
    expect(mockedSubmitVectorSync).toHaveBeenCalledTimes(1);
  });

  it("passes the diff and mode through to submitVectorSync", async () => {
    mockedTrackTenantObjects.mockResolvedValue(
      diffResult({ listedKeys: ["a", "b"], changedKeys: ["b"] }) as never,
    );

    const res = await POST(makeRequest());
    const data = await res.json();

    expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "incremental",
        usesTrackingFile: true,
        diff: expect.objectContaining({ listedKeys: ["a", "b"], changedKeys: ["b"] }),
      }),
    );
    expect(data.vectorSync.submittedCount).toBe(1);
  });

  it("passes mode: full through when requested", async () => {
    const res = await POST(makeRequest({ mode: "full" }));
    const data = await res.json();

    expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "full" }),
    );
    expect(data.vectorSync).not.toBeNull();
  });

  it("never touches vector sync when trackTenantObjects's diff came back partial", async () => {
    mockedTrackTenantObjects.mockResolvedValue(diffResult({ partial: true }) as never);

    const res = await POST(makeRequest());
    const data = await res.json();

    expect(mockedSubmitVectorSync).not.toHaveBeenCalled();
    expect(data.vectorSync).toBeNull();
  });

  it("resumes vector sync directly, skipping the diff step entirely, on a vector-sync-only resume", async () => {
    const res = await POST(makeRequest({ resumeVectorSyncOnly: true, mode: "full" }));
    const data = await res.json();

    expect(mockedTrackTenantObjects).not.toHaveBeenCalled();
    expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "full" }),
    );
    expect(mockedSubmitVectorSync.mock.calls[0][0]).not.toHaveProperty("diff");
    expect(data.keywordIndex).toBeNull();
    expect(data.vectorSync).not.toBeNull();
  });

  it("rejects unauthenticated requests before touching AWS", async () => {
    mockedAuth.mockResolvedValue(null as never);

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(mockedSubmitVectorSync).not.toHaveBeenCalled();
  });

  describe("keyword-index enqueueing", () => {
    it("enqueues a keyword-sync job when keyword search is enabled and none is already in flight", async () => {
      const res = await POST(makeRequest());
      const data = await res.json();

      expect(mockedSendKeywordSyncJob).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "acme", knowledgeBaseId: "kb-acme" }),
      );
      expect(mockedPutKeywordSyncJob).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "acme", status: "queued" }),
      );
      expect(data.keywordIndex).toEqual({ status: "queued" });
    });

    it("does not enqueue a second job when one is already queued or running", async () => {
      mockedGetKeywordSyncJob.mockResolvedValue({
        tenantId: "acme", status: "running", mode: "incremental", startedAt: "x", finishedAt: null,
        listedObjectCount: 0, changedObjectCount: 0, unchangedObjectCount: 0, deletedObjectCount: 0,
        indexedObjectCount: 0, indexedChunkCount: 0, skippedObjectCount: 0, errorCount: 0, errors: [],
        failureMessage: null,
      } as never);

      const res = await POST(makeRequest());
      const data = await res.json();

      expect(mockedSendKeywordSyncJob).not.toHaveBeenCalled();
      expect(mockedPutKeywordSyncJob).not.toHaveBeenCalled();
      expect(data.keywordIndex).toEqual({ status: "running" });
    });

    it("does not enqueue anything when the tenant has keyword search disabled", async () => {
      mockedGetTenant.mockResolvedValue({
        tenantId: "acme", knowledgeBaseId: "kb-acme", awsRegion: "us-east-2", disableKeywordSearch: true,
      } as never);

      const res = await POST(makeRequest());
      const data = await res.json();

      expect(mockedSendKeywordSyncJob).not.toHaveBeenCalled();
      expect(data.keywordIndex).toBeNull();
    });
  });

  describe("shared time budget between trackTenantObjects and vector sync", () => {
    const originalEnv = process.env.KB_SYNC_TOTAL_BUDGET_MS;

    afterEach(() => {
      vi.restoreAllMocks();
      if (originalEnv === undefined) delete process.env.KB_SYNC_TOTAL_BUDGET_MS;
      else process.env.KB_SYNC_TOTAL_BUDGET_MS = originalEnv;
    });

    it("never gives submitVectorSync more than its own tuned default, even when trackTenantObjects finished instantly", async () => {
      process.env.KB_SYNC_TOTAL_BUDGET_MS = "22000";
      vi.spyOn(Date, "now").mockReturnValue(1_000_000);

      await POST(makeRequest());

      expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
        expect.objectContaining({ timeBudgetMs: 15_000 }),
      );
    });

    it("reduces submitVectorSync's timeBudgetMs by however long trackTenantObjects actually took", async () => {
      process.env.KB_SYNC_TOTAL_BUDGET_MS = "22000";
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      mockedTrackTenantObjects.mockImplementation(async () => {
        now += 9_000;
        return diffResult() as never;
      });

      await POST(makeRequest());

      expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
        expect.objectContaining({ timeBudgetMs: 13_000 }),
      );
    });

    it("clamps submitVectorSync's timeBudgetMs to 0 instead of negative when trackTenantObjects used the whole budget", async () => {
      process.env.KB_SYNC_TOTAL_BUDGET_MS = "22000";
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      mockedTrackTenantObjects.mockImplementation(async () => {
        now += 30_000;
        return diffResult() as never;
      });

      await POST(makeRequest());

      expect(mockedSubmitVectorSync).toHaveBeenCalledWith(
        expect.objectContaining({ timeBudgetMs: 0 }),
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify the new/changed ones fail**

Run: `npx vitest run app/api/admin/kb/sync/route.test.ts`
Expected: FAIL — route still imports `reconcileKeywordIndex` and doesn't call `sendKeywordSyncJob`/`getKeywordSyncJob`/`putKeywordSyncJob` at all yet

- [ ] **Step 3: Rewrite the route**

```typescript
// app/api/admin/kb/sync/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getTenant } from "@/app/lib/db/tenants";
import { getKbDataSource } from "@/app/lib/bedrock-kb";
import { trackTenantObjects, submitVectorSync, DEFAULT_VECTOR_SYNC_TIME_BUDGET_MS } from "@/app/lib/kb-keyword-index";
import { sendKeywordSyncJob } from "@/app/lib/kb-sync-queue";
import { getKeywordSyncJob, putKeywordSyncJob } from "@/app/lib/db/keyword-sync-jobs";

// See docs/superpowers/plans/2026-07-28-async-keyword-index-sync.md - the
// combined-stage budget below governs submitVectorSync only.
// reconcileKeywordIndex no longer runs in this request at all; it's async
// (see lambda/kb-keyword-sync-worker), so it has no time budget to compose
// against anymore.
const DEFAULT_TOTAL_SYNC_BUDGET_MS = 22_000;

const syncRequestSchema = z
  .object({
    mode: z.enum(["full", "incremental"]).optional(),
    resumeVectorSyncOnly: z.boolean().optional(),
  })
  .optional();

async function parseSyncRequest(req: Request) {
  try {
    const bodyText = await req.text();
    return syncRequestSchema.safeParse(bodyText ? JSON.parse(bodyText) : {});
  } catch {
    return syncRequestSchema.safeParse(null);
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = await parseSyncRequest(req);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const mode = parsed.data?.mode ?? "incremental";
  const resumeVectorSyncOnly = parsed.data?.resumeVectorSyncOnly === true;

  const tenant = await getTenant(session.user.tenantId);
  if (!tenant) {
    return Response.json({ error: "Tenant not found" }, { status: 404 });
  }

  const dataSource = await getKbDataSource(tenant.knowledgeBaseId);
  if (!dataSource) {
    return Response.json(
      { error: "Could not resolve this tenant's knowledge base data source" },
      { status: 400 },
    );
  }

  let vectorSync: Awaited<ReturnType<typeof submitVectorSync>> | null = null;
  let vectorSyncError: string | null = null;

  if (resumeVectorSyncOnly) {
    try {
      vectorSync = await submitVectorSync({
        tenantId: tenant.tenantId,
        knowledgeBaseId: tenant.knowledgeBaseId,
        dataSourceId: dataSource.dataSourceId,
        bucketName: dataSource.bucketName,
        region: tenant.awsRegion,
        mode,
        usesTrackingFile: true,
      });
    } catch (err) {
      console.error("Vector sync failed:", err);
      vectorSyncError = err instanceof Error ? err.message : "Vector sync failed";
    }
    return NextResponse.json({ keywordIndex: null, vectorSync, vectorSyncError });
  }

  const requestStartedAt = Date.now();

  // trackTenantObjects runs unconditionally now - it's the cheap, dedicated
  // diff (never touches the large keyword-index file) that drives
  // submitVectorSync, fully decoupled from whether/when the keyword-index
  // itself gets rebuilt. See the design spec's "API changes" section.
  let objectDiff: {
    listedKeys: string[];
    changedKeys: string[];
    deletedKeys: string[];
    partial: boolean;
  } | null = null;
  let keywordIndexError: string | null = null;
  try {
    objectDiff = await trackTenantObjects({
      tenantId: tenant.tenantId,
      knowledgeBaseId: tenant.knowledgeBaseId,
      bucketName: dataSource.bucketName,
      region: tenant.awsRegion,
    });
  } catch (err) {
    console.error("Tenant object tracking failed:", err);
    keywordIndexError = err instanceof Error ? err.message : "Tenant object tracking failed";
  }

  if (objectDiff && !objectDiff.partial) {
    const totalBudgetMs = Number(
      process.env.KB_SYNC_TOTAL_BUDGET_MS || DEFAULT_TOTAL_SYNC_BUDGET_MS,
    );
    const remainingBudgetMs = Math.max(0, totalBudgetMs - (Date.now() - requestStartedAt));
    try {
      vectorSync = await submitVectorSync({
        tenantId: tenant.tenantId,
        knowledgeBaseId: tenant.knowledgeBaseId,
        dataSourceId: dataSource.dataSourceId,
        bucketName: dataSource.bucketName,
        region: tenant.awsRegion,
        mode,
        usesTrackingFile: true,
        diff: objectDiff,
        timeBudgetMs: Math.min(remainingBudgetMs, DEFAULT_VECTOR_SYNC_TIME_BUDGET_MS),
      });
    } catch (err) {
      console.error("Vector sync failed:", err);
      vectorSyncError = err instanceof Error ? err.message : "Vector sync failed";
    }
  }

  let keywordIndex: { status: "queued" | "running" } | null = null;
  if (!tenant.disableKeywordSearch) {
    const existingJob = await getKeywordSyncJob(tenant.tenantId);
    if (existingJob && (existingJob.status === "queued" || existingJob.status === "running")) {
      keywordIndex = { status: existingJob.status };
    } else {
      await putKeywordSyncJob({
        tenantId: tenant.tenantId,
        status: "queued",
        mode,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        listedObjectCount: 0,
        changedObjectCount: 0,
        unchangedObjectCount: 0,
        deletedObjectCount: 0,
        indexedObjectCount: 0,
        indexedChunkCount: 0,
        skippedObjectCount: 0,
        errorCount: 0,
        errors: [],
        failureMessage: null,
      });
      await sendKeywordSyncJob({
        tenantId: tenant.tenantId,
        knowledgeBaseId: tenant.knowledgeBaseId,
        bucketName: dataSource.bucketName,
        region: tenant.awsRegion,
        mode,
      });
      keywordIndex = { status: "queued" };
    }
  }

  return NextResponse.json({ keywordIndex, keywordIndexError, vectorSync, vectorSyncError });
}
```

Note: `usesTrackingFile: true` is now hardcoded (not `Boolean(tenant.disableKeywordSearch)`) since `trackTenantObjects` always produces the diff now — `submitVectorSync` always reads/writes the small dedicated tracking file, never the large keyword-index file, regardless of whether keyword search is enabled.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/api/admin/kb/sync/route.test.ts`
Expected: PASS, all tests

- [ ] **Step 5: Run the full suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npx next lint`
Expected: all clean

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/kb/sync/route.ts app/api/admin/kb/sync/route.test.ts
git commit -m "Enqueue keyword-index sync instead of running it in-request"
```

---

### Task 7: Keyword-sync status route

**Files:**
- Create: `app/api/admin/kb/sync/keyword-status/route.ts`
- Test: `app/api/admin/kb/sync/keyword-status/route.test.ts`

**Interfaces:**
- Consumes: `getKeywordSyncJob` (Task 3).
- Produces: `GET` response `{ job: KeywordSyncJob | null }` — consumed by Task 8's UI polling.

- [ ] **Step 1: Write the failing test**

```typescript
// app/api/admin/kb/sync/keyword-status/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/app/lib/db/keyword-sync-jobs", () => ({ getKeywordSyncJob: vi.fn() }));

import { auth } from "@/auth";
import { getKeywordSyncJob } from "@/app/lib/db/keyword-sync-jobs";
import { GET } from "./route";

const mockedAuth = vi.mocked(auth);
const mockedGetKeywordSyncJob = vi.mocked(getKeywordSyncJob);

beforeEach(() => {
  mockedAuth.mockReset();
  mockedGetKeywordSyncJob.mockReset();
  mockedAuth.mockResolvedValue({ user: { role: "admin", tenantId: "acme" } } as never);
});

describe("GET /api/admin/kb/sync/keyword-status", () => {
  it("returns the tenant's current job", async () => {
    const job = {
      tenantId: "acme", status: "running" as const, mode: "incremental" as const,
      startedAt: "x", finishedAt: null, listedObjectCount: 5, changedObjectCount: 1,
      unchangedObjectCount: 4, deletedObjectCount: 0, indexedObjectCount: 1,
      indexedChunkCount: 3, skippedObjectCount: 0, errorCount: 0, errors: [], failureMessage: null,
    };
    mockedGetKeywordSyncJob.mockResolvedValue(job);

    const res = await GET(new Request("http://localhost/api/admin/kb/sync/keyword-status"));
    const data = await res.json();

    expect(mockedGetKeywordSyncJob).toHaveBeenCalledWith("acme");
    expect(data.job).toEqual(job);
  });

  it("returns null when no job has ever run for the tenant", async () => {
    mockedGetKeywordSyncJob.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/api/admin/kb/sync/keyword-status"));
    const data = await res.json();

    expect(data.job).toBeNull();
  });

  it("rejects unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as never);

    const res = await GET(new Request("http://localhost/api/admin/kb/sync/keyword-status"));

    expect(res.status).toBe(401);
    expect(mockedGetKeywordSyncJob).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/admin/kb/sync/keyword-status/route.test.ts`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Write the implementation**

```typescript
// app/api/admin/kb/sync/keyword-status/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getKeywordSyncJob } from "@/app/lib/db/keyword-sync-jobs";

export async function GET(req: Request) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const job = await getKeywordSyncJob(session.user.tenantId);
  return NextResponse.json({ job });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/api/admin/kb/sync/keyword-status/route.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/kb/sync/keyword-status/
git commit -m "Add keyword-sync job status route"
```

---

### Task 8: UI polling for keyword-sync job status

**Files:**
- Modify: `components/admin/KnowledgeBaseManager.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/kb/sync/keyword-status` (Task 7), new `{ keywordIndex: { status: "queued" | "running" } | null }` shape from `POST /api/admin/kb/sync` (Task 6).

No dedicated test file exists for this component today (confirmed: no `KnowledgeBaseManager.test.tsx` in the repo) — verification for this task is `tsc --noEmit`, `next lint`, `next build`, plus manual browser verification in Task 9.

- [ ] **Step 1: Replace the keyword-index state and types**

Replace:
```typescript
type KeywordIndexStatus = {
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
```
with:
```typescript
type KeywordSyncJob = {
  tenantId: string;
  status: "queued" | "running" | "complete" | "failed";
  mode: SyncMode;
  startedAt: string;
  finishedAt: string | null;
  listedObjectCount: number;
  changedObjectCount: number;
  unchangedObjectCount: number;
  deletedObjectCount: number;
  indexedObjectCount: number;
  indexedChunkCount: number;
  skippedObjectCount: number;
  errorCount: number;
  errors: string[];
  failureMessage: string | null;
};
```

Replace:
```typescript
const [keywordIndex, setKeywordIndex] = useState<KeywordIndexStatus | null>(null);
const [keywordIndexError, setKeywordIndexError] = useState<string | null>(null);
const [isSyncing, setIsSyncing] = useState(false);
const [isKeywordIndexSyncing, setIsKeywordIndexSyncing] = useState(false);
```
with:
```typescript
const [keywordSyncJob, setKeywordSyncJob] = useState<KeywordSyncJob | null>(null);
const [isSyncing, setIsSyncing] = useState(false);
const isPollingKeywordJobRef = useRef(false);
```

- [ ] **Step 2: Replace the resume-chaining `runSync` with an enqueue-then-poll flow**

Replace the entire `runSync` function and its keyword-related resume logic:

```typescript
const KEYWORD_JOB_POLL_INTERVAL_MS = 5000;

async function pollKeywordSyncJob() {
  const res = await fetch("/api/admin/kb/sync/keyword-status");
  if (!res.ok) {
    isPollingKeywordJobRef.current = false;
    return;
  }

  const { job } = (await res.json()) as { job: KeywordSyncJob | null };
  setKeywordSyncJob(job);

  if (job && (job.status === "queued" || job.status === "running")) {
    setTimeout(pollKeywordSyncJob, KEYWORD_JOB_POLL_INTERVAL_MS);
  } else {
    isPollingKeywordJobRef.current = false;
  }
}

function startPollingKeywordSyncJob() {
  if (isPollingKeywordJobRef.current) return;
  isPollingKeywordJobRef.current = true;
  pollKeywordSyncJob();
}

async function runSync(mode: SyncMode) {
  try {
    const res = await fetch("/api/admin/kb/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setSyncError(
        typeof data?.error === "string" ? data.error : "Failed to start sync.",
      );
      return;
    }

    const {
      keywordIndex: newKeywordIndex,
      vectorSync: newVectorSync,
      vectorSyncError: newVectorSyncError,
    } = await res.json();

    setVectorSyncError(newVectorSyncError ?? null);
    if (newVectorSync) {
      trackSubmittedKeys(newVectorSync);
      if (newVectorSync.partial) {
        resumeVectorSync(mode);
      }
    }

    if (newKeywordIndex) {
      startPollingKeywordSyncJob();
    }
  } catch {
    setSyncError("Failed to start sync.");
  }
}
```

Update `handleSync`:
```typescript
async function handleSync(mode: SyncMode) {
  setSyncError(null);
  setVectorSync(null);
  setVectorSyncError(null);
  setKeywordSyncJob(null);
  submittedKeysRef.current = new Set();
  setIsSyncing(true);
  try {
    await runSync(mode);
  } finally {
    setIsSyncing(false);
  }
}
```

Update the `syncing` computed value (remove `isKeywordIndexSyncing`, it no longer exists):
```typescript
const syncing =
  isSyncing || isVectorSyncSubmitting || isVectorSyncPolling || isPollingKeywordJobRef.current;
```

- [ ] **Step 3: Update the render section**

Replace the `keywordIndex`/`keywordIndexError` rendering block (originally around line 426-460) with:

```tsx
{keywordSyncJob && (
  <div className="text-sm text-muted-foreground">
    <p>
      Keyword index: {keywordSyncJob.status}
      {keywordSyncJob.status === "complete" &&
        ` (${keywordSyncJob.indexedObjectCount} indexed, ${keywordSyncJob.indexedChunkCount} chunks, ${keywordSyncJob.unchangedObjectCount} unchanged, ${keywordSyncJob.deletedObjectCount} deleted)`}
      {keywordSyncJob.skippedObjectCount > 0 &&
        `, skipped ${keywordSyncJob.skippedObjectCount}`}
      {keywordSyncJob.errorCount > 0 && `, ${keywordSyncJob.errorCount} errors`}
    </p>
    {keywordSyncJob.status === "complete" && (
      <p>
        Listed {keywordSyncJob.listedObjectCount} supported S3 objects;
        {` ${keywordSyncJob.changedObjectCount} changed or new`}.
      </p>
    )}
    {keywordSyncJob.errors.length > 0 && (
      <ul className="list-disc pl-5">
        {keywordSyncJob.errors.map((error) => (
          <li key={error}>{error}</li>
        ))}
      </ul>
    )}
  </div>
)}
{keywordSyncJob?.status === "failed" && keywordSyncJob.failureMessage && (
  <p className="text-sm text-destructive">
    Keyword index update failed: {keywordSyncJob.failureMessage}
  </p>
)}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx next lint && npx next build`
Expected: all clean. Fix any type errors from the rename (search the file for remaining `keywordIndex`/`keywordIndexError`/`isKeywordIndexSyncing` references and update them).

- [ ] **Step 5: Commit**

```bash
git add components/admin/KnowledgeBaseManager.tsx
git commit -m "Poll async keyword-sync job status instead of resume-chaining reconcile"
```

---

### Task 9: Deploy and live verification

This task has no code changes — it's the deployment sequence and the real-world proof this actually fixes the original bug. Every AWS-mutating step here is explicitly the **user's** to run (per Global Constraints); an agent can prepare commands and verify state (`terraform plan`, `aws ...describe/get/list`, `aws logs`) but should not run `terraform apply`, `docker push`, or `git push` without the user's go-ahead at each step.

- [ ] **Step 1: Bake the new env vars into the app's build**

Add to `amplify.yml`, alongside the existing `echo "..." >> .env.production` lines:
```yaml
        - echo "DYNAMODB_KEYWORD_SYNC_JOBS_TABLE=$DYNAMODB_KEYWORD_SYNC_JOBS_TABLE" >> .env.production
        - echo "KB_KEYWORD_SYNC_QUEUE_URL=$KB_KEYWORD_SYNC_QUEUE_URL" >> .env.production
```
Commit this change.

- [ ] **Step 2: User builds and pushes the worker image to ECR**

```bash
cd infra/terraform && terraform apply -target=aws_ecr_repository.kb_keyword_sync_worker
aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-2.amazonaws.com
docker build -f lambda/kb-keyword-sync-worker/Dockerfile -t kb-keyword-sync-worker:latest .
docker tag kb-keyword-sync-worker:latest <account-id>.dkr.ecr.us-east-2.amazonaws.com/kb-keyword-sync-worker:latest
docker push <account-id>.dkr.ecr.us-east-2.amazonaws.com/kb-keyword-sync-worker:latest
```

- [ ] **Step 3: User applies the rest of the Terraform**

```bash
cd infra/terraform && terraform plan   # review - should show DynamoDB table, SQS x2, IAM role+policy, Lambda function, event source mapping
terraform apply
```

- [ ] **Step 4: User sets the two new env vars on both Amplify apps (production + any preview app in active use) and DYNAMODB_KEYWORD_SYNC_JOBS_TABLE/KB_KEYWORD_SYNC_QUEUE_URL**, then triggers a redeploy (env var saves don't auto-build, per this project's established Amplify behavior).

- [ ] **Step 5: Live verification against the actual broken tenant**

With `OpenAI Default Test Org` (`01KY88W3KWE1WAM444MTX88TXP`) still showing `disableKeywordSearch: false`, click "Sync unindexed docs" in the real admin UI and confirm:
- The click returns quickly (not a 28s hang) — check via browser devtools network tab, request should resolve in well under a second.
- `aws sqs get-queue-attributes --queue-url <queue-url> --attribute-names ApproximateNumberOfMessages` briefly shows 1, then drops to 0 as the worker picks it up.
- CloudWatch (`/aws/lambda/kb-keyword-sync-worker`) shows the invocation running for the expected 60-180s+ range, no errors.
- `aws dynamodb get-item --table-name CustomerSupportAgent-KeywordSyncJobs --key '{"tenantId":{"S":"01KY88W3KWE1WAM444MTX88TXP"}}'` shows `status: complete` with real `indexedObjectCount`/`indexedChunkCount` values once finished.
- The admin UI, left polling, reflects `complete` with matching numbers without the page being manually refreshed.

- [ ] **Step 6: Update DEVLOG.md and BACKLOG.md**

Add a DEVLOG entry documenting: the root cause chain (in-request budget fix → discovered the real 75MB-download problem → this async redesign), what was built, and the live-verification results from Step 5. Remove or update the `BACKLOG.md` entry about the orphaned 75MB file (`OpenAI Default Test Org`'s old keyword-index file), since it's no longer orphaned — it's back in active use via the async worker.
