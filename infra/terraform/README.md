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

```bash
cd infra/terraform
terraform init
terraform plan    # should show no changes against the real, already-imported infra
```

To change something (e.g. add a filter to the guardrail, or a new tenant KB),
edit the relevant `.tf` file and run `terraform plan` before `apply`.

## Adding a new Knowledge Base

Add a new `module` block in `bedrock_kb.tf`:

```hcl
module "kb3" {
  source = "./modules/bedrock_knowledge_base"

  name_prefix        = "customer-support-agent-kb3-<topic>"
  source_bucket_name = aws_s3_bucket.kb3_source.id  # define this bucket in s3.tf first
  source_bucket_arn  = aws_s3_bucket.kb3_source.arn
  aws_region         = var.aws_region
  aws_account_id     = var.aws_account_id
}
```

Then also add its S3 PutObject permission to `iam.tf`'s
`kb_source_bucket_upload` policy resource list, and its bucket's CORS rule,
before it can be used with the app's admin KB-upload feature.

Note: leaving `manage_vector_store` at its default (`true`) is what selects
the fresh-KB-creation code path described below -- and that path has never
been exercised by a real `terraform apply` in this plan (see "Known
limitations"). Treat a first `apply` of a new KB module block as the first
real test of that code, not as a routine, pre-validated operation.

## Known limitations

- **The two existing Knowledge Bases are only partially managed.** The
  `bedrock_knowledge_base` module falls back to `null_resource` /
  `data.external` CLI calls for S3 Vectors resources because the installed
  `hashicorp/aws` provider (v5.100.0) has zero native support for S3 Vectors
  buckets, indexes, or Bedrock Knowledge Base / data-source resources tied to
  them. `null_resource` has no import or diff semantics, so for KB1
  (`SLXQFWWXPR`) and KB2 (`YYPQ95NN4G`) -- both of which pre-date this
  Terraform config -- each module is invoked with `manage_vector_store =
  false`. That flag gates off the vector bucket, index, KB, and data-source
  portions of the module entirely: only each KB's IAM execution role is
  actually imported into Terraform state and managed here. The vector
  bucket/index/KB/data-source objects themselves are genuinely unmanaged --
  not imported, not tracked in state, and not drift-detected. If someone
  changes KB1 or KB2's embedding model, chunking config, or vector store
  outside Terraform, this plan will not notice.

  The module's other code path -- what runs for a hypothetical new KB where
  `manage_vector_store` is left at its default `true` -- creates those
  resources via the same `null_resource`/CLI-fallback mechanism. That path
  has never been exercised by a live `terraform apply` anywhere in this plan;
  no new KB has been created through it. It should be treated as unvalidated
  until someone actually runs it, not assumed to work because the pre-existing
  KBs' import path works.

- **`aws_amplify_branch` cannot track `compute_role_arn`.** The live Amplify
  branch does have a `computeRoleArn` set (confirmed via `aws amplify
  get-branch`), matching the app-level value. But the installed provider's
  `aws_amplify_branch` resource has no `compute_role_arn` argument at all --
  only `aws_amplify_app` exposes it (confirmed via provider schema; see also
  upstream provider issue #41970). This isn't a diff Terraform is ignoring,
  it's an attribute Terraform cannot see or express on the branch resource,
  so branch-level compute-role drift is structurally invisible to this plan.
  The app-level `compute_role_arn` in `amplify.tf` is the only part of that
  value under Terraform's view.

- **`environment_variables` is intentionally ignored on both Amplify
  resources.** `aws_amplify_app.preview` and `aws_amplify_branch.preview` both
  carry `lifecycle { ignore_changes = [environment_variables] }`. The live
  app has ~14 real secrets/config values set outside Terraform (see
  "Explicitly out of scope" above); without `ignore_changes` every `plan`
  would propose deleting all of them, since this config declares none.

## Other known rough edges

- `s3.tf`'s `kb_upload_cors_origin` local hardcodes the current feature-branch
  preview Amplify URL (`worktree-auth-multitenancy-guardrails....amplifyapp.com`)
  as the CORS origin for both KB source buckets. That URL is tied to this
  branch's preview app and will need to be updated (or generalized) if the
  branch is renamed or the preview app is recreated -- an ephemeral value
  sitting in otherwise-durable infra config.
- `amplify.tf` hardcodes the same SSR logging role ARN
  (`arn:aws:iam::764988411032:role/service-role/AmplifySSRLoggingRole-...`)
  as a literal string in two places (`iam_service_role_arn` and
  `compute_role_arn`). A `local` would remove the duplication; left as-is
  since both call sites need to match the live resource exactly and neither
  has changed independently so far.
- `RESEARCH.md` paraphrases the relevant provider schema findings rather than
  pasting raw `terraform providers schema -json` output. Fine for readability,
  but means it can't be diffed against actual schema output to verify it's
  current if the provider version changes.
