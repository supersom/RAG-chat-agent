# Terraform Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Represent every piece of live AWS infrastructure this app depends on (DynamoDB tables, IAM policies, the Bedrock Guardrail, two Bedrock Knowledge Bases with their S3/S3-Vectors backing stores, and the preview Amplify app) as Terraform under `infra/terraform`, importing all existing resources rather than recreating them, so future infra changes go through `terraform plan`/`apply` instead of ad-hoc AWS CLI calls.

**Architecture:** One root module wiring together per-concern `.tf` files (`dynamodb.tf`, `iam.tf`, `s3.tf`, `bedrock_guardrail.tf`, `amplify.tf`), plus one reusable child module (`modules/bedrock_knowledge_base`) that captures the KB-creation recipe (S3 source bucket, S3 Vectors bucket+index, dedicated IAM execution role, KB, data source) used twice already this session — instantiated once per existing KB, and reusable for any future KB with a single module block. Every existing resource is adopted via `terraform import` in the task that declares it, verified with `terraform plan` showing zero diff before moving on.

**Tech Stack:** Terraform >= 1.7, `hashicorp/aws` provider pinned to `~> 5.60` (Task 1 confirms whether this line needs adjusting based on its S3 Vectors support research -- the version constraint itself is set in Step 1, only the *approach* for Bedrock KB resources depends on the research outcome), AWS account `764988411032`, region `us-east-2`.

## Global Constraints

- Never hardcode secrets (`BAWS_ACCESS_KEY_ID`, `BAWS_SECRET_ACCESS_KEY`, `AUTH_SECRET`, `TENANT_JWT_SECRET`, `ANTHROPIC_API_KEY`, GitHub PAT for Amplify) in any `.tf` file. All such values are Terraform variables with `sensitive = true`, sourced from a `terraform.tfvars` file that is `.gitignore`'d — never committed.
- Production Amplify app (`RAG-chat-agent`, `d23lox37qr16rj`, `kbsearch.somdutta.com`) is explicitly **out of scope** for this plan. It predates this work, was Console-created with a materially different build spec, and importing it risks an accidental disruptive `terraform apply` against a live production service for no real benefit right now. Only the preview app (`customer-support-agent-auth-preview2`, `d2l47euepvccx6`) is managed.
- Every task that declares a pre-existing resource must `terraform import` it and confirm `terraform plan` shows no changes before the task is considered done — a plan showing a diff against real infra means the HCL doesn't actually match reality and must be fixed before moving on.
- All resource names/IDs below are the actual current values in the account as of 2026-07-24, captured directly via AWS CLI immediately before writing this plan — not guessed.

---

### Task 1: Scaffolding, provider pinning, and Bedrock/S3-Vectors Terraform support research

**Files:**
- Create: `infra/terraform/versions.tf`
- Create: `infra/terraform/providers.tf`
- Create: `infra/terraform/variables.tf`
- Create: `infra/terraform/.gitignore`
- Create: `infra/terraform/terraform.tfvars.example`
- Create: `infra/terraform/RESEARCH.md`

**Interfaces:**
- Produces: `var.aws_region`, `var.aws_account_id`, `var.baws_access_key_id` / `var.baws_secret_access_key` (sensitive, unused directly by Terraform but documented as the values that must exist in the deployed app's own env — Terraform doesn't manage app runtime secrets, only infra), used by every later task's provider block implicitly via the shared provider config.

S3 Vectors (the storage backend for both existing Bedrock Knowledge Bases) is a very new AWS service. Before writing any KB-related HCL in later tasks, confirm whether the pinned `hashicorp/aws` provider version actually supports `aws_bedrockagent_knowledge_base` with an S3 Vectors storage configuration, and whether any provider exposes `aws_s3vectors_*` resources at all. This determines whether Task 6 uses native resources or a documented CLI-based fallback.

- [ ] **Step 1: Create the Terraform directory and version/provider pinning**

```hcl
# infra/terraform/versions.tf
terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}
```

```hcl
# infra/terraform/providers.tf
provider "aws" {
  region = var.aws_region
}
```

```hcl
# infra/terraform/variables.tf
variable "aws_region" {
  description = "AWS region all resources are deployed in"
  type        = string
  default     = "us-east-2"
}

variable "aws_account_id" {
  description = "AWS account ID that owns all resources in this plan"
  type        = string
  default     = "764988411032"
}

variable "baws_access_key_id" {
  description = "Existing AWS access key ID the app uses at runtime (BAWS_ACCESS_KEY_ID). Not created by Terraform -- documented here only so its origin is traceable."
  type        = string
  sensitive   = true
}

variable "baws_secret_access_key" {
  description = "Existing AWS secret access key the app uses at runtime (BAWS_SECRET_ACCESS_KEY)."
  type        = string
  sensitive   = true
}

variable "github_access_token" {
  description = "GitHub PAT with repo-contents-read + webhook read/write scope, used only when creating a NEW Amplify app via aws_amplify_app. Not needed for importing the existing preview app."
  type        = string
  sensitive   = true
  default     = ""
}
```

```gitignore
# infra/terraform/.gitignore
*.tfstate
*.tfstate.*
.terraform/
.terraform.lock.hcl
terraform.tfvars
```

```hcl
# infra/terraform/terraform.tfvars.example
# Copy to terraform.tfvars (gitignored) and fill in real values.
# Never commit terraform.tfvars.

aws_region             = "us-east-2"
aws_account_id         = "764988411032"
baws_access_key_id     = "REPLACE_ME"
baws_secret_access_key = "REPLACE_ME"
github_access_token    = "REPLACE_ME"
```

- [ ] **Step 2: Run `terraform init` and confirm it succeeds**

```bash
cd infra/terraform
terraform init
```

Expected: `Terraform has been successfully initialized!` with `hashicorp/aws` downloaded at a `5.6x` version.

- [ ] **Step 3: Research S3 Vectors / Bedrock KB storage-type support in the pinned provider version**

Check the downloaded provider's schema directly rather than trusting external docs, since this is new enough to vary by exact version:

```bash
terraform providers schema -json | python3 -c "
import json, sys
schema = json.load(sys.stdin)
aws = schema['provider_schemas']['registry.terraform.io/hashicorp/aws']
kb = aws['resource_schemas'].get('aws_bedrockagent_knowledge_base')
print('aws_bedrockagent_knowledge_base present:', kb is not None)
if kb:
    sc = kb['block']['block_types'].get('storage_configuration')
    print(json.dumps(sc, indent=2) if sc else 'no storage_configuration block found')
s3v = [k for k in aws['resource_schemas'] if 's3vectors' in k.lower() or 's3_vectors' in k.lower()]
print('s3vectors-related resources:', s3v)
"
```

Record the findings in `infra/terraform/RESEARCH.md`:

```markdown
# Terraform provider capability research (2026-07-24)

## Bedrock Knowledge Base storage_configuration
[Paste the actual `storage_configuration` schema output here. State plainly whether
`S3_VECTORS` / `s3_vectors_configuration` is a supported `type`/nested block, or whether
only `OPENSEARCH_SERVERLESS` / `PINECONE` / `RDS` are supported as of this provider version.]

## S3 Vectors bucket/index resources
[List any `aws_s3vectors_*` resources found. If none exist, state that plainly.]

## Decision
[One of:]
- Native support confirmed: Task 6 uses `aws_bedrockagent_knowledge_base` +
  `aws_s3vectors_vector_bucket`/`aws_s3vectors_index` (or whatever the actual
  resource names turned out to be) directly.
- No native support: Task 6 uses `null_resource` + `local-exec` provisioners
  wrapping the exact `aws bedrock-agent create-knowledge-base` / `aws s3vectors
  create-vector-bucket` / `create-index` CLI calls already proven to work this
  session, with `triggers` keyed on the resource's defining arguments so a
  change to those arguments forces recreation. This is a documented fallback,
  not a workaround being hidden -- call it out in infra/terraform/README.md too.
```

- [ ] **Step 4: Commit scaffolding**

```bash
git add infra/terraform/versions.tf infra/terraform/providers.tf infra/terraform/variables.tf infra/terraform/.gitignore infra/terraform/terraform.tfvars.example infra/terraform/RESEARCH.md
git commit -m "Scaffold Terraform infra directory, pin provider, research Bedrock KB S3 Vectors support"
```

---

### Task 2: DynamoDB tables

**Files:**
- Create: `infra/terraform/dynamodb.tf`

**Interfaces:**
- Produces: `aws_dynamodb_table.tenants`, `aws_dynamodb_table.users` — referenced by Task 3's IAM policy resource ARNs (`aws_dynamodb_table.tenants.arn`, `aws_dynamodb_table.users.arn`, and the GSI ARN pattern).

Current real config, captured via `aws dynamodb describe-table` immediately before writing this plan:
- `CustomerSupportAgent-Tenants`: partition key `tenantId` (S), `PAY_PER_REQUEST`, no GSIs.
- `CustomerSupportAgent-Users`: partition key `userId` (S), `PAY_PER_REQUEST`, two GSIs: `email-index` (PK `email` S, SK `tenantId` S, full projection) and `tenantId-index` (PK `tenantId` S, full projection).

- [ ] **Step 1: Write the table resources**

```hcl
# infra/terraform/dynamodb.tf
resource "aws_dynamodb_table" "tenants" {
  name         = "CustomerSupportAgent-Tenants"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tenantId"

  attribute {
    name = "tenantId"
    type = "S"
  }
}

resource "aws_dynamodb_table" "users" {
  name         = "CustomerSupportAgent-Users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "email"
    type = "S"
  }

  attribute {
    name = "tenantId"
    type = "S"
  }

  global_secondary_index {
    name            = "email-index"
    hash_key        = "email"
    range_key       = "tenantId"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "tenantId-index"
    hash_key        = "tenantId"
    projection_type = "ALL"
  }
}
```

- [ ] **Step 2: Import both existing tables**

```bash
cd infra/terraform
terraform import aws_dynamodb_table.tenants CustomerSupportAgent-Tenants
terraform import aws_dynamodb_table.users CustomerSupportAgent-Users
```

Expected: both print `Import successful!`.

- [ ] **Step 3: Verify zero diff**

```bash
terraform plan
```

Expected: `No changes. Your infrastructure matches the configuration.` If it shows a diff (e.g. on `billing_mode` or an attribute), fix the HCL to match the real table exactly -- do not let `apply` silently modify a live table to match a wrong plan.

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/dynamodb.tf
git commit -m "Import existing DynamoDB tables into Terraform"
```

---

### Task 3: IAM policies on the existing service user

**Files:**
- Create: `infra/terraform/iam.tf`

**Interfaces:**
- Consumes: `aws_dynamodb_table.tenants.arn`, `aws_dynamodb_table.users.arn` (Task 2); `aws_s3_bucket.kb1_source.arn`, `aws_s3_bucket.kb2_source.arn` (Task 5, referenced by ARN string literals here since Task 3 runs before Task 5 -- see note in Step 1).
- Produces: nothing consumed by later tasks directly; this task only adopts existing policies into state.

The service user `claude-qkstart-bedrock` already exists and is **not created by Terraform** -- it's referenced via a data source, read-only. Its four inline policies are imported so future changes to them go through Terraform. `AmazonBedrockFullAccess` is an AWS-managed policy attachment, also imported.

- [ ] **Step 1: Write the IAM resources**

Note: this task references the KB source bucket names as string literals (`claude-qkstrt-kb`, `css-agent-kb2-materiality-src`) rather than a Task 5 resource reference, since IAM and S3 have no ordering dependency in AWS itself and it avoids a forward-reference across tasks. Task 5 will use the identical literal names, and both will resolve to the same real buckets.

```hcl
# infra/terraform/iam.tf
data "aws_iam_user" "service_user" {
  user_name = "claude-qkstart-bedrock"
}

resource "aws_iam_user_policy" "dynamodb_tenants_users" {
  name = "DynamoDBTenantsUsersAccess"
  user = data.aws_iam_user.service_user.user_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:DescribeTable",
        ]
        Resource = [
          aws_dynamodb_table.tenants.arn,
          aws_dynamodb_table.users.arn,
          "${aws_dynamodb_table.users.arn}/index/*",
        ]
      },
    ]
  })
}

resource "aws_iam_user_policy" "kb_source_bucket_upload" {
  name = "KBSourceBucketUploadAccess"
  user = data.aws_iam_user.service_user.user_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "KBSourceBucketUpload"
        Effect = "Allow"
        Action = ["s3:PutObject"]
        Resource = [
          "arn:aws:s3:::claude-qkstrt-kb/*",
          "arn:aws:s3:::css-agent-kb2-materiality-src/*",
        ]
      },
    ]
  })
}

resource "aws_iam_user_policy" "cloudwatch_logs_read" {
  name   = "CloudWatchLogsReadAccess"
  user   = data.aws_iam_user.service_user.user_name
  policy = data.aws_iam_policy_document.cloudwatch_logs_read_existing.json
}

resource "aws_iam_user_policy" "read_amplify_cloudwatch_logs" {
  name   = "read-amplify-cloudwatch-logs"
  user   = data.aws_iam_user.service_user.user_name
  policy = data.aws_iam_policy_document.read_amplify_cloudwatch_logs_existing.json
}

resource "aws_iam_user_policy_attachment" "bedrock_full_access" {
  user       = data.aws_iam_user.service_user.user_name
  policy_arn = "arn:aws:iam::aws:policy/AmazonBedrockFullAccess"
}
```

- [ ] **Step 2: Fetch the two existing policies whose exact JSON isn't yet in this plan**

`CloudWatchLogsReadAccess` and `read-amplify-cloudwatch-logs` predate this session's work and their exact statements weren't captured earlier. Fetch them directly instead of guessing:

```bash
aws iam get-user-policy --user-name claude-qkstart-bedrock --policy-name CloudWatchLogsReadAccess --query PolicyDocument --output json > /tmp/cw-logs-read.json
aws iam get-user-policy --user-name claude-qkstart-bedrock --policy-name read-amplify-cloudwatch-logs --query PolicyDocument --output json > /tmp/read-amplify-cw-logs.json
```

Convert each into an `aws_iam_policy_document` data source in `iam.tf` (replace the two placeholder data source names referenced in Step 1) by transcribing the actual `Statement` entries from the fetched JSON -- e.g. if `CloudWatchLogsReadAccess` turns out to be:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["logs:GetLogEvents", "logs:DescribeLogStreams", "logs:FilterLogEvents"], "Resource": "arn:aws:logs:us-east-2:764988411032:log-group:*"}
  ]
}
```

then the corresponding block is:

```hcl
data "aws_iam_policy_document" "cloudwatch_logs_read_existing" {
  statement {
    effect    = "Allow"
    actions   = ["logs:GetLogEvents", "logs:DescribeLogStreams", "logs:FilterLogEvents"]
    resources = ["arn:aws:logs:us-east-2:764988411032:log-group:*"]
  }
}
```

Do the same for `read-amplify-cloudwatch-logs` using its actual fetched statements -- do not invent the actions/resources, transcribe exactly what step 2's fetch returned.

- [ ] **Step 3: Import all five policy resources**

```bash
cd infra/terraform
terraform import aws_iam_user_policy.dynamodb_tenants_users claude-qkstart-bedrock:DynamoDBTenantsUsersAccess
terraform import aws_iam_user_policy.kb_source_bucket_upload claude-qkstart-bedrock:KBSourceBucketUploadAccess
terraform import aws_iam_user_policy.cloudwatch_logs_read claude-qkstart-bedrock:CloudWatchLogsReadAccess
terraform import aws_iam_user_policy.read_amplify_cloudwatch_logs claude-qkstart-bedrock:read-amplify-cloudwatch-logs
terraform import aws_iam_user_policy_attachment.bedrock_full_access claude-qkstart-bedrock/arn:aws:iam::aws:policy/AmazonBedrockFullAccess
```

- [ ] **Step 4: Verify zero diff**

```bash
terraform plan
```

Expected: `No changes.` If `dynamodb_tenants_users` or `kb_source_bucket_upload` show a diff, the JSON in Step 1 doesn't exactly match what's live (e.g. key ordering inside `Resource` arrays can cause Terraform to see a semantic-only difference that AWS itself doesn't -- if that's the only diff, it's safe to `apply` since IAM policy statement order/array order isn't semantically meaningful, but confirm this is genuinely the only difference before applying).

- [ ] **Step 5: Commit**

```bash
git add infra/terraform/iam.tf
git commit -m "Import existing IAM user policies into Terraform"
```

---

### Task 4: Bedrock Guardrail

**Files:**
- Create: `infra/terraform/bedrock_guardrail.tf`

**Interfaces:**
- Produces: `aws_bedrock_guardrail.default` -- not consumed by any other Terraform resource (the app references it by ID/version via tenant records in DynamoDB, not via Terraform), but its `id`/`version` are output in Task 8 for documentation.

Current real config, captured via `aws bedrock get-guardrail` immediately before writing this plan: guardrail ID `fvsirf90zt71`, version `1`, name `customer-support-agent-default`, content policy filters VIOLENCE/PROMPT_ATTACK/MISCONDUCT/HATE/SEXUAL/INSULTS all at `MEDIUM` strength (PROMPT_ATTACK output strength `NONE`), tier `CLASSIC`.

- [ ] **Step 1: Write the guardrail resource**

```hcl
# infra/terraform/bedrock_guardrail.tf
resource "aws_bedrock_guardrail" "default" {
  name                      = "customer-support-agent-default"
  blocked_input_messaging   = "Sorry, I can't help with that request."
  blocked_outputs_messaging = "Sorry, I can't help with that request."

  content_policy_config {
    filters_config {
      type            = "VIOLENCE"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
    filters_config {
      type            = "PROMPT_ATTACK"
      input_strength  = "MEDIUM"
      output_strength = "NONE"
    }
    filters_config {
      type            = "MISCONDUCT"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
    filters_config {
      type            = "HATE"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
    filters_config {
      type            = "SEXUAL"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
    filters_config {
      type            = "INSULTS"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
  }
}

resource "aws_bedrock_guardrail_version" "v1" {
  guardrail_arn = aws_bedrock_guardrail.default.guardrail_arn
  description   = "Published version 1 -- imported from existing infra"
}
```

Note: confirm the exact `blocked_input_messaging`/`blocked_outputs_messaging` values match the live guardrail before import (fetch via `aws bedrock get-guardrail --query '{blockedInputMessaging:blockedInputMessaging,blockedOutputsMessaging:blockedOutputsMessaging}'`) -- the values above are the ones observed when this guardrail was actually triggered during QA testing (`"Sorry, I can't help with that request."`), not assumed.

- [ ] **Step 2: Import the existing guardrail and its published version**

```bash
cd infra/terraform
terraform import aws_bedrock_guardrail.default fvsirf90zt71
terraform import aws_bedrock_guardrail_version.v1 fvsirf90zt71:1
```

- [ ] **Step 3: Verify zero diff**

```bash
terraform plan
```

Expected: `No changes.` Content policy filter order in the diff shouldn't matter (Terraform treats `filters_config` blocks as a set keyed by `type`), but if any filter's strength doesn't match, fix the HCL rather than applying.

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/bedrock_guardrail.tf
git commit -m "Import existing Bedrock Guardrail into Terraform"
```

---

### Task 5: S3 source buckets and CORS

**Files:**
- Create: `infra/terraform/s3.tf`

**Interfaces:**
- Produces: `aws_s3_bucket.kb1_source`, `aws_s3_bucket.kb2_source` -- consumed by Task 6's module instantiation (bucket name/ARN passed in as module inputs).

Both buckets already exist: `claude-qkstrt-kb` (KB1's source, holds ~2000 legacy documents plus the materiality test doc) and `css-agent-kb2-materiality-src` (KB2's source, one document). Both currently have a CORS rule allowing `PUT` from the preview Amplify app's origin, added this session to support the admin KB-upload feature.

- [ ] **Step 1: Write the bucket + CORS resources**

```hcl
# infra/terraform/s3.tf
resource "aws_s3_bucket" "kb1_source" {
  bucket = "claude-qkstrt-kb"
}

resource "aws_s3_bucket" "kb2_source" {
  bucket = "css-agent-kb2-materiality-src"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "kb2_source" {
  bucket = aws_s3_bucket.kb2_source.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "kb2_source" {
  bucket                  = aws_s3_bucket.kb2_source.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

locals {
  kb_upload_cors_origin = "https://worktree-auth-multitenancy-guardrails.d2l47euepvccx6.amplifyapp.com"
}

resource "aws_s3_bucket_cors_configuration" "kb1_source" {
  bucket = aws_s3_bucket.kb1_source.id

  cors_rule {
    allowed_origins = [local.kb_upload_cors_origin]
    allowed_methods = ["PUT"]
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_cors_configuration" "kb2_source" {
  bucket = aws_s3_bucket.kb2_source.id

  cors_rule {
    allowed_origins = [local.kb_upload_cors_origin]
    allowed_methods = ["PUT"]
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}
```

Note: `claude-qkstrt-kb` predates this session and its encryption/public-access-block settings weren't captured -- Step 2 fetches and reconciles them before import, rather than guessing.

- [ ] **Step 2: Check kb1_source's actual encryption and public-access-block settings**

```bash
aws s3api get-bucket-encryption --bucket claude-qkstrt-kb --output json
aws s3api get-public-access-block --bucket claude-qkstrt-kb --output json
```

If either differs from `kb2_source`'s config (AES256 encryption, all four public-access-block flags `true`), add matching `aws_s3_bucket_server_side_encryption_configuration.kb1_source` / `aws_s3_bucket_public_access_block.kb1_source` resources to `s3.tf` reflecting what's actually configured -- do not assume it matches `kb2_source` just because that's what this session created.

- [ ] **Step 3: Import both buckets and their CORS configs**

```bash
cd infra/terraform
terraform import aws_s3_bucket.kb1_source claude-qkstrt-kb
terraform import aws_s3_bucket.kb2_source css-agent-kb2-materiality-src
terraform import aws_s3_bucket_cors_configuration.kb1_source claude-qkstrt-kb
terraform import aws_s3_bucket_cors_configuration.kb2_source css-agent-kb2-materiality-src
terraform import aws_s3_bucket_public_access_block.kb2_source css-agent-kb2-materiality-src
terraform import aws_s3_bucket_server_side_encryption_configuration.kb2_source css-agent-kb2-materiality-src
```

- [ ] **Step 4: Verify zero diff**

```bash
terraform plan
```

Expected: `No changes.` Fix any drift in the HCL before proceeding -- in particular, `claude-qkstrt-kb` likely has other objects/lifecycle settings Terraform doesn't need to manage; as long as `terraform plan` doesn't show a diff on the attributes actually declared, that's fine (Terraform only manages what's declared, it won't touch undeclared bucket contents).

- [ ] **Step 5: Commit**

```bash
git add infra/terraform/s3.tf
git commit -m "Import existing KB source S3 buckets and CORS config into Terraform"
```

---

### Task 6: Reusable Bedrock Knowledge Base module, instantiated for both existing KBs

**Files:**
- Create: `infra/terraform/modules/bedrock_knowledge_base/variables.tf`
- Create: `infra/terraform/modules/bedrock_knowledge_base/main.tf`
- Create: `infra/terraform/modules/bedrock_knowledge_base/outputs.tf`
- Create: `infra/terraform/bedrock_kb.tf`

**Interfaces:**
- Consumes: `aws_s3_bucket.kb1_source` / `aws_s3_bucket.kb2_source` (Task 5), `var.baws_access_key_id`/`var.baws_secret_access_key` are NOT needed here (the KB execution role uses its own dedicated IAM role, not the app's runtime credentials).
- Produces: `module.kb1.knowledge_base_id`, `module.kb2.knowledge_base_id` -- these are the exact values that must match each tenant's `knowledgeBaseId` field in DynamoDB (not managed by Terraform, but documented in Task 8's README so the connection is explicit).

This module encodes the exact recipe used twice already this session: an S3 Vectors bucket + index, a dedicated least-privilege IAM execution role (three inline policies: foundation-model invoke, S3 Vectors read/write, S3 source bucket read), the KB itself, and its data source. Whether it uses native Terraform resources or the `null_resource`/CLI fallback depends entirely on Task 1's `RESEARCH.md` finding -- **do not start this task until Task 1's research is complete and its decision is recorded.**

- [ ] **Step 1: Write the module's variables**

```hcl
# infra/terraform/modules/bedrock_knowledge_base/variables.tf
variable "name_prefix" {
  description = "Prefix used for all resource names this module creates (vector bucket, index, IAM role, KB)"
  type        = string
}

variable "source_bucket_name" {
  description = "Name of the existing S3 bucket holding this KB's source documents"
  type        = string
}

variable "source_bucket_arn" {
  description = "ARN of the existing S3 bucket holding this KB's source documents"
  type        = string
}

variable "embedding_model_arn" {
  description = "Bedrock foundation model ARN used for embeddings"
  type        = string
  default     = "arn:aws:bedrock:us-east-2::foundation-model/amazon.titan-embed-text-v2:0"
}

variable "vector_dimension" {
  description = "Embedding vector dimension -- 1024 for amazon.titan-embed-text-v2:0"
  type        = number
  default     = 1024
}

variable "aws_region" {
  type = string
}

variable "aws_account_id" {
  type = string
}

variable "vector_bucket_name_override" {
  description = "Use this exact vector bucket name instead of '${name_prefix}-vectors'. Needed when importing a KB whose vector bucket predates this module's naming convention (e.g. KB1's real bucket is 'bedrock-knowledge-base-tmuwcw', not '<name_prefix>-vectors')."
  type        = string
  default     = null
}

variable "vector_index_name_override" {
  description = "Use this exact vector index name instead of '${name_prefix}-index'. Same rationale as vector_bucket_name_override."
  type        = string
  default     = null
}

locals {
  vector_bucket_name = coalesce(var.vector_bucket_name_override, "${var.name_prefix}-vectors")
  vector_index_name  = coalesce(var.vector_index_name_override, "${var.name_prefix}-index")
}
```

- [ ] **Step 2: Write the module body, branch A (if Task 1 found native S3 Vectors support)**

```hcl
# infra/terraform/modules/bedrock_knowledge_base/main.tf
# NATIVE-RESOURCE VERSION -- use this branch only if RESEARCH.md confirmed
# the provider supports aws_bedrockagent_knowledge_base with an S3 Vectors
# storage_configuration, and real aws_s3vectors_* resources exist. Replace
# the resource type names below with whatever RESEARCH.md's schema dump
# actually showed -- these are illustrative, not confirmed.

resource "aws_s3vectors_vector_bucket" "this" {
  vector_bucket_name = local.vector_bucket_name

  encryption_configuration {
    sse_type = "AES256"
  }
}

resource "aws_s3vectors_index" "this" {
  vector_bucket_name = aws_s3vectors_vector_bucket.this.vector_bucket_name
  index_name         = local.vector_index_name
  data_type          = "float32"
  dimension          = var.vector_dimension
  distance_metric    = "euclidean"

  metadata_configuration {
    non_filterable_metadata_keys = ["AMAZON_BEDROCK_TEXT", "AMAZON_BEDROCK_METADATA"]
  }
}

data "aws_iam_policy_document" "kb_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["bedrock.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:bedrock:${var.aws_region}:${var.aws_account_id}:knowledge-base/*"]
    }
  }
}

resource "aws_iam_role" "kb_execution" {
  name               = "AmazonBedrockExecutionRoleForKnowledgeBase_${var.name_prefix}"
  assume_role_policy = data.aws_iam_policy_document.kb_trust.json
}

resource "aws_iam_role_policy" "foundation_model" {
  name = "AmazonBedrockFoundationModelPolicyForKnowledgeBase_${var.name_prefix}"
  role = aws_iam_role.kb_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "BedrockInvokeModelStatement"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = [var.embedding_model_arn]
      },
      {
        Sid    = "MarketplaceOperationsFromBedrockFor3pModels"
        Effect = "Allow"
        Action = ["aws-marketplace:Subscribe", "aws-marketplace:ViewSubscriptions", "aws-marketplace:Unsubscribe"]
        Resource = "*"
        Condition = {
          StringEquals = { "aws:CalledViaLast" = "bedrock.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "s3_vectors" {
  name = "AmazonBedrockS3VectorStorePolicyForKnowledgeBase_${var.name_prefix}"
  role = aws_iam_role.kb_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "S3VectorsPermissions"
        Effect   = "Allow"
        Action   = ["s3vectors:GetIndex", "s3vectors:QueryVectors", "s3vectors:PutVectors", "s3vectors:GetVectors", "s3vectors:DeleteVectors"]
        Resource = aws_s3vectors_index.this.index_arn
        Condition = {
          StringEquals = { "aws:ResourceAccount" = var.aws_account_id }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "s3_source" {
  name = "AmazonBedrockS3PolicyForKnowledgeBase_${var.name_prefix}"
  role = aws_iam_role.kb_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "S3ListBucketStatement"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [var.source_bucket_arn]
        Condition = {
          StringEquals = { "aws:ResourceAccount" = [var.aws_account_id] }
        }
      },
      {
        Sid      = "S3GetObjectStatement"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = ["${var.source_bucket_arn}/*"]
        Condition = {
          StringEquals = { "aws:ResourceAccount" = [var.aws_account_id] }
        }
      },
    ]
  })
}

resource "aws_bedrockagent_knowledge_base" "this" {
  name     = var.name_prefix
  role_arn = aws_iam_role.kb_execution.arn

  knowledge_base_configuration {
    type = "VECTOR"
    vector_knowledge_base_configuration {
      embedding_model_arn = var.embedding_model_arn
    }
  }

  storage_configuration {
    type = "S3_VECTORS"
    s3_vectors_configuration {
      index_arn = aws_s3vectors_index.this.index_arn
    }
  }
}

resource "aws_bedrockagent_data_source" "this" {
  knowledge_base_id = aws_bedrockagent_knowledge_base.this.id
  name              = "${var.name_prefix}-source"

  data_source_configuration {
    type = "S3"
    s3_configuration {
      bucket_arn = var.source_bucket_arn
    }
  }
}
```

- [ ] **Step 3: Write the module body, branch B (if Task 1 found no native support) -- use this instead of Step 2 if RESEARCH.md's decision says so**

```hcl
# infra/terraform/modules/bedrock_knowledge_base/main.tf
# CLI-FALLBACK VERSION -- use this branch if RESEARCH.md found no native
# Terraform support for S3 Vectors / Bedrock KB storage_configuration.
# The IAM role/policies (aws_iam_role, aws_iam_role_policy x3) are IDENTICAL
# to Step 2 above -- copy that portion verbatim into this file, then replace
# only the vector bucket/index/KB/data-source resources with the null_resource
# blocks below.

resource "null_resource" "vector_bucket" {
  triggers = {
    bucket_name = local.vector_bucket_name
  }

  provisioner "local-exec" {
    command = "aws s3vectors create-vector-bucket --vector-bucket-name ${local.vector_bucket_name} --encryption-configuration sseType=AES256 --region ${var.aws_region}"
  }

  provisioner "local-exec" {
    when    = destroy
    command = "aws s3vectors delete-vector-bucket --vector-bucket-name ${self.triggers.bucket_name} --region ${var.aws_region}"
  }
}

resource "null_resource" "vector_index" {
  depends_on = [null_resource.vector_bucket]

  triggers = {
    bucket_name = local.vector_bucket_name
    index_name  = local.vector_index_name
    dimension   = tostring(var.vector_dimension)
  }

  provisioner "local-exec" {
    command = <<-EOT
      aws s3vectors create-index \
        --vector-bucket-name ${local.vector_bucket_name} \
        --index-name ${local.vector_index_name} \
        --data-type float32 \
        --dimension ${var.vector_dimension} \
        --distance-metric euclidean \
        --metadata-configuration '{"nonFilterableMetadataKeys":["AMAZON_BEDROCK_TEXT","AMAZON_BEDROCK_METADATA"]}' \
        --region ${var.aws_region}
    EOT
  }

  provisioner "local-exec" {
    when    = destroy
    command = "aws s3vectors delete-index --vector-bucket-name ${self.triggers.bucket_name} --index-name ${self.triggers.index_name} --region ${var.aws_region}"
  }
}

data "external" "vector_index_arn" {
  depends_on = [null_resource.vector_index]
  program = ["bash", "-c", <<-EOT
    ARN=$(aws s3vectors get-index --vector-bucket-name ${local.vector_bucket_name} --index-name ${local.vector_index_name} --region ${var.aws_region} --query 'index.indexArn' --output text)
    echo "{\"index_arn\": \"$ARN\"}"
  EOT
  ]
}

# ... aws_iam_role.kb_execution and its three aws_iam_role_policy resources
# go here, identical to Step 2, with s3_vectors's policy Resource referencing
# data.external.vector_index_arn.result.index_arn instead of
# aws_s3vectors_index.this.index_arn.

resource "null_resource" "knowledge_base" {
  depends_on = [aws_iam_role_policy.s3_vectors, aws_iam_role_policy.s3_source, aws_iam_role_policy.foundation_model]

  triggers = {
    name                = var.name_prefix
    role_arn            = aws_iam_role.kb_execution.arn
    embedding_model_arn  = var.embedding_model_arn
    index_arn            = data.external.vector_index_arn.result.index_arn
  }

  provisioner "local-exec" {
    command = <<-EOT
      aws bedrock-agent create-knowledge-base \
        --name "${var.name_prefix}" \
        --role-arn "${aws_iam_role.kb_execution.arn}" \
        --knowledge-base-configuration '{"type":"VECTOR","vectorKnowledgeBaseConfiguration":{"embeddingModelArn":"${var.embedding_model_arn}","embeddingModelConfiguration":{"bedrockEmbeddingModelConfiguration":{"embeddingDataType":"FLOAT32"}}}}' \
        --storage-configuration '{"type":"S3_VECTORS","s3VectorsConfiguration":{"indexArn":"${data.external.vector_index_arn.result.index_arn}"}}' \
        --region ${var.aws_region} \
        --query 'knowledgeBase.knowledgeBaseId' --output text > $${TMPDIR:-/tmp}/${var.name_prefix}-kb-id.txt
    EOT
  }
}

data "external" "kb_id" {
  depends_on = [null_resource.knowledge_base]
  program = ["bash", "-c", "echo \"{\\\"id\\\": \\\"$(cat $${TMPDIR:-/tmp}/${var.name_prefix}-kb-id.txt)\\\"}\""]
}

resource "null_resource" "data_source" {
  depends_on = [null_resource.knowledge_base]

  triggers = {
    knowledge_base_id = data.external.kb_id.result.id
    bucket_arn        = var.source_bucket_arn
  }

  provisioner "local-exec" {
    command = <<-EOT
      aws bedrock-agent create-data-source \
        --knowledge-base-id ${data.external.kb_id.result.id} \
        --name "${var.name_prefix}-source" \
        --data-source-configuration '{"type":"S3","s3Configuration":{"bucketArn":"${var.source_bucket_arn}"}}' \
        --region ${var.aws_region}
    EOT
  }
}
```

- [ ] **Step 4: Write the module outputs**

```hcl
# infra/terraform/modules/bedrock_knowledge_base/outputs.tf
# If Step 2 (native) was used:
output "knowledge_base_id" {
  value = aws_bedrockagent_knowledge_base.this.id
}

# If Step 3 (fallback) was used instead, replace the above with:
# output "knowledge_base_id" {
#   value = data.external.kb_id.result.id
# }
```

- [ ] **Step 5: Instantiate the module for both existing KBs**

```hcl
# infra/terraform/bedrock_kb.tf
module "kb1" {
  source = "./modules/bedrock_knowledge_base"

  name_prefix                 = "knowledge-base-quick-start-zjdw5"
  source_bucket_name          = aws_s3_bucket.kb1_source.id
  source_bucket_arn           = aws_s3_bucket.kb1_source.arn
  aws_region                  = var.aws_region
  aws_account_id              = var.aws_account_id
  vector_bucket_name_override = "bedrock-knowledge-base-tmuwcw"
  vector_index_name_override  = "bedrock-knowledge-base-default-index"
}

module "kb2" {
  source = "./modules/bedrock_knowledge_base"

  name_prefix        = "customer-support-agent-kb2-materiality"
  source_bucket_name = aws_s3_bucket.kb2_source.id
  source_bucket_arn  = aws_s3_bucket.kb2_source.arn
  aws_region         = var.aws_region
  aws_account_id     = var.aws_account_id
}
```

Note: `kb1`'s `name_prefix` is set to the KB's actual existing name (`knowledge-base-quick-start-zjdw5`) rather than a fresh name, since this is an import of pre-existing resources whose real names must match exactly for `terraform import` to succeed -- the module's `${var.name_prefix}-vectors`/`${var.name_prefix}-index` naming convention won't match KB1's actual existing vector bucket (`bedrock-knowledge-base-tmuwcw`) or index (`bedrock-knowledge-base-default-index`), so KB1's module instantiation will need explicit overrides for those two names. Add `vector_bucket_name_override` and `vector_index_name_override` optional variables to the module (default `null`, falling back to the `${var.name_prefix}-*` convention when unset) so KB1 can pass its real historical names while KB2 (created fresh this session and already matching the convention) doesn't need to.

- [ ] **Step 6: Import both existing KBs' resources**

Run for KB1 (existing, `SLXQFWWXPR`, using its real names from Task 5's earlier bash inventory) and KB2 (`YYPQ95NN4G`) -- exact import addresses depend on which branch (Step 2 or 3) was used:

```bash
cd infra/terraform

# If native resources (Step 2):
terraform import module.kb1.aws_bedrockagent_knowledge_base.this SLXQFWWXPR
terraform import module.kb1.aws_bedrockagent_data_source.this SLXQFWWXPR/HELPS6AVPT
terraform import module.kb1.aws_iam_role.kb_execution AmazonBedrockExecutionRoleForKnowledgeBase_zjdw5
terraform import module.kb2.aws_bedrockagent_knowledge_base.this YYPQ95NN4G
terraform import module.kb2.aws_bedrockagent_data_source.this YYPQ95NN4G/ZIPGESZYKQ
terraform import module.kb2.aws_iam_role.kb_execution AmazonBedrockExecutionRoleForKnowledgeBase_kb2mat

# If CLI-fallback (Step 3), null_resource/data.external blocks can't be
# imported (they have no prior state) -- instead, run `terraform apply
# -target=module.kb1.null_resource.vector_bucket` etc. with each
# provisioner's create command replaced by a no-op `true` for the already-
# existing KB1/KB2 resources specifically (since they already exist, running
# the real create-* command would fail with an AlreadyExists error), OR more
# simply: leave KB1 and KB2 as unmanaged (documented in README.md as
# "pre-existing, not imported -- module is validated against a fresh KB3
# instead in Task 7's smoke test") since null_resource has no real import
# semantics. State this limitation explicitly rather than faking it.
```

- [ ] **Step 7: Verify zero diff (native branch only; fallback branch has no meaningful `plan` diff to check for the imported pseudo-resources)**

```bash
terraform plan
```

Expected (native branch): `No changes.` for the imported KB/data-source/IAM-role resources. Fix any drift before proceeding.

- [ ] **Step 8: Commit**

```bash
git add infra/terraform/modules/bedrock_knowledge_base infra/terraform/bedrock_kb.tf
git commit -m "Add reusable Bedrock KB module, wire up both existing knowledge bases"
```

---

### Task 7: Preview Amplify app and branch

**Files:**
- Create: `infra/terraform/amplify.tf`

**Interfaces:**
- Consumes: none from earlier tasks (Amplify env vars reference the app's own runtime secrets via `var.baws_access_key_id` etc., not other Terraform resources, since the app resolves its own DynamoDB/S3/Bedrock resources by name/ARN at runtime, not via Terraform wiring).
- Produces: nothing consumed by later tasks; this is the last resource-bearing task before Task 8's documentation pass.

Current real config: app `d2l47euepvccx6` ("customer-support-agent-auth-preview2"), platform `WEB_COMPUTE`, branch `worktree-auth-multitenancy-guardrails` with auto-build enabled, `iamServiceRoleArn` set to the same SSR logging role discovered/reused this session, `computeRoleArn` also set on the branch. Repository `https://github.com/supersom/RAG-chat-agent`.

- [ ] **Step 1: Write the Amplify resources**

```hcl
# infra/terraform/amplify.tf
resource "aws_amplify_app" "preview" {
  name       = "customer-support-agent-auth-preview2"
  repository = "https://github.com/supersom/RAG-chat-agent"
  platform   = "WEB_COMPUTE"

  # Only used on the initial create -- Terraform won't re-send this on every
  # apply once the app exists, and it's never needed again for import/update.
  access_token = var.github_access_token

  iam_service_role_arn = "arn:aws:iam::764988411032:role/service-role/AmplifySSRLoggingRole-d5738b45-87bf-463c-822a-995da0844408"

  build_spec = file("${path.module}/../../amplify.yml")
}

resource "aws_amplify_branch" "preview" {
  app_id      = aws_amplify_app.preview.id
  branch_name = "worktree-auth-multitenancy-guardrails"

  enable_auto_build = true
  stage             = "PRODUCTION"
  compute_role_arn  = "arn:aws:iam::764988411032:role/service-role/AmplifySSRLoggingRole-d5738b45-87bf-463c-822a-995da0844408"
}
```

Note: this deliberately does **not** declare the app/branch `environment_variables` in Terraform. This session found that Amplify's console/API-set environment variables don't reliably reach POST-triggered SSR invocations -- the actual working fix was baking required vars into `.env.production` at build time via `amplify.yml` (already checked into the repo), which Terraform doesn't need to duplicate. Declaring `environment_variables` here would be redundant with `amplify.yml` and risks the exact bug this session spent hours diagnosing if the two ever drift out of sync.

- [ ] **Step 2: Import the existing app and branch**

```bash
cd infra/terraform
terraform import aws_amplify_app.preview d2l47euepvccx6
terraform import aws_amplify_branch.preview d2l47euepvccx6/worktree-auth-multitenancy-guardrails
```

- [ ] **Step 3: Verify zero diff**

```bash
terraform plan
```

Expected: `No changes.` The `access_token` and `build_spec` (if `build_spec` isn't actually set via Terraform-manageable API on this app, since it's currently sourced from the repo's own `amplify.yml` file automatically rather than an explicit Console/API build spec override) are the most likely sources of a spurious diff -- if `build_spec` shows as different from `null`/empty, remove that argument from the resource rather than fighting a diff Amplify itself doesn't materially use here.

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/amplify.tf
git commit -m "Import existing preview Amplify app and branch into Terraform"
```

---

### Task 8: README, outputs, and full-plan validation

**Files:**
- Create: `infra/terraform/README.md`
- Create: `infra/terraform/outputs.tf`

**Interfaces:**
- Consumes: every resource from Tasks 2-7, surfaced as outputs for operator visibility.

- [ ] **Step 1: Write outputs**

```hcl
# infra/terraform/outputs.tf
output "tenants_table_name" {
  value = aws_dynamodb_table.tenants.name
}

output "users_table_name" {
  value = aws_dynamodb_table.users.name
}

output "guardrail_id" {
  value = aws_bedrock_guardrail.default.guardrail_id
}

output "kb1_knowledge_base_id" {
  value       = module.kb1.knowledge_base_id
  description = "Must match the knowledgeBaseId field on any tenant record pointed at this KB"
}

output "kb2_knowledge_base_id" {
  value       = module.kb2.knowledge_base_id
  description = "Must match the knowledgeBaseId field on any tenant record pointed at this KB"
}

output "preview_amplify_app_id" {
  value = aws_amplify_app.preview.id
}

output "preview_amplify_default_domain" {
  value = "${aws_amplify_branch.preview.branch_name}.${aws_amplify_app.preview.id}.${aws_amplify_app.preview.default_domain}"
}
```

- [ ] **Step 2: Write the README**

```markdown
# Terraform infra for customer-support-agent

Manages the AWS infrastructure behind the `worktree-auth-multitenancy-guardrails`
preview deployment: DynamoDB tables, IAM policies on the app's service user,
the Bedrock Guardrail, two Bedrock Knowledge Bases (S3 + S3 Vectors), and the
preview Amplify app.

## Explicitly out of scope

- **Production Amplify app** (`RAG-chat-agent`, `d23lox37qr16rj`,
  `kbsearch.somdutta.com`). Console-created, different build spec, not
  imported -- don't add it without a deliberate separate decision.
- **App runtime secrets** (`ANTHROPIC_API_KEY`, `AUTH_SECRET`,
  `TENANT_JWT_SECRET`, etc.). These live in `amplify.yml`'s build-time
  `.env.production` bake step and the app's own `.env.local` for local dev --
  Terraform doesn't manage them, seeding new ones is a manual step.

## Prerequisites

- Terraform >= 1.7
- AWS CLI configured with credentials for account `764988411032`, region
  `us-east-2` (the same admin identity used to provision everything this
  plan imports, not the restricted `claude-qkstart-bedrock` service user --
  that user's own IAM policies are *managed by* this Terraform, so it can't
  be the identity running `terraform apply` against them)
- A copy of `terraform.tfvars` (see `terraform.tfvars.example`) -- never
  commit this file

## Usage

\`\`\`bash
cd infra/terraform
terraform init
terraform plan    # should show no changes against the real, already-imported infra
\`\`\`

To change something (e.g. add a filter to the guardrail, or a new tenant KB),
edit the relevant `.tf` file and run `terraform plan` before `apply`.

## Adding a new Knowledge Base

Add a new `module` block in `bedrock_kb.tf`:

\`\`\`hcl
module "kb3" {
  source = "./modules/bedrock_knowledge_base"

  name_prefix        = "customer-support-agent-kb3-<topic>"
  source_bucket_name = aws_s3_bucket.kb3_source.id  # define this bucket in s3.tf first
  source_bucket_arn  = aws_s3_bucket.kb3_source.arn
  aws_region         = var.aws_region
  aws_account_id     = var.aws_account_id
}
\`\`\`

Then also add its S3 PutObject permission to `iam.tf`'s
`kb_source_bucket_upload` policy resource list, and its bucket's CORS rule,
before it can be used with the app's admin KB-upload feature.

## Known limitations

[If Task 6 ended up using the CLI-fallback branch, document here plainly:
null_resource-based KB management has no real import/diff semantics --
changing a KB's embedding model or storage config requires a manual
taint+apply cycle, not a clean plan/apply. State this rather than pretending
it behaves like a first-class resource.]
```

- [ ] **Step 3: Run the full validation pass**

```bash
cd infra/terraform
terraform validate
terraform plan
```

Expected: `Success! The configuration is valid.` followed by `No changes. Your infrastructure matches the configuration.` across every resource declared in Tasks 2-7. If anything shows a diff at this point, it means an earlier task's HCL doesn't exactly match reality -- go back and fix that task's file, don't patch over it here.

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/README.md infra/terraform/outputs.tf
git commit -m "Add Terraform infra README and outputs, complete full-plan validation"
```
