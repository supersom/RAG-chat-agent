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
  description = "Use this exact vector bucket name instead of '<name_prefix>-vectors'. Needed when importing a KB whose vector bucket predates this module's naming convention (e.g. KB1's real bucket is 'bedrock-knowledge-base-tmuwcw')."
  type        = string
  default     = null
}

variable "vector_index_name_override" {
  description = "Use this exact vector index name instead of '<name_prefix>-index'. Same rationale as vector_bucket_name_override."
  type        = string
  default     = null
}

# --- Existing-KB import controls ------------------------------------------
#
# This module can create a brand-new Bedrock Knowledge Base end to end
# (IAM role + inline policies + S3 Vectors bucket/index + KB + data source).
# The two knowledge bases this repo actually uses already exist in AWS and
# were created outside Terraform, so for those instantiations everything
# except the execution role is left UNMANAGED. See main.tf's header comment
# and the two flags below.

variable "manage_vector_store" {
  description = <<-EOT
    When true (default, fresh-KB mode) this module creates the S3 Vectors
    bucket, the vector index, the knowledge base, and the KB data source via
    the AWS CLI (null_resource/local-exec, because provider v5.100.0 has no
    native S3 Vectors support -- see infra/terraform/RESEARCH.md).

    Set to false for the two pre-existing knowledge bases (KB1/KB2). The AWS
    S3 Vectors / bedrock-agent resources for those already exist and
    null_resource has no import semantics, so they are deliberately left
    unmanaged -- running the create-* CLI commands against them would fail
    with AlreadyExists. In that mode only aws_iam_role.kb_execution is
    managed (via terraform import).
  EOT
  type        = bool
  default     = true
}

variable "manage_iam_policies" {
  description = <<-EOT
    When true (default, fresh-KB mode) the three least-privilege inline
    policies (foundation-model invoke, S3 Vectors read/write, S3 source-bucket
    read) are attached to the execution role.

    Set to false for KB1/KB2: their execution roles already carry the
    equivalent permissions in AWS (KB1 via customer-managed policies at the
    /service-role/ path, KB2 via its own inline policies) and only the role
    itself is imported, so re-declaring inline policies here would show as
    phantom creates against pre-existing KBs.
  EOT
  type        = bool
  default     = true
}

variable "iam_role_path" {
  description = "IAM path for the execution role. KB1's console-created role lives at /service-role/; fresh KBs use /."
  type        = string
  default     = "/"
}

variable "iam_role_description" {
  description = "Description attribute of the execution role, matched to the pre-existing role when importing (KB1 uses 'Bedrock Knowledge Base access')."
  type        = string
  default     = null
}

variable "existing_knowledge_base_id" {
  description = "The real knowledge_base_id of a pre-existing KB. Used as the module's knowledge_base_id output when manage_vector_store = false (the KB is not managed here so its id cannot be derived from a created resource)."
  type        = string
  default     = null
}

locals {
  vector_bucket_name = coalesce(var.vector_bucket_name_override, "${var.name_prefix}-vectors")
  vector_index_name  = coalesce(var.vector_index_name_override, "${var.name_prefix}-index")
  vector_index_arn   = "arn:aws:s3vectors:${var.aws_region}:${var.aws_account_id}:bucket/${local.vector_bucket_name}/index/${local.vector_index_name}"
}
