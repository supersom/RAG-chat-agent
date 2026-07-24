# Terraform provider capability research (2026-07-24)

Provider actually installed by `terraform init` under the `~> 5.60` constraint:
`hashicorp/aws v5.100.0`. All findings below are from that exact version's
schema (`terraform providers schema -json`), not from external docs.

## Bedrock Knowledge Base storage_configuration

`aws_bedrockagent_knowledge_base` is present. Its `storage_configuration` block
schema (from `terraform providers schema -json`) is:

```json
{
  "nesting_mode": "list",
  "block": {
    "attributes": {
      "type": {
        "type": "string",
        "description_kind": "plain",
        "required": true
      }
    },
    "block_types": {
      "opensearch_serverless_configuration": { "...": "collection_arn, vector_index_name, field_mapping" },
      "pinecone_configuration": { "...": "connection_string, credentials_secret_arn, namespace, field_mapping" },
      "rds_configuration": { "...": "credentials_secret_arn, database_name, resource_arn, table_name, field_mapping" },
      "redis_enterprise_cloud_configuration": { "...": "credentials_secret_arn, endpoint, vector_index_name, field_mapping" }
    }
  }
}
```

(Full untruncated JSON was inspected directly; the four `block_types` keys above
are the complete and only set present -- nested attribute details are summarized
here for brevity but every field was reviewed.)

There is **no `s3_vectors_configuration`** (or any block containing `s3vectors`/`s3_vectors`
in its name) among `storage_configuration`'s `block_types`. Only four backends are
supported by this resource as of v5.100.0: `OPENSEARCH_SERVERLESS`, `PINECONE`,
`RDS`, and `REDIS_ENTERPRISE_CLOUD` (inferred from the four configuration block
names present; `type` itself is a plain string attribute with no enum exposed in
the JSON schema, but the only matching nested config blocks are these four).
**`S3_VECTORS` is not a supported storage type** in this provider version.

## S3 Vectors bucket/index resources

Search of all `resource_schemas` keys in the `hashicorp/aws` v5.100.0 provider
for anything matching `s3vectors` or `s3_vectors` (case-insensitive) returned:

```
s3vectors-related resources: []
```

No `aws_s3vectors_*` resources of any kind (vector bucket, vector index, or
otherwise) exist in this provider version. This is stated plainly: the
resource type does not exist at all as of v5.100.0.

## Decision

**No native support.** Task 6 uses `null_resource` + `local-exec` provisioners
wrapping the exact `aws bedrock-agent create-knowledge-base` /
`aws s3vectors create-vector-bucket` / `create-index` CLI calls, with
`triggers` keyed on the resource's defining arguments so a change to those
arguments forces recreation. This is a documented fallback, not a workaround
being hidden -- it must also be called out in `infra/terraform/README.md` when
that file is created.

Rationale: the pinned provider (and the latest available version satisfying
`~> 5.60`, which resolved to 5.100.0) has zero schema surface for S3 Vectors --
neither as a `aws_bedrockagent_knowledge_base` storage type nor as standalone
`aws_s3vectors_*` resources. Since the existing Bedrock Knowledge Bases in this
account use S3 Vectors as their storage backend (per the task's stated
constraint), native HCL resources cannot represent them. Re-check this
decision if the provider is later upgraded past 5.100.0, since AWS added
S3 Vectors support to the CLI/SDKs relatively recently and Terraform provider
coverage may follow.
