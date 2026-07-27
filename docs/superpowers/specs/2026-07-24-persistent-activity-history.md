# Persistent per-user activity history

**Date:** 2026-07-24
**Branch:** `worktree-tenant-llm-config`

## Problem

The chat surface currently keeps user-visible activity only in browser React
state:

- `components/ChatArea.tsx` stores chat messages in local component state.
- `components/LeftSidebar.tsx` stores assistant thinking entries from
  `updateSidebar` browser events.
- `components/RightSidebar.tsx` stores knowledge-base references from
  `updateRagSources` browser events.
- Admin CloudWatch logs are polled from `/api/logs` and stored only in sidebar
  state.

Navigating away, refreshing, logging out, or logging back in loses all of this.
Admins also have no durable per-user audit view for their organization.

The durable store must be scoped by authenticated tenant and user. Admins can
read all activity for their own tenant. No endpoint should ever allow a user to
read another tenant's activity or logs.

## Recommended approach

Add a server-side activity history store in DynamoDB and write activity from
trusted server paths, primarily `/api/chat/route.ts`. Do not ask the browser to
post back the assistant response, thinking, RAG references, or tenant id after a
turn finishes; those values already exist server-side and client-submitted
copies would be easier to spoof.

Keep raw CloudWatch access out of the long-term activity UI. Raw Amplify
CloudWatch logs are app-level, not tenant-level. If more than one tenant points
at the same Amplify app, returning raw events from `/api/logs` cannot guarantee
cross-tenant isolation. For the admin sidebar, persist and display tenant-scoped
structured app log/activity records instead.

## DynamoDB table

Create a new table, managed in `infra/terraform/dynamodb.tf`:

```hcl
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
```

Runtime env var:

```text
DYNAMODB_ACTIVITY_TABLE=CustomerSupportAgent-Activity
```

Primary access patterns:

- End user: query GSI where `tenantUserId = "${sessionTenantId}#${sessionUserId}"`.
- Admin org feed: query table where `tenantId = sessionTenantId`.
- Admin user filter: query the same GSI, after confirming the selected user
  belongs to `sessionTenantId`.

No read/write API should accept `tenantId` from the request body or query
string for authorization. Always derive it from the signed NextAuth session or
from a verified tenant embed token where anonymous embed support is explicitly
intended.

## Record shape

Add an `ActivityRecord` interface in `app/lib/db/schema.ts`:

```ts
export interface ActivityRecord {
  tenantId: string;
  createdAtActivityId: string; // `${createdAt}#${activityId}`
  activityId: string;
  createdAt: string;
  expiresAt?: number;

  tenantUserId: string; // `${tenantId}#${userId}`
  userId: string;
  userEmail?: string;
  userRole: "admin" | "end_user";

  kind: "chat_turn" | "app_log";

  chat?: {
    clientMessageId?: string;
    model: string;
    provider: "openai" | "anthropic" | "openrouter";
    userMessage: string;
    assistantMessage?: string;
    assistantThinking?: string;
    userMood?: string;
    suggestedQuestions?: string[];
    matchedCategories?: string[];
    redirectToAgent?: {
      shouldRedirect: boolean;
      reason?: string;
    };
    guardrail?: {
      inputBlocked?: boolean;
      outputBlocked?: boolean;
    };
  };

  knowledgeBase?: {
    contextUsed: boolean;
    sources: Array<{
      id: string;
      fileName: string;
      snippet: string;
      score: number;
    }>;
  };

  appLog?: {
    level: "debug" | "info" | "warn" | "error";
    message: string;
    requestId?: string;
    route?: string;
    metadata?: Record<string, string | number | boolean | null>;
  };
}
```

The `assistantThinking` field is the assistant-visible explanation already
returned by the model JSON and shown in `LeftSidebar`; it is not hidden model
chain-of-thought.

Do not store secrets, API keys, authorization headers, raw prompts containing
provider credentials, or full CloudWatch event payloads.

## Server writes

Add `app/lib/db/activity.ts` with focused helpers:

- `putChatTurnActivity(record)`
- `putAppLogActivity(record)`
- `getActivityForUser({ tenantId, userId, limit, before })`
- `getActivityForTenant({ tenantId, limit, before })`
- `getActivityForTenantUser({ tenantId, userId, limit, before })`

Persist chat turns inside `app/api/chat/route.ts` after the response is known:

- On normal completion, store user message, assistant response, assistant
  thinking, mood, suggested questions, matched categories, redirect decision,
  model/provider, `debug.context_used`, and RAG sources.
- On input guardrail block, store a `chat_turn` with
  `guardrail.inputBlocked = true` and the blocked response text.
- On generation or RAG failure, store a sanitized `app_log` error for the
  authenticated tenant/user and, where there is still a user-facing assistant
  response, store a failed `chat_turn`.

The current `resolveTenantContext(req)` only returns tenant data. For durable
user activity, add a small server helper that returns both trusted tenant
context and trusted actor context:

```ts
type ActorContext =
  | {
      kind: "authenticated";
      userId: string;
      email?: string | null;
      role: "admin" | "end_user";
      tenantId: string;
    }
  | {
      kind: "anonymous_embed";
      anonymousId: string;
      tenantId: string;
    };
```

For the first implementation, persist only authenticated users because the
requirement includes logout/login continuity. Anonymous embed persistence needs
a separate first-party anonymous activity cookie and retention policy.

Also update Auth.js session callbacks to expose the user id explicitly:

```ts
token.userId = user.id;
session.user.id = token.userId;
```

## Read APIs

Add `app/api/activity/route.ts`:

- `GET /api/activity?limit=50&before=<createdAtActivityId>`
  - Requires a signed session.
  - `admin`: returns recent activity for `session.user.tenantId`.
  - `end_user`: returns only records for
    `${session.user.tenantId}#${session.user.id}`.

Add `app/api/admin/activity/route.ts` if admin filtering needs a separate
surface:

- `GET /api/admin/activity?userId=<id>&limit=50&before=<createdAtActivityId>`
  - Requires `session.user.role === "admin"`.
  - Derives tenant from `session.user.tenantId`.
  - If `userId` is supplied, first verify that user belongs to the same tenant
    via `getUsersByTenant` or a tenant-scoped user lookup, then query the GSI.

Do not support a `tenantId` parameter on either endpoint.

## Frontend hydration

On page load after session resolution:

- `ChatArea.tsx` calls `/api/activity` and reconstructs chat messages from
  recent `chat_turn` records.
- `LeftSidebar.tsx` hydrates assistant thinking from the same `chat_turn`
  records instead of relying only on `updateSidebar` events.
- `RightSidebar.tsx` hydrates knowledge-base references from `knowledgeBase`
  fields in the same records.
- Admins get an organization activity mode with a user filter sourced from the
  existing tenant user list. Selecting a user switches the feed to that user's
  records.

After a new chat turn, the UI can optimistically append the response exactly as
it does today. It should also reconcile from `/api/activity` after the request
finishes so a server-assigned `activityId` becomes available for later paging.

## Admin logs

Replace the current user-facing CloudWatch sidebar with tenant-scoped activity
logs:

- Emit structured `app_log` records from server code with authenticated
  `tenantId`, `userId`, route, level, message, and sanitized metadata.
- Display those persisted records in the admin sidebar.
- Keep raw `/api/logs` either disabled by default, renamed as deployment
  diagnostics, or restricted to development-only diagnostics until log messages
  are consistently tenant-tagged and server-filtered.

If raw CloudWatch remains available, the route must filter server-side to
structured log messages whose embedded `tenantId` equals `session.user.tenantId`
before returning anything. Unstructured raw events should be dropped, not shown.

## Retention and privacy

Set a TTL, for example 30 days:

```ts
const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
```

This is long enough for users to return to recent work and for admins to review
recent support activity, while avoiding indefinite retention of chat content.

Because chat content and KB snippets can contain user data, add an admin-visible
retention note and keep export/delete support as a follow-up if this becomes a
production compliance requirement.

## Implementation sequence

1. Add `DYNAMODB_ACTIVITY_TABLE`, Terraform table, and IAM permissions for the
   SSR role.
2. Add `ActivityRecord` types and `app/lib/db/activity.ts` helpers with unit
   tests.
3. Expose `session.user.id` in Auth.js session/JWT callbacks.
4. Persist authenticated chat turns from `/api/chat/route.ts`.
5. Add `/api/activity` and admin-filtered reads.
6. Hydrate chat, thinking, and KB sidebars from activity records.
7. Replace admin sidebar raw CloudWatch polling with persisted tenant-scoped
   app logs.
8. Add regression tests proving an admin in tenant A cannot read tenant B
   activity, even when passing a tenant B `userId`.

## Acceptance criteria

- A logged-in end user can send a chat message, navigate away, log out, log
  back in, and see their own chat history, assistant thinking, and KB sources.
- A logged-in admin can see all persisted activity for users in their tenant
  and filter by user.
- An end user cannot see another user's activity.
- An admin cannot see another tenant's activity or logs by changing query
  params, user ids, or browser state.
- Raw CloudWatch events are not exposed in the tenant activity UI unless they
  are structured, tenant-tagged, sanitized, and filtered server-side.
