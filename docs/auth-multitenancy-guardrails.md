# Authentication, Multi-Tenancy & Bedrock Guardrails

Plan: [`docs/plans/auth-multitenancy-guardrails-plan.md`](plans/auth-multitenancy-guardrails-plan.md) — full context, the confirmed design decisions, the Global Constraints every task was built against, and the per-task specs. This document covers what actually shipped, how it diverged from the plan, and the real AWS resources provisioned for it.

## What changed

Branch `worktree-auth-multitenancy-guardrails` ([PR #1](https://github.com/supersom/RAG-chat-agent/pull/1)) turned the app from fully stateless/unauthenticated into a multi-tenant product with real access control:

- **Authentication** — NextAuth v5, Credentials provider, JWT sessions, two roles (`admin`, `end_user`). Admin signup creates a tenant + its first admin in one flow; `middleware.ts` gates `/admin/*` page navigation.
- **Multi-tenancy** — a DynamoDB-backed `Tenants`/`Users` data layer, and a signed JWT "tenant embed token" (`x-tenant-token` header) that lets `/api/chat` resolve a tenant's config server-side via a single chokepoint, `resolveTenantContext()`, instead of trusting whatever the client sends.
- **The actual security fix** — `/api/chat` and `/api/logs` used to accept arbitrary client-supplied AWS/LLM credentials in the request body, and `/api/chat` mutated `process.env.OPENAI_API_KEY` globally per request (a real cross-tenant credential leak waiting to happen). Both are gone: credentials are always server-resolved, and the API key is passed per-call instead of through a global.
- **Guardrails** — AWS Bedrock Guardrails (`ApplyGuardrailCommand`) screens chat input and output, fail-closed on input errors, fail-open (with logging) on output errors. This screens text regardless of which LLM provider (Anthropic/OpenAI/OpenRouter) generated it.
- **Admin UI** — a tenant settings dashboard and an embed-token/snippet generator.
- **Tests** — a Vitest suite for the two new security-critical modules (`app/lib/tenant.ts`, `app/lib/guardrails.ts`), 9/9 passing.

Built as 10 sequenced tasks (data layer → auth → tenant resolution → route hardening → guardrails → admin UI → tests), each with its own implementer + reviewer pass and fix loops where issues surfaced, followed by a final whole-branch review.

## Where the implementation diverged from the plan

- **Three separate tasks (embed-token route, `/api/logs`, and — correctly avoided in — the admin tenant route) hit the same bug**: the plan's own illustrative auth-check code collapsed "no session" (should be 401) and "wrong role" (should be 403) into a single 403. Caught and fixed each time it recurred; the admin tenant route (built last) got it right on the first pass.
- **The final whole-branch review caught two integration gaps invisible to any single task's review:**
  1. The tenant embed token's delivery mechanism was split between a meta-tag reader (built for the widget) and a query-param snippet (built for the admin dashboard's generator) with nothing bridging them — a real embed would send an empty token and get 401'd. Fixed by having `getTenantToken()` also read `?t=` from the URL.
  2. A freshly signed-up tenant's `guardrailId` defaults to `""` (no env var to seed it from, unlike `knowledgeBaseId`), and the guardrail call was throwing on that empty ID — which the fail-closed INPUT policy correctly treated as an error, permanently blocking chat for every new tenant with no signal why. Fixed by treating an empty `guardrailId` as "not configured, skip screening" rather than an error to fail closed on.
- Two Minor findings were promoted to fix-now during the final review: an email-uniqueness check on admin signup (prevents orphaned tenants + ambiguous login on a repeated email), and a required code comment on the admin-login email-lookup asymmetry that the plan's Global Constraints called for but the original task missed.
- A handful of lower-priority findings were deliberately deferred rather than fixed — see `~/.claude/projects/-home-som-code-claude-quickstarts-customer-support-agent/memory/BACKLOG.md` for the list (a stale-but-harmless middleware path match, generic signup error messages, a dead KB-picker dropdown in the chat UI, a DynamoDB update race, a non-strict nested zod schema, and the token-in-URL exposure inherent to the `?t=` delivery fix above).

## AWS resources provisioned (2026-07-23)

Everything below was created with the account's existing service identity where it already had permission, and with the account's admin identity for the one IAM change needed. All in **`us-east-2`**, account `764988411032`.

### DynamoDB

| Table | Partition key | Sort key / GSI | Billing |
|---|---|---|---|
| `CustomerSupportAgent-Tenants` | `tenantId` (S) | — | `PAY_PER_REQUEST` |
| `CustomerSupportAgent-Users` | `userId` (S) | GSI `email-index`: PK `email` (S), SK `tenantId` (S), full projection | `PAY_PER_REQUEST` |

Created via `aws dynamodb create-table` per the commands in the README's Configuration section. Both tables are `ACTIVE`.

### IAM

The app's existing service user, `claude-qkstart-bedrock` (already used for Bedrock RAG and CloudWatch Logs access), had **no DynamoDB permissions**. Added an inline policy:

- **Policy name:** `DynamoDBTenantsUsersAccess`
- **Actions:** `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`, `DescribeTable`
- **Resources:** scoped to exactly the two table ARNs above plus the `Users` table's index ARN — no wildcard, no access to any other table in the account.

This required the account's admin IAM identity (`iam-som-admin`), not the restricted service user — the same split observed when this user's CloudWatch Logs policy was set up in an earlier session. Verified afterward that the restricted service user can actually read both tables (`DescribeTable` succeeded with its own credentials).

No IAM change was needed for Bedrock — `claude-qkstart-bedrock` already has `AmazonBedrockFullAccess` attached, which covers Guardrails.

### Bedrock Guardrail

- **Name:** `customer-support-agent-default`
- **Guardrail ID:** `fvsirf90zt71`
- **Published version:** `1` (a `DRAFT` version also exists, per Bedrock's normal versioning — the app is configured to use the published `1`)
- **Content filters** (both input and output, `MEDIUM` strength): `SEXUAL`, `VIOLENCE`, `HATE`, `INSULTS`, `MISCONDUCT`
- **Prompt-attack filter:** `PROMPT_ATTACK`, `MEDIUM` on input (Bedrock doesn't apply this filter type to output)
- **Blocked-input message:** "Sorry, I can't help with that request."
- **Blocked-output message:** "Sorry, I can't provide that response. Let me know if there's something else I can help with."

No denied-topics, word-filter, or PII-redaction policies were configured — this is a reasonable default, not a tenant-specific one; each tenant's `guardrailId`/`guardrailVersion` fields (editable in the admin dashboard) can point at a different, more tailored guardrail later.

Verified end-to-end with the app's own restricted credentials: `aws bedrock-runtime apply-guardrail` against this guardrail returned `"action": "NONE"` for a benign test message.

### Local environment

The worktree's `.env.local` (gitignored, not committed) was populated with all of the above — `DYNAMODB_TENANTS_TABLE`, `DYNAMODB_USERS_TABLE`, `BEDROCK_GUARDRAIL_ID=fvsirf90zt71`, `BEDROCK_GUARDRAIL_VERSION=1`, freshly generated `AUTH_SECRET`/`TENANT_JWT_SECRET`, plus the existing `BAWS_*`/knowledge-base values — so `npm run dev` in this worktree can now exercise the real signup/login/chat flow. `ANTHROPIC_API_KEY` is left as a placeholder; fill in a real key to actually generate chat responses.

## What's still not done

Provisioning unblocks manual QA but doesn't replace it. The plan's "Final Verification" checklist — cross-tenant isolation under concurrent load, the `requireEndUserAuth` toggle, a guardrail-trigger test against both a Bedrock-native and an OpenRouter/OpenAI model — hasn't been run against this real infrastructure yet.
