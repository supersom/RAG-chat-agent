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
