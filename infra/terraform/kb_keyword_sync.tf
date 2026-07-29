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
    maxReceiveCount     = 3
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
        Sid      = "ConsumeKeywordSyncQueue"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:SendMessage"]
        Resource = [aws_sqs_queue.kb_keyword_sync.arn]
      },
    ]
  })
}

# The Next.js app itself (not the worker) needs to enqueue jobs and read/
# write job status - it authenticates as the shared claude-qkstart-bedrock
# service user via BAWS_* static keys (see app/lib/kb-sync-queue.ts,
# app/lib/db/keyword-sync-jobs.ts), same as every other AWS call the app
# makes. Confirmed missing by the final whole-branch review: without this,
# the very first "Sync" click would fail with AccessDenied, silently caught
# by the route's own try/catch and surfaced as a keywordEnqueueError.
#
# A standalone (customer-managed) policy, not an inline aws_iam_user_policy -
# confirmed live: claude-qkstart-bedrock already carries several inline
# policies (dynamodb_tenants_users, kb_source_bucket_upload,
# cloudwatch_logs_read, read_amplify_cloudwatch_logs, see iam.tf), and inline
# policies share a single 2,048-byte quota AGGREGATED ACROSS ALL of a user's
# inline policies (not 2,048 bytes per policy) - adding this as a 5th inline
# policy tipped the account over that ceiling
# ("LimitExceeded: Maximum policy size of 2048 bytes exceeded"). A managed
# policy has its own separate, much larger 6,144-byte quota per policy and
# doesn't count against the inline aggregate at all.
resource "aws_iam_policy" "kb_keyword_sync_app_access" {
  name = "KeywordSyncAppAccess"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SendKeywordSyncJobs"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [aws_sqs_queue.kb_keyword_sync.arn]
      },
      {
        Sid      = "KeywordSyncJobsTableAppAccess"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
        Resource = [aws_dynamodb_table.keyword_sync_jobs.arn]
      },
    ]
  })
}

resource "aws_iam_user_policy_attachment" "kb_keyword_sync_app_access" {
  user       = data.aws_iam_user.service_user.user_name
  policy_arn = aws_iam_policy.kb_keyword_sync_app_access.arn
}

resource "aws_lambda_function" "kb_keyword_sync_worker" {
  function_name = "kb-keyword-sync-worker"
  role          = aws_iam_role.kb_keyword_sync_worker.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.kb_keyword_sync_worker.repository_url}:latest"
  timeout       = 600
  memory_size   = 1024

  ephemeral_storage {
    size = 2048 # MB - headroom for keyword-index file growth beyond today's 75MB; default is 512MB
  }

  environment {
    variables = {
      DYNAMODB_KEYWORD_SYNC_JOBS_TABLE = aws_dynamodb_table.keyword_sync_jobs.name
      KB_KEYWORD_SYNC_QUEUE_URL        = aws_sqs_queue.kb_keyword_sync.url
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
