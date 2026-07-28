# Async keyword-index sync (SQS + Lambda worker)

**Date:** 2026-07-28
**Branch:** `main`
**Target:** production (`d23lox37qr16rj`, `kbsearch.somdutta.com`) and its preview apps

## Problem

`reconcileKeywordIndex` (`app/lib/kb-keyword-index.ts`) downloads a tenant's
entire keyword-index SQLite file from S3, does time-budgeted incremental work
against it, then re-uploads the whole file — every sync round, regardless of
how small the actual diff is. For `OpenAI Default Test Org`
(`01KY88W3KWE1WAM444MTX88TXP`, ~1,994 files), that file is 75MB. Measured
directly (both via a live Lambda diagnostic on 2026-07-27 and a direct CLI
download today): downloading it alone takes 30-90s, and re-uploading it costs
roughly the same. That's 60-180s of unavoidable, unbudgetable I/O against
Amplify Compute's hard ~28-30s request wall — a wall that sits in front of
the Lambda, not a configurable Lambda timeout, so no amount of in-request
budget tuning can fix it. A prior in-request time-budget fix
(2026-07-28, `2db9489`) reduced a *different* risk (the sum of
`reconcileKeywordIndex` + `submitVectorSync`'s own per-call budgets) but did
not touch this — the failure recurred identically post-deploy, tracing back
to this same file, previously diagnosed and only half-fixed
(`trackTenantObjects` was rerouted to a small dedicated file on 2026-07-28;
`reconcileKeywordIndex` never was, because it genuinely needs the full FTS
content, not just a lightweight diff).

The fix has to remove `reconcileKeywordIndex` from the request/response cycle
entirely, since even a no-op round already costs 3-6x the available window.

## Scope (explicitly decided, 2026-07-28)

- **Minimal for the current scale (2 tenants), not designed for the 10K-tenant
  plan** (`~/.claude/plans/shimmying-toasting-squid.md`) — that plan is a
  separate, later initiative; revisit this design if/when it's implemented,
  since requirements may shift by then anyway.
- **Only `reconcileKeywordIndex` moves async.** `submitVectorSync` keeps its
  existing in-request checkpointing unchanged — it isn't actually broken,
  just independently budgeted (see `2db9489`).
- **UI polls for status**, matching the feel of today's multi-round resume
  flow, just backed by a background job instead of chained HTTP requests.
- **Trigger mechanism: SQS + a dedicated Lambda worker** (not direct async
  Lambda invoke) — explicit user choice, trading a bit more infra for an
  inspectable queue (depth, DLQ) rather than relying on Lambda's opaque
  built-in async-invoke retry queue.

## Architecture

```
Admin clicks "Sync" (keyword search enabled)
  → POST /api/admin/kb/sync
      → writes a KeywordSyncJobs record: { tenantId, status: "queued" }
      → sends one SQS message { tenantId, knowledgeBaseId, bucketName, region, mode }
      → returns immediately: { keywordIndex: { status: "queued" } }

kb-keyword-sync-queue (SQS)
  → triggers kb-keyword-sync-worker (Lambda, own execution role, 10 min timeout)
      → sets KeywordSyncJobs record to "running"
      → loops: call reconcileKeywordIndex(...) until it reports partial: false
        (no per-call time budget override needed - the worker's own 10 min
        timeout is the only ceiling, comfortably above the measured 60-180s
        worst case for this tenant's current index size)
      → on success: writes "complete" + the final KeywordIndexUpdateResult
        fields (indexedObjectCount, errors, etc.) to the job record
      → on unrecoverable error: writes "failed" + the error message;
        SQS's own redelivery (visibility timeout) retries transient
        failures automatically before this is reached; a DLQ catches
        messages that exhaust retries so a stuck job is visible in
        CloudWatch/SQS console rather than silently vanishing

Admin UI polls GET /api/admin/kb/sync/keyword-status
  → reads the KeywordSyncJobs record, returns current status to the client
  → KnowledgeBaseManager.tsx polls this every few seconds after triggering
    a keyword sync, same pattern already used for vector-sync resume polling
```

`submitVectorSync` is untouched, but what feeds it changes: today the route
gets its diff from whichever of `reconcileKeywordIndex`/`trackTenantObjects`
it happened to call. Once `reconcileKeywordIndex` is async, its diff isn't
available in-request anymore. Resolution: the route **always** calls
`trackTenantObjects` for the diff that drives `submitVectorSync` —
regardless of `disableKeywordSearch` — since that function was already built
specifically to be a cheap, fast S3 diff decoupled from the large FTS file
(`app/lib/kb-keyword-index.ts`, added 2026-07-28 for exactly this
"large-file avoidance" reason). Keyword-index building and vector-sync's
diff become two fully independent concerns that happen to run from the same
click: `trackTenantObjects` → `submitVectorSync`, synchronous, in-request,
unchanged in spirit from today; `reconcileKeywordIndex` → the async queue,
touching the FTS content only, on its own schedule. This removes the
`if (!tenant.disableKeywordSearch) { reconcile } else { trackTenantObjects }`
branch from the route entirely — `trackTenantObjects` runs unconditionally,
`reconcileKeywordIndex` gets enqueued conditionally alongside it.

## New DynamoDB table: `KeywordSyncJobs`

Partition key `tenantId` (one in-flight job per tenant at a time - a second
"Sync" click while one is already queued/running should be a no-op or a
clear "already syncing" response, not a second concurrent job against the
same SQLite file).

```
tenantId: string (PK)
status: "queued" | "running" | "complete" | "failed"
mode: "full" | "incremental"
startedAt: string (ISO)
finishedAt: string | null
listedObjectCount, changedObjectCount, deletedObjectCount,
  indexedObjectCount, indexedChunkCount, skippedObjectCount: number
errorCount: number
errors: string[]        // capped/truncated, mirrors reconcileKeywordIndex's own cap
failureMessage: string | null   // set only when status === "failed"
```

This mirrors `KeywordIndexUpdateResult`'s existing shape closely on purpose
— the status endpoint's response can stay structurally close to what
`KnowledgeBaseManager.tsx` already renders for a synchronous
`keywordIndex` result, minimizing UI-side changes.

## API changes

**`POST /api/admin/kb/sync`** (`app/api/admin/kb/sync/route.ts`):
- `trackTenantObjects` now runs unconditionally (not just when
  `disableKeywordSearch`) to produce the diff `submitVectorSync` needs.
- When `!tenant.disableKeywordSearch` and not a resume-only request:
  additionally check `KeywordSyncJobs` for an existing `queued`/`running`
  record for this tenant (return that status, don't double-enqueue);
  otherwise write a fresh `queued` record, send the SQS message, and include
  `{ keywordIndex: { status: "queued" } }` in the response alongside
  whatever `submitVectorSync` returns.
- `submitVectorSync` keeps running synchronously as it does today, fed by
  `trackTenantObjects`'s diff.
- The `resumeKeywordIndexOnly` request shape goes away (nothing to resume
  in-request anymore — resumption is now the worker's own internal loop).
  `resumeVectorSyncOnly` is untouched.

**New `GET /api/admin/kb/sync/keyword-status`**: reads and returns the
tenant's `KeywordSyncJobs` record. Mirrors the existing
`POST /api/admin/kb/sync/status` route (added 2026-07-28 for vector-sync
status) in shape/auth, though this one has no key-list body to worry about
since it's keyed by tenant, not by submitted document keys.

## Worker Lambda

New standalone Lambda (`kb-keyword-sync-worker`), **not** part of the Next.js
Amplify Compute build — deployed via Terraform, packaged as its own bundle.
Handler wraps `reconcileKeywordIndex` (imported directly from
`app/lib/kb-keyword-index.ts` — no logic duplication) in a loop:

```ts
let result;
do {
  result = await reconcileKeywordIndex({ tenantId, knowledgeBaseId, bucketName, region });
  // update KeywordSyncJobs with intermediate progress here (optional for v1;
  // "running" for the whole duration is an acceptable first cut)
} while (result.partial);
```

**IAM: a dedicated execution role, not the shared `claude-qkstart-bedrock`
IAM user's static keys.** The app's existing code path
(`s3Client()` in `kb-keyword-index.ts`) always constructs an explicit
`credentials: {...}` object, falling back to `BAWS_ACCESS_KEY_ID`/
`BAWS_SECRET_ACCESS_KEY` env vars — that's a static-key pattern needed
because Amplify Compute doesn't expose a usable execution role for the app's
own AWS calls today. A real Lambda function doesn't have that constraint: it
gets short-lived credentials from its execution role automatically. This
needs one small compatibility fix — `s3Client()` (and any other AWS client
construction reused by the worker) must **omit** the `credentials` field
entirely when neither an explicit override nor `BAWS_*` env vars are present,
so the AWS SDK's default credential provider chain (which already knows how
to discover a Lambda execution role) takes over. Scope this role to exactly
what `reconcileKeywordIndex` needs: S3 `GetObject`/`PutObject`/`ListBucket`
on the pool + legacy KB source buckets, nothing else.

## Terraform additions

New file, e.g. `infra/terraform/kb_keyword_sync.tf`:
- `aws_sqs_queue.kb_keyword_sync` + `aws_sqs_queue.kb_keyword_sync_dlq`
  (redrive policy pointing at the DLQ after N failed receives)
- `aws_lambda_function.kb_keyword_sync_worker` (timeout 600s, memory sized
  to comfortably hold a 75MB+ SQLite file in memory — 1024MB minimum,
  matching the existing Amplify Compute Lambda's own sizing)
- `aws_lambda_event_source_mapping` wiring the queue to the worker
- `aws_iam_role.kb_keyword_sync_worker` + a scoped policy (S3 access as
  above, plus `dynamodb:GetItem`/`PutItem`/`UpdateItem` on the new
  `KeywordSyncJobs` table, plus `sqs:ReceiveMessage`/`DeleteMessage`/
  `GetQueueAttributes` on the queue - the standard trio Lambda's SQS
  event-source mapping needs)
- `aws_dynamodb_table.keyword_sync_jobs`

**Packaging/deploy is the one genuinely new wrinkle** for this repo — there's
currently no pipeline for deploying a standalone Lambda (Amplify Hosting only
builds/deploys the Next.js app itself). Needs a build step that bundles
`app/lib/kb-keyword-index.ts` + a thin handler into a zip Terraform can
reference (`archive_file` data source, or a pre-built artifact checked into
CI). This should get nailed down concretely in the implementation plan, not
guessed at here.

## Testing approach

- Worker's internal loop logic (call-until-`partial:false`) — unit-testable
  in isolation with a mocked `reconcileKeywordIndex`, same mocking style
  already used in `route.test.ts`.
- `POST /api/admin/kb/sync`'s new enqueue behavior — unit test asserting it
  writes a `queued` job record and sends exactly one SQS message, doesn't
  call `reconcileKeywordIndex` directly anymore, and doesn't double-enqueue
  if a job is already `queued`/`running`.
- New status route — unit test against a mocked DynamoDB record, same style
  as the existing `sync/status/route.test.ts`.
- Real AWS integration (SQS delivery, Lambda execution, DynamoDB writes) —
  live-verified against the actual broken tenant post-deploy, same as every
  other fix in this project's history; not mockable in a way that would
  actually prove the fix.

## Open questions for the implementation plan

- Exact SQS visibility timeout / max-receive-count before DLQ (should exceed
  the worker's own 10-minute timeout with margin, so a still-running
  invocation is never redelivered as a duplicate).
- Whether `KeywordSyncJobs` needs a TTL (stale `queued` records if a message
  is ever lost) or that's over-engineering for 2 tenants.
- Concrete Lambda packaging/build step (zip via `archive_file`, or a
  pre-built artifact from CI) — flagged above as the one genuinely new piece
  of deploy tooling this repo doesn't have yet.
