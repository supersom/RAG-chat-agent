resource "aws_dynamodb_table" "tenants" {
  name         = "CustomerSupportAgent-Tenants"
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

  lifecycle {
    prevent_destroy = true
  }
}


resource "aws_dynamodb_table" "activity" {
  name         = "CustomerSupportAgent-Activity"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tenantId"
  range_key    = "createdAtActivityId"

  attribute {
    name = "tenantId"
    type = "S"
  }

  attribute {
    name = "createdAtActivityId"
    type = "S"
  }

  attribute {
    name = "tenantUserId"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  global_secondary_index {
    name            = "tenantUserId-createdAt-index"
    hash_key        = "tenantUserId"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  lifecycle {
    prevent_destroy = true
  }
}
