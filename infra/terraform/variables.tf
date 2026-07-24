variable "aws_region" {
  description = "AWS region all resources are deployed in"
  type        = string
  default     = "us-east-2"
}

variable "aws_account_id" {
  description = "AWS account ID that owns all resources in this plan"
  type        = string
  default     = "764988411032"
}

variable "baws_access_key_id" {
  description = "Existing AWS access key ID the app uses at runtime (BAWS_ACCESS_KEY_ID). Not created by Terraform -- documented here only so its origin is traceable."
  type        = string
  sensitive   = true
}

variable "baws_secret_access_key" {
  description = "Existing AWS secret access key the app uses at runtime (BAWS_SECRET_ACCESS_KEY)."
  type        = string
  sensitive   = true
}

variable "github_access_token" {
  description = "GitHub PAT with repo-contents-read + webhook read/write scope, used only when creating a NEW Amplify app via aws_amplify_app. Not needed for importing the existing preview app."
  type        = string
  sensitive   = true
  default     = ""
}
