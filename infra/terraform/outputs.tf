output "tenants_table_name" {
  value = aws_dynamodb_table.tenants.name
}

output "users_table_name" {
  value = aws_dynamodb_table.users.name
}

output "activity_table_name" {
  value = aws_dynamodb_table.activity.name
}

output "guardrail_id" {
  value = aws_bedrock_guardrail.default.guardrail_id
}

output "kb1_knowledge_base_id" {
  value       = module.kb1.knowledge_base_id
  description = "Must match the knowledgeBaseId field on any tenant record pointed at this KB"
}

output "kb2_knowledge_base_id" {
  value       = module.kb2.knowledge_base_id
  description = "Must match the knowledgeBaseId field on any tenant record pointed at this KB"
}

output "preview_amplify_app_id" {
  value = aws_amplify_app.preview.id
}

output "preview_amplify_default_domain" {
  # aws_amplify_app.preview.default_domain already resolves to
  # "<app_id>.amplifyapp.com" (confirmed via `terraform state show`), so
  # prefixing it with app_id again, per the brief's original template, would
  # produce a duplicated-app-id string that isn't the real URL. Branch preview
  # URLs are "<branch_name>.<app_id>.amplifyapp.com", i.e. just
  # branch_name + default_domain.
  value = "${aws_amplify_branch.preview.branch_name}.${aws_amplify_app.preview.default_domain}"
}
