terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    external = {
      source  = "hashicorp/external"
      version = ">= 2.0"
    }
    null = {
      source  = "hashicorp/null"
      version = ">= 3.0"
    }
  }
}

# ---------------------------------------------------------------------------
# Reusable Bedrock Knowledge Base module
#
# Provider hashicorp/aws v5.100.0 (the version resolved under the repo's
# ~> 5.60 constraint) has ZERO S3 Vectors support: no aws_s3vectors_* resources
# and no S3_VECTORS storage type on aws_bedrockagent_knowledge_base (see
# infra/terraform/RESEARCH.md). So the vector bucket, vector index, knowledge
# base, and data source are provisioned via the AWS CLI wrapped in
# null_resource/local-exec ("branch B" / CLI fallback). Only the IAM execution
# role and its inline policies use native resources.
#
# KNOWN LIMITATION (referenced by Task 8's README):
#   For the repo's two real, pre-existing knowledge bases (KB1/KB2) this module
#   is instantiated with manage_vector_store = false and manage_iam_policies =
#   false. In that mode ONLY aws_iam_role.kb_execution is managed -- it is
#   brought under Terraform via `terraform import`. The vector bucket, index,
#   KB, and data source already exist in AWS and are deliberately left
#   UNMANAGED, because null_resource has no import semantics and running the
#   create-* CLI commands against already-existing resources would fail with
#   AlreadyExists. A future fresh KB (e.g. a KB3 smoke test) can use this same
#   module with the defaults (both flags true) to create everything from
#   scratch.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "kb_trust" {
  statement {
    sid     = "AmazonBedrockKnowledgeBaseTrustPolicy"
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
  path               = var.iam_role_path
  description        = var.iam_role_description
  assume_role_policy = data.aws_iam_policy_document.kb_trust.json
}

resource "aws_iam_role_policy" "foundation_model" {
  count = var.manage_iam_policies ? 1 : 0

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
        Sid      = "MarketplaceOperationsFromBedrockFor3pModels"
        Effect   = "Allow"
        Action   = ["aws-marketplace:Subscribe", "aws-marketplace:ViewSubscriptions", "aws-marketplace:Unsubscribe"]
        Resource = "*"
        Condition = {
          StringEquals = { "aws:CalledViaLast" = "bedrock.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "s3_vectors" {
  count = var.manage_iam_policies ? 1 : 0

  name = "AmazonBedrockS3VectorStorePolicyForKnowledgeBase_${var.name_prefix}"
  role = aws_iam_role.kb_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "S3VectorsPermissions"
        Effect   = "Allow"
        Action   = ["s3vectors:GetIndex", "s3vectors:QueryVectors", "s3vectors:PutVectors", "s3vectors:GetVectors", "s3vectors:DeleteVectors"]
        Resource = local.vector_index_arn
        Condition = {
          StringEquals = { "aws:ResourceAccount" = var.aws_account_id }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "s3_source" {
  count = var.manage_iam_policies ? 1 : 0

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

# --- CLI-fallback vector store + KB + data source --------------------------
# All gated on manage_vector_store. For KB1/KB2 (manage_vector_store = false)
# none of these are instantiated, so `terraform plan` proposes no creates and
# never invokes the AWS CLI against the already-existing resources.

resource "null_resource" "vector_bucket" {
  count = var.manage_vector_store ? 1 : 0

  triggers = {
    bucket_name = local.vector_bucket_name
    region      = var.aws_region
  }

  provisioner "local-exec" {
    command = "aws s3vectors create-vector-bucket --vector-bucket-name ${local.vector_bucket_name} --encryption-configuration sseType=AES256 --region ${var.aws_region}"
  }

  provisioner "local-exec" {
    when    = destroy
    command = "aws s3vectors delete-vector-bucket --vector-bucket-name ${self.triggers.bucket_name} --region ${self.triggers.region}"
  }
}

resource "null_resource" "vector_index" {
  count      = var.manage_vector_store ? 1 : 0
  depends_on = [null_resource.vector_bucket]

  triggers = {
    bucket_name = local.vector_bucket_name
    index_name  = local.vector_index_name
    dimension   = tostring(var.vector_dimension)
    region      = var.aws_region
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
    command = "aws s3vectors delete-index --vector-bucket-name ${self.triggers.bucket_name} --index-name ${self.triggers.index_name} --region ${self.triggers.region}"
  }
}

resource "null_resource" "knowledge_base" {
  count = var.manage_vector_store ? 1 : 0
  depends_on = [
    null_resource.vector_index,
    aws_iam_role_policy.foundation_model,
    aws_iam_role_policy.s3_vectors,
    aws_iam_role_policy.s3_source,
  ]

  triggers = {
    name                = var.name_prefix
    role_arn            = aws_iam_role.kb_execution.arn
    embedding_model_arn = var.embedding_model_arn
    index_arn           = local.vector_index_arn
    region              = var.aws_region
  }

  provisioner "local-exec" {
    command = <<-EOT
      aws bedrock-agent create-knowledge-base \
        --name "${var.name_prefix}" \
        --role-arn "${aws_iam_role.kb_execution.arn}" \
        --knowledge-base-configuration '{"type":"VECTOR","vectorKnowledgeBaseConfiguration":{"embeddingModelArn":"${var.embedding_model_arn}","embeddingModelConfiguration":{"bedrockEmbeddingModelConfiguration":{"embeddingDataType":"FLOAT32"}}}}' \
        --storage-configuration '{"type":"S3_VECTORS","s3VectorsConfiguration":{"indexArn":"${local.vector_index_arn}"}}' \
        --region ${var.aws_region} \
        --query 'knowledgeBase.knowledgeBaseId' --output text > "$${TMPDIR:-/tmp}/${var.name_prefix}-kb-id.txt"
    EOT
  }
}

data "external" "kb_id" {
  count      = var.manage_vector_store ? 1 : 0
  depends_on = [null_resource.knowledge_base]

  program = ["bash", "-c", "echo \"{\\\"id\\\": \\\"$(cat \"$${TMPDIR:-/tmp}/${var.name_prefix}-kb-id.txt\")\\\"}\""]
}

resource "null_resource" "data_source" {
  count      = var.manage_vector_store ? 1 : 0
  depends_on = [data.external.kb_id]

  triggers = {
    knowledge_base_id = data.external.kb_id[0].result.id
    bucket_arn        = var.source_bucket_arn
    name              = var.name_prefix
    region            = var.aws_region
  }

  provisioner "local-exec" {
    command = <<-EOT
      aws bedrock-agent create-data-source \
        --knowledge-base-id ${data.external.kb_id[0].result.id} \
        --name "${var.name_prefix}-source" \
        --data-source-configuration '{"type":"S3","s3Configuration":{"bucketArn":"${var.source_bucket_arn}"}}' \
        --region ${var.aws_region}
    EOT
  }
}
