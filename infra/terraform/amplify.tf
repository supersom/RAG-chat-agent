resource "aws_amplify_app" "preview" {
  name       = "customer-support-agent-auth-preview2"
  repository = "https://github.com/supersom/RAG-chat-agent"
  platform   = "WEB_COMPUTE"

  # access_token is only used on initial create (to link GitHub OAuth) and is
  # not needed to manage an already-linked existing app. Declaring it with the
  # placeholder empty-string value from terraform.tfvars fails validation
  # outright (must be length 1-255), so it's omitted rather than fought.
  # github_access_token remains available in variables.tf for a future fresh
  # aws_amplify_app create, per the brief.

  iam_service_role_arn = "arn:aws:iam::764988411032:role/service-role/AmplifySSRLoggingRole-d5738b45-87bf-463c-822a-995da0844408"

  # aws_amplify_app.compute_role_arn is a plain optional argument (not
  # computed), and the live app has it set (confirmed via `aws amplify
  # get-app`) to the same role as iam_service_role_arn. Declaring it avoids
  # a spurious "remove compute_role_arn" diff after import.
  compute_role_arn = "arn:aws:iam::764988411032:role/service-role/AmplifySSRLoggingRole-d5738b45-87bf-463c-822a-995da0844408"

  # build_spec is omitted: the live app's build_spec is null (it builds from
  # the repo's own amplify.yml automatically rather than an API/Console
  # build-spec override), and build_spec is optional+computed, so leaving it
  # unset here matches the real resource with no diff. Declaring
  # file("../../amplify.yml") here (as originally drafted) produced a real
  # diff wanting to push that content as an explicit override.

  lifecycle {
    # environment_variables is a plain optional (non-computed) attribute, and
    # this app carries real values set outside Terraform (see task brief:
    # deliberately not managed here, since amplify.yml baking into
    # .env.production at build time -- not this API -- is the mechanism that
    # actually works for POST-triggered SSR routes). Without ignore_changes,
    # every plan would propose deleting those live values just because config
    # doesn't declare them. This does not declare or manage the values --
    # it only stops Terraform from fighting drift on an attribute this task
    # intentionally leaves unmanaged.
    ignore_changes  = [environment_variables]
    prevent_destroy = true
  }
}

resource "aws_amplify_branch" "preview" {
  app_id      = aws_amplify_app.preview.id
  branch_name = "worktree-auth-multitenancy-guardrails"

  enable_auto_build = true
  stage             = "PRODUCTION"

  # No compute_role_arn here: the aws_amplify_branch resource in
  # terraform-provider-aws has never exposed this argument (only
  # aws_amplify_app did, per upstream issue #41970) even though the AWS
  # Amplify API itself does have a branch-level computeRoleArn set (confirmed
  # via `aws amplify get-branch`, matching the app's role). Declaring it here
  # is a hard "Unsupported argument" validation error, not a diff -- so there
  # is nothing to import or reconcile. The app resource's compute_role_arn
  # below points at the same role.

  lifecycle {
    # Same reasoning as aws_amplify_app.preview above: the branch carries
    # real environment_variables set outside Terraform that this task
    # deliberately does not declare or manage.
    ignore_changes = [environment_variables]
  }
}
