output "knowledge_base_id" {
  description = "The Bedrock knowledge_base_id. Derived from the created KB when manage_vector_store = true, otherwise the passed-in existing_knowledge_base_id (KB1/KB2 are pre-existing and unmanaged)."
  value       = var.manage_vector_store ? one(data.external.kb_id[*].result.id) : var.existing_knowledge_base_id
}

output "kb_execution_role_name" {
  description = "Name of the KB execution IAM role (the only resource managed for pre-existing KBs)."
  value       = aws_iam_role.kb_execution.name
}

output "kb_execution_role_arn" {
  description = "ARN of the KB execution IAM role."
  value       = aws_iam_role.kb_execution.arn
}

output "vector_bucket_name" {
  description = "Resolved S3 Vectors bucket name for this KB."
  value       = local.vector_bucket_name
}

output "vector_index_arn" {
  description = "Constructed S3 Vectors index ARN for this KB."
  value       = local.vector_index_arn
}
