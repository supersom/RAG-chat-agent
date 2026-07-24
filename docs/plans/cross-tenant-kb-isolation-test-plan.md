# Plan: Real Cross-Tenant Knowledge Base Isolation Test

Status: **planned, not yet executed** — no AWS resources created yet. This doc is meant to seed a follow-up AWS resource provisioning doc and a Terraform package.

## Goal

Every cross-tenant isolation test run so far (see `docs/qa-results-2026-07-23.md`, item 6) used a deliberately-fake KB ID for the second tenant to prove isolation via an expected validation error. This is a stronger version: two *real* Bedrock Knowledge Bases, each seeded with a document that answers the same question with different specific facts, so a chat response itself — not just a log line — proves which tenant's KB actually got queried.

## Topic: materiality threshold determination for audit risk assessment

Chosen because it's simultaneously:
- **Risk assessment** — materiality is the first quantitative judgment call in audit planning; it scopes what counts as a risk.
- **Trial-balance analysis** — the materiality threshold is exactly what determines which account variances get flagged for investigation vs. ignored.
- **Workpaper drafting** — the materiality memo (how the threshold was set, and why) is itself a standard, required workpaper.

Both documents will answer "how is the materiality threshold set" with **different specific numbers**, so a single chat query cleanly reveals which KB answered:

- **Doc 1** (→ existing KB `SLXQFWWXPR`): overall materiality = 5% of pre-tax income; performance materiality = 75% of overall; clearly trivial threshold = 5% of overall materiality.
- **Doc 2** (→ new KB): overall materiality = 1% of total assets; performance materiality = 60% of overall; clearly trivial threshold = 3% of overall materiality.

## Existing KB (reference, not touched)

| Field | Value |
|---|---|
| Knowledge Base ID | `SLXQFWWXPR` |
| Name | `knowledge-base-quick-start-zjdw5` |
| Storage type | `S3_VECTORS` (not OpenSearch Serverless) |
| Vector index ARN | `arn:aws:s3vectors:us-east-2:764988411032:bucket/bedrock-knowledge-base-tmuwcw/index/bedrock-knowledge-base-default-index` |
| Execution role | `AmazonBedrockExecutionRoleForKnowledgeBase_zjdw5` (policies scoped to this KB's own resources only — not reusable as-is) |
| Data source | `HELPS6AVPT`, type `S3`, bucket `arn:aws:s3:::claude-qkstrt-kb` |
| Embedding model | `amazon.titan-embed-text-v2:0` (FLOAT32) |

## New KB resource plan

Mirrors the existing KB's architecture (S3 Vectors, not OpenSearch Serverless) for cost and consistency reasons — see below.

1. New S3 bucket for the new KB's source document(s).
2. New S3 Vectors bucket + index (the vector store itself — distinct `s3vectors` service API, not a regular S3 bucket).
3. New dedicated IAM execution role, least-privilege, scoped only to this new KB's own resources:
   - Bedrock foundation model invoke (embedding model)
   - S3 Vectors access (new vector bucket/index only)
   - S3 read access (new source bucket only)
4. `bedrock-agent create-knowledge-base` — vector KB configuration referencing the embedding model + the new S3 Vectors index.
5. `bedrock-agent create-data-source` pointing at the new S3 source bucket.
6. Upload Doc 1 into the *existing* bucket (`claude-qkstrt-kb`) and start an ingestion job on the existing KB's data source.
7. Upload Doc 2 into the *new* bucket and start an ingestion job on the new KB's data source.

## Tenant assignment

- Tenant 1 → `knowledgeBaseId: SLXQFWWXPR` (existing)
- Tenant 2 → `knowledgeBaseId: <new-kb-id>` (created above)

## Cost note

The existing KB's storage type is **S3 Vectors** — pay-per-use (storage + query volume), not a standing charge. Explicitly *not* using **OpenSearch Serverless** for the new KB, which has a persistent minimum cost (~$700+/month even at the smallest OCU configuration) regardless of usage. Matching the existing architecture keeps the new KB's cost in the cents-per-test range instead.

## Open items for the follow-up provisioning doc / Terraform package

- Exact `s3vectors` CLI/API command names and required parameters (bucket + index creation) — not yet verified against current CLI version.
- Exact IAM policy JSON for the new execution role (can largely mirror `AmazonBedrockS3VectorStorePolicyForKnowledgeBase_zjdw5` / `AmazonBedrockS3PolicyForKnowledgeBase_zjdw5` / `AmazonBedrockFoundationModelPolicyForKnowledgeBase_zjdw5`, re-scoped to new resource ARNs).
- Embedding model for the new KB: match the existing KB's `amazon.titan-embed-text-v2:0` (FLOAT32) for apples-to-apples retrieval behavior.
- Ingestion job polling/wait pattern (Bedrock ingestion is asynchronous).
