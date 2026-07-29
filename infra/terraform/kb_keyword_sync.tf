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
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = [aws_sqs_queue.kb_keyword_sync.arn]
      },
    ]
  })
}

resource "aws_lambda_function" "kb_keyword_sync_worker" {
  function_name = "kb-keyword-sync-worker"
  role          = aws_iam_role.kb_keyword_sync_worker.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.kb_keyword_sync_worker.repository_url}:latest"
  timeout       = 600
  memory_size   = 1024

  environment {
    variables = {
      DYNAMODB_KEYWORD_SYNC_JOBS_TABLE = aws_dynamodb_table.keyword_sync_jobs.name
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
