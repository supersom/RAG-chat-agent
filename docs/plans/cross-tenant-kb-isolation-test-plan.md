# Plan: Cross-Tenant Knowledge Base Isolation Test

Status: **ready for QA execution** — the pooled KB architecture and mandatory metadata filter isolation mechanism are implemented. This doc describes the test scenario and manual QA steps to verify isolation.

## Goal

Cross-tenant isolation now relies on a mandatory `tenantId` metadata filter enforced on every Bedrock `retrieveContext` call (see `app/lib/rag.ts` line 102), not on structural separation into different KBs per tenant. Two tenants (A and B) share a single pooled Bedrock Knowledge Base; documents from each tenant are tagged with their `tenantId` in metadata and namespaced under `tenants/{tenantId}/` in S3. The test verifies that the filter works correctly: querying as tenant A returns only chunks tagged with A's `tenantId`, even when B has documents in the same KB with closely matching content that would otherwise be retrieved by semantic similarity alone.

## Test scenario

**Topic:** Materiality threshold determination for audit risk assessment — specifically, how the materiality threshold is set for audit planning.

Two documents in the pooled KB, one per tenant:

- **Tenant A document** (under `tenants/A/`, tagged with `tenantId: A`): overall materiality = 5% of pre-tax income; performance materiality = 75% of overall; clearly trivial threshold = 5% of overall materiality.
- **Tenant B document** (under `tenants/B/`, tagged with `tenantId: B`): overall materiality = 1% of total assets; performance materiality = 60% of overall; clearly trivial threshold = 3% of overall materiality.

Both documents answer the same topic but with **different specific numbers**, so the response text clearly reveals which tenant's KB content was actually retrieved.

## KB architecture

A single pooled Bedrock Knowledge Base (e.g., `SLXQFWWXPR`) with a shared S3 data source bucket (`claude-qkstrt-kb`). Every chunk uploaded goes through the upload flow in `app/api/admin/kb/upload-url/route.ts`, which:

1. Namespaces the object key under `tenants/{tenantId}/{filename}`.
2. Writes a `.metadata.json` sidecar file with `{ tenantId: "<tenant-id>" }` so Bedrock attaches the `tenantId` metadata to every indexed chunk.

The embedding model is `amazon.titan-embed-text-v2:0` (FLOAT32), unchanged from the existing KB.

## Manual QA test

### Setup

1. Seed the pooled KB with the two test documents, one per tenant (A and B).
2. Trigger Bedrock ingestion on both new objects so chunks are indexed and tagged with their respective `tenantId` metadata.
3. Verify chunk indexing completed successfully in Bedrock console or CloudWatch logs.

### Test execution

Run two concurrent chat requests, ~19ms apart (matching the pattern from the 2026-07-23 manual QA session), as shown in `docs/qa-results-2026-07-23.md` item 6:

1. Send query "How is the materiality threshold set?" as tenant A.
2. Send the identical query as tenant B, ~19ms after the first.
3. Observe both responses.

### Pass criteria

- **Tenant A's response** must include the specific numbers from the A document (5% pre-tax income, 75% performance materiality, 5% trivial) and must **not** include any numbers from the B document (1% total assets, 60% performance materiality, 3% trivial).
- **Tenant B's response** must include the specific numbers from the B document and must **not** include any numbers from the A document.
- **No S3 URIs under `tenants/B/`** must ever appear in tenant A's RAG sources (check the `ragSources` array's `s3Uri` field in the response). Conversely, no S3 URIs under `tenants/A/` must appear in tenant B's RAG sources. This holds even if semantic similarity alone would otherwise favor cross-tenant chunks — the mandatory filter in `retrieveContext` gates all retrieval at the Bedrock API level.
- **Zero cross-contamination under concurrent load**: both requests complete without interference; request timing (19ms apart) does not degrade isolation or cause either request's credentials or context to leak into the other.

## Implementation details

### Isolation mechanism

`retrieveContext` (app/lib/rag.ts:65–169) is passed a `tenantId` parameter on every call and unconditionally adds the filter:

```typescript
filter: { equals: { key: "tenantId", value: tenantId } }
```

This filter is passed to Bedrock's `RetrieveCommand` on every request, regardless of KB ID or tenant configuration. Bedrock itself enforces the filter at the vector search stage — only chunks matching the tenant's `tenantId` metadata are candidates for retrieval.

### Upload/metadata flow

- **`app/api/admin/kb/upload-url/route.ts`** generates presigned URLs with keys namespaced as `tenants/{tenantId}/{sanitizedFilename}`.
- **Metadata sidecar** (`.metadata.json`) in the same namespace includes `{ tenantId: "<tenant-id>" }`.
- **Bedrock data source ingestion** reads both the document and its sidecar, attaching the `tenantId` metadata to every indexed chunk.

## Backlog notes

- This is a planned test, not yet executed live. Test data (documents A and B) are ready in the shared knowledge-base bucket.
- The test assumes both tenant documents have been successfully indexed in the pooled KB. If indexing fails or is incomplete, chunks with the intended metadata may not be present for retrieval — verify ingestion job status before running the test.
- Future enhancement: automate this test via a dedicated integration test that provisions test documents, runs concurrent queries, and validates source URIs programmatically rather than as a manual QA step.
