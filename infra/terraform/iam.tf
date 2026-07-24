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
          aws_dynamodb_table.activity.arn,
          "${aws_dynamodb_table.activity.arn}/index/*",
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

data "aws_iam_policy_document" "cloudwatch_logs_read_existing" {
  statement {
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "logs:DescribeLogStreams",
      "logs:FilterLogEvents",
      "logs:GetLogEvents",
    ]
    resources = ["arn:aws:logs:*:764988411032:log-group:/aws/amplify/*:*"]
  }
}

resource "aws_iam_user_policy" "cloudwatch_logs_read" {
  name   = "CloudWatchLogsReadAccess"
  user   = data.aws_iam_user.service_user.user_name
  policy = data.aws_iam_policy_document.cloudwatch_logs_read_existing.json
}

data "aws_iam_policy_document" "read_amplify_cloudwatch_logs_existing" {
  statement {
    effect = "Allow"
    actions = [
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
      "logs:FilterLogEvents",
    ]
    resources = ["arn:aws:logs:*:764988411032:log-group:/aws/amplify/*"]
  }
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
