# Both knowledge bases below already exist in AWS and predate this Terraform
# config. They are instantiated with manage_vector_store = false and
# manage_iam_policies = false, so ONLY each execution IAM role is managed here
# (brought in via `terraform import`; see this task's report / Task 8 README).
# The S3 Vectors bucket, index, KB, and data source remain UNMANAGED because
# hashicorp/aws v5.100.0 has no S3 Vectors support and null_resource has no
# import semantics (see RESEARCH.md and modules/bedrock_knowledge_base/main.tf).
#
#   KB1: id SLXQFWWXPR, data source HELPS6AVPT
#   KB2: id YYPQ95NN4G, data source ZIPGESZYKQ

module "kb1" {
  source = "./modules/bedrock_knowledge_base"

  name_prefix        = "zjdw5"
  source_bucket_name = aws_s3_bucket.kb1_source.id
  source_bucket_arn  = aws_s3_bucket.kb1_source.arn
  aws_region         = var.aws_region
  aws_account_id     = var.aws_account_id

  # Pre-existing KB: manage only the execution role.
  manage_vector_store        = false
  manage_iam_policies        = false
  existing_knowledge_base_id = "SLXQFWWXPR"

  # KB1's console-created role lives at the /service-role/ path and carries a
  # description; both must match for a clean import (no role replacement).
  iam_role_path        = "/service-role/"
  iam_role_description = "Bedrock Knowledge Base access"

  # KB1's real vector bucket/index names predate the module naming convention.
  vector_bucket_name_override = "bedrock-knowledge-base-tmuwcw"
  vector_index_name_override  = "bedrock-knowledge-base-default-index"
}

module "kb2" {
  source = "./modules/bedrock_knowledge_base"

  name_prefix        = "kb2mat"
  source_bucket_name = aws_s3_bucket.kb2_source.id
  source_bucket_arn  = aws_s3_bucket.kb2_source.arn
  aws_region         = var.aws_region
  aws_account_id     = var.aws_account_id

  # Pre-existing KB: manage only the execution role.
  manage_vector_store        = false
  manage_iam_policies        = false
  existing_knowledge_base_id = "YYPQ95NN4G"

  vector_bucket_name_override = "css-agent-kb2-vectors"
  vector_index_name_override  = "css-agent-kb2-index"
}

# Pooled KB for the multi-tenant scaling work (see README.md's "Adding a new
# Knowledge Base" and DEVLOG.md's pooled-KB entry). Unlike KB1/KB2 this is a
# genuinely fresh KB with no pre-existing AWS resources to import around, so
# it uses the module's defaults: manage_vector_store = true and
# manage_iam_policies = true create the S3 Vectors bucket/index, the KB
# itself, and its data source, plus the three least-privilege inline
# policies on the execution role -- all via the module's live-verified
# fresh-KB path (see modules/bedrock_knowledge_base's README "Known
# limitations" section).
#
# Isolation between tenants sharing this KB comes from the mandatory
# tenantId metadata filter in retrieveContext (app/lib/utils.ts), not from
# separate KBs -- see this branch's plan doc for the full rationale.
module "pool" {
  source = "./modules/bedrock_knowledge_base"

  name_prefix        = "kbpool"
  source_bucket_name = aws_s3_bucket.pool_source.id
  source_bucket_arn  = aws_s3_bucket.pool_source.arn
  aws_region         = var.aws_region
  aws_account_id     = var.aws_account_id
}
