# kb1_source intentionally has no matching encryption/public-access-block
# resource below (unlike kb2_source): its live bucket already has a working
# encryption configuration that a Terraform resource here would not
# accurately represent, so it's left unmanaged rather than asserting a
# wrong value.
resource "aws_s3_bucket" "kb1_source" {
  bucket = "claude-qkstrt-kb"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket" "kb2_source" {
  bucket = "css-agent-kb2-materiality-src"

  lifecycle {
    prevent_destroy = true
  }
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
