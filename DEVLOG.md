# Dev Log

## 2026-07-23 — Amplify preview deployment: two platform-level bugs blocking signup/login

**Context:** `worktree-auth-multitenancy-guardrails` (PR #1) was code-reviewed clean and merge-ready, but had never been QA'd against a real deployment. Stood up a separate preview Amplify app (isolated from production `kbsearch.somdutta.com`) to run the manual QA checklist before merging.

### Bug 1: admin signup 500'd — "Resolved credential object is not valid"

**Decision:** Bake required server-side env vars into `.env.production` via a build-time `echo` step in `amplify.yml`, instead of relying on Amplify's app/branch `environment-variables` API reaching the SSR runtime.

**Reasoning:** `POST /api/admin/signup` threw an AWS SDK credential error on every attempt, while GET requests to routes using the identical DynamoDB client succeeded. A long diagnostic pass (isolating route path, HTTP method, body-reading, build cache, region resolution) proved the failure was deterministic and tied specifically to POST invocations. Deleting and recreating the Amplify app from scratch did **not** fix it — the same failure reproduced immediately on the fresh app, which ruled out "this particular app is misconfigured" as the explanation. The actual proof came from a temporary diagnostic route that read `process.env.BAWS_ACCESS_KEY_ID` directly inside a POST handler: present on GET, `undefined` on POST. Comparing against the working production app's `amplify.yml` showed it had (probably unknowingly) always worked around this exact gap by echoing every credential into a `.env` file during `build`, before `npm run build` — Next.js loads `.env`/`.env.production` at its own server boot, a path unaffected by whatever gap exists in Amplify's runtime env-var injection for POST-triggered SSR invocations. Porting that pattern into this branch's `amplify.yml` fixed it immediately, confirmed by the diagnostic route (vars present) and then a real signup returning 200 with a tenant actually created in DynamoDB.

Two secondary app-config gaps were found and fixed along the way, both specific to `aws amplify create-app` (CLI) versus the Console wizard:
- New app defaulted to `platform: WEB` (static hosting) instead of `WEB_COMPUTE` (Next.js SSR) — CloudFront was routing POSTs straight to the S3 static origin (a 301, `server: AmazonS3`) instead of the Lambda compute. Fixed via `update-app --platform WEB_COMPUTE`.
- The SSR logging role needs to be set via `update-app --iam-service-role-arn`, not `--compute-role-arn` — production's app only ever had `iamServiceRoleArn` populated; setting `computeRoleArn` alone left no CloudWatch log group.

Branch `stage` (`NONE` vs `PRODUCTION`) was tested as a hypothesis for the original bug and made no difference — ruled out, not worth re-chasing.

### Bug 2: signup succeeded but sign-in failed — "UntrustedHost"

**Decision:** Set `trustHost: true` in `auth.config.ts`.

**Reasoning:** After fixing Bug 1, signup worked but auto-sign-in immediately after (and `/admin/login` separately) both failed. CloudWatch logs showed the real cause directly: `[auth][error] UntrustedHost: Host must be trusted`, thrown by Auth.js (NextAuth v5) on every request to `/api/auth/*`. Auth.js v5 requires the deployment host to be explicitly trusted on any platform besides Vercel (via `trustHost: true` or `AUTH_TRUST_HOST=true`) — without it, it rejects all requests outright, including ones where it had already correctly resolved the real Amplify domain. This is unrelated to Bug 1 and wasn't caught locally because `next dev`/`next start` on localhost never exercises this check. One-line fix, verified against the real `/api/auth/session` endpoint returning a valid session with correct `role`/`tenantId` after login.

**Status:** Both fixes deployed and verified live on `d2l47euepvccx6` (https://worktree-auth-multitenancy-guardrails.d2l47euepvccx6.amplifyapp.com). Signup → auto-login → session all confirmed working end-to-end. Remaining manual QA checklist (cross-tenant isolation, guardrail trigger test, `requireEndUserAuth` toggle, etc.) is now unblocked — see `BACKLOG.md` in the project memory directory.

## 2026-07-23 20:10 — Manual QA checklist executed against the preview deployment

**Decision:** Run all 10 original checklist items plus 5 follow-up items (logout button, OpenAI default, tenant Users feature) live against `d2l47euepvccx6`, rather than relying on code review alone, before considering the branch mergeable.

**Reasoning:** The branch had been code-reviewed clean but never exercised against real deployed infrastructure — the two Amplify platform bugs above were proof that code-level correctness and deployment correctness are different questions here. All 15 items passed (full results, screenshots, and methodology in `docs/qa-results-2026-07-23.md`), including the two tests specifically designed to re-validate earlier-session bugs under real conditions rather than just in code: cross-tenant isolation under genuine concurrency (two real concurrent `/api/chat` calls, ~19ms apart, zero cross-contamination — re-validates the original `process.env` global-mutation credential leak is fixed), and a fresh tenant with an empty `guardrailId` successfully chatting (re-validates the final-review fix that stops "no guardrail configured yet" from being treated as an AWS error). Three non-blocking issues were found and are tracked separately: a placeholder `ANTHROPIC_API_KEY` on this preview deployment (blocks any test needing a full LLM completion), one tenant record with unexplained malformed defaults, and (at the time) no working logout mechanism.

**Status:** Complete. The one genuine follow-up — logout redirecting to `localhost:3000` instead of the real Amplify domain because `AUTH_URL` was never set — was root-caused (Auth.js needs `AUTH_URL` for constructing *outgoing* redirect URLs, separate from the `trustHost` fix which only governs *incoming* host trust) and fixed by baking `AUTH_URL=https://${AWS_BRANCH}.${AWS_APP_ID}.amplifyapp.com` into `.env.production` in `amplify.yml`, using Amplify's own build variables so the fix isn't hardcoded to one app. This shipped and has been through many subsequent deploys; the underlying login/logout cycle has worked repeatedly in later sessions, but no separate formal re-run of QA item 11 specifically was written up after the fix.

## 2026-07-23 20:10 — End-user login flow, chat error states, and the login/signup navigation race

Three related UX bugs found and fixed while exercising the login/signup flow manually; grouping them here since they compound into "auth sometimes silently does nothing."

### No login surface for end users, and no visible error when chat fails

**Decision:** Move login from `/admin/login` to `/login` (taking an optional `?callbackUrl=`) so the same page serves both admin and end-user sign-in; make `ChatArea.tsx` show a "Please sign in to continue chatting" prompt (linking to `/login?callbackUrl=<current chat URL>`) instead of silently failing when `resolveTenantContext` returns "Authentication required."

**Reasoning:** Tenants with `requireEndUserAuth: true` had no way for an end user to actually log in — only `/admin/login` existed, and it was gated to admin-only sign-in. Separately, `ChatArea.tsx`'s `handleSubmit` left the optimistic "Thinking..." placeholder message stuck forever on any request failure (the `catch` block only did `console.error`, never updated the UI), so a 401 for "not logged in" looked identical to the app being frozen. Fixed both together: the 401-with-"Authentication required" case now removes the placeholder and shows a dedicated sign-in banner; every other failure path now replaces the placeholder with a visible error message instead of leaving it stuck.

### Login/signup sometimes did nothing on a genuinely successful sign-in

**Decision:** Replace `router.push(...)` with `window.location.href = ...` after a successful `signIn()` in both `app/admin/signup/page.tsx` and `app/login/page.tsx`.

**Reasoning:** `router.push` is a Next.js App Router *soft* navigation, which can race the just-set session cookie — `middleware.ts`'s auth check sometimes ran before the cookie was visible to it and silently redirected back to the login page, with no error shown (the login code itself never entered its error branch, since `signIn()` had genuinely succeeded). Confirmed via direct `/api/auth/session` checks that the session was valid both server- and client-side even on runs where the redirect silently failed — proving it was a timing race, not an auth failure. A hard navigation forces a fresh request cycle guaranteed to include the cookie.

A related follow-up surfaced once this worked: `/login?callbackUrl=%2Fadmin` was looping non-admin (`end_user`-role) sessions, since the callback blindly navigated to whatever `callbackUrl` middleware had set regardless of the signed-in user's role. Fixed by checking the session's role client-side before navigating to an `/admin`-prefixed callback — a non-admin session is redirected to `/` (the chat) instead of bouncing back to `/login` in a loop or showing a "doesn't have admin access" error (the latter was the first fix attempted; changed to a silent redirect per explicit product feedback that an end-user hitting an admin-only callback should just land in the chat they can actually use, not see an error about a page they were never trying to reach).

**Status:** All three shipped, verified via the manual QA checklist above (items 1–4) and via repeated live login/logout cycles in later sessions.

## 2026-07-23 20:10 — Guardrails-only, no separate custom guardrail layer (design decision)

**Decision:** Use Bedrock Guardrails as the sole content/prompt-injection screening layer for this phase; no additional provider-agnostic custom guardrail code (rate limiting, extra prompt-injection delimiting around RAG content) was built.

**Reasoning:** Bedrock Guardrails screens text (both input and output) regardless of which LLM actually generated the response, so it works uniformly across the multi-provider `llmProviderDefaults` setup (OpenAI, Anthropic, OpenRouter) without per-provider integration work. A custom layer remains a reasonable future addition if a specific gap in Bedrock's coverage is identified, but wasn't needed to ship this phase.

## 2026-07-24 — Merging to `main` broke production login: env vars provisioned for preview never reached prod

**Context:** PR #1 merged and auto-deployed to `main`, which is production (`kbsearch.somdutta.com`, Amplify app `d23lox37qr16rj`) — a different app from the preview used throughout the QA work above. Admin login on production immediately started failing with Auth.js's generic "Server error: There is a problem with the server configuration" page.

**Decision:** Add the auth branch's required env vars directly to production's Amplify app (fresh `AUTH_SECRET`/`TENANT_JWT_SECRET`, copied `BAWS_*`/`DYNAMODB_*`/`BEDROCK_GUARDRAIL_*` from local `.env.local`), then separately fix `amplify.yml` (PR #2) to let `AUTH_URL` be overridden by an env var instead of always deriving the `*.amplifyapp.com` domain.

**Reasoning:** CloudWatch showed `[auth][error] MissingSecret`, and the Amplify Console's Environment Variables page for production read "No records to display" — genuinely zero vars, not an API-reporting quirk (that quirk is real for this account but wasn't the cause here). Root cause: production's pre-auth architecture let the *client* supply its own AWS credentials per request, which is exactly the credential-leak model this whole branch exists to close — so production never needed server-side env vars before, and none of this branch's provisioning work (done entirely against the separate preview app) ever touched it. Verified the fix without real admin credentials: a `POST /api/auth/callback/credentials` with deliberately wrong credentials returned a normal `CredentialsSignin` redirect instead of a config-error crash, proving both `AUTH_SECRET` and the DynamoDB user lookup (`BAWS_*`) resolve correctly at runtime. That same probe caught a second, live bug — the redirect pointed at `main.d23lox37qr16rj.amplifyapp.com` instead of `kbsearch.somdutta.com`, because `amplify.yml` hardcoded the `AUTH_URL` construction with no awareness of custom domains.

**Status:** Env vars added and login confirmed working on production. PR #2 (`AUTH_URL` fix) merged (`ca98c5d`) and verified live via the same bad-credentials probe — redirect now correctly targets `kbsearch.somdutta.com`.

**Takeaway:** merging a branch that introduces new required env vars does not provision them anywhere except wherever they were already tested against. Before merging any future branch with new env var dependencies, check the *actual* production app's env vars specifically — don't assume preview-app provisioning covers it, and don't trust a green code review or even a green preview-deployment QA pass as a signal that production is ready.

## 2026-07-24 — Sign-in prompt silently failed to show for logged-out chat attempts on production

**Context:** Comparing production against the preview app surfaced two apparent differences: the Settings modal shows fewer fields on production, and starting a chat while logged out shows no sign-in prompt (just a generic broken-looking reply) instead of a "Please sign in" banner.

**Decision:** The Settings modal difference is not a bug — left as-is. The missing sign-in prompt was real; fixed by broadening `ChatArea.tsx`'s check from matching the exact string `"Authentication required"` to just `response.status === 401`.

**Reasoning:** `SettingsModal.tsx` gates the "bring your own credentials" panel (LLM API key, AWS keys, KB ID, tenant embed token field) behind `NEXT_PUBLIC_APP_ENV === "development"`, which production intentionally doesn't have set — this whole branch exists to stop end users from pasting raw AWS credentials into the app, so hiding that panel in production is correct, not a regression.

The sign-in prompt gap was real: `resolveTenantContext()` (`app/lib/tenant.ts`) returns three different 401 reasons — `"Missing tenant token"`, `"Invalid or expired tenant token"`, `"Authentication required"` — but `ChatArea.tsx` only recognized the exact `"Authentication required"` string; the other two fell through to a generic "Sorry, something went wrong" chat bubble that looked like a broken assistant reply rather than an auth problem. Initial framing was "the page doesn't know what tenant you mean" (no session, no `?t=` token) — corrected after pushback: all three 401 branches in `resolveTenantContext` only fire when there's no session, checked first and unconditionally, so *any* 401 from `/api/chat` structurally means "not signed in," and signing in resolves all three via `session.user.tenantId` regardless of which reason fired. Checking the status code instead of the message is both simpler and more correct than enumerating every string.

**Status:** Pushed directly to `main` (`b5fad2e`, no PR), redeployed, and verified live in-browser: visiting `kbsearch.somdutta.com` logged out and sending a message now shows "Please sign in to continue chatting" with a working Sign in button.

## 2026-07-24 — Per-tenant LLM provider/API key/model config: two incidents worth remembering

**Context:** Built `worktree-tenant-llm-config` (PR #3) — each tenant can configure its own LLM provider/API key/allowed-models, taking precedence over the main app's server env-var defaults, which in turn take precedence over the existing dev-only client-supplied key. Schema change, AES-256-GCM at-rest encryption, three-tier resolution logic, admin UI, and a fix to a latent signup bug (new tenants were hardcoded to `provider: "openai", model: "gpt-4o-mini"`, which would break signups on any non-OpenAI deployment). Built task-by-task via subagent-driven development with a task reviewer after each step and a final whole-branch review; two Important findings from that final review (untested PATCH merge/validation logic, an unguarded decrypt throw on the chat hot path) were fixed and re-reviewed clean before merge. Full narrative and code-level detail lives in `docs/superpowers/specs/2026-07-24-tenant-llm-config-design.md` and `docs/superpowers/plans/2026-07-24-tenant-llm-config.md`.

Two incidents from this session are worth remembering beyond the feature itself:

### Incident 1: a Server→Client prop leak, caught during planning rather than review

While writing the implementation plan, re-reading `app/admin/page.tsx` turned up something the spec hadn't accounted for: it's a Server Component that fetches the tenant via a direct `getTenant()` DB call and was passing the *raw* tenant object — including the new encrypted `apiKeyCiphertext` field — as a prop into `TenantSettingsForm`, a Client Component. Next.js serializes Server→Client Component props into the page payload the browser receives, exactly like an API response body. Redacting only the `/api/admin/tenant` route (the obvious place to look) would have left this second, easy-to-miss path wide open. Fixed by extracting a single shared `redactTenant()` utility (`app/lib/tenant-redact.ts`) used at both exit points, so they can't drift apart — and both the encryption module and this redaction utility got extra-scrutiny reviews specifically because they were flagged as the highest-stakes pieces going in.

**Takeaway:** when a schema gains a secret field, grep every consumer of the type, not just the API routes that obviously return it — Server Component props into Client Components are a real, easy-to-miss serialization boundary in the App Router.

### Incident 2: committed real AWS credentials into the plan doc, caught by GitHub before anything left the machine

While drafting the plan's deployment task, I quoted the live output of `aws amplify get-app` (fetched to discover the target preview app's config) verbatim into an example `aws amplify update-app` command in the committed plan file — including real `BAWS_ACCESS_KEY_ID`/`BAWS_SECRET_ACCESS_KEY` values. `git push` was rejected outright by GitHub's push protection before anything reached the remote.

**Decision:** Scrub the secret from this branch's history via `git filter-branch --tree-filter`, scoped explicitly to `9859e7d..HEAD` (this branch's own commits only) — not `git-filter-repo`, which was available and is the modern recommended tool, but rewrites *all* refs in the repository by default. This worktree shares its `.git` object store with the main checkout and any other concurrent worktree sessions; running a repo-wide rewrite here would have corrupted `main` and any other in-progress session out from under it. `git filter-branch`, despite being the deprecated/slower tool, respects an explicit revision range and only moves the one ref you point it at.

**Reasoning:** All 13 commits on this branch were unpushed and entirely local, making a scoped history rewrite low-risk and fully reversible up to that point (nothing external depended on the old hashes). Verified via `grep` across the full rewritten range that no trace of either secret remained, confirmed `git status` was clean and `npm test` still passed post-rewrite, then re-pushed successfully.

**Also encountered, smaller:** the AWS CLI's `--environment-variables` shorthand syntax silently mis-parses a value containing a comma (`NEXT_PUBLIC_MODELS`'s `"id:Name,id2:Name2"` format) as a list separator, throwing a `ParamValidation` type error. Fixed by switching to `--cli-input-json file://...` for that call instead of shorthand key=value,key=value syntax.

**Status:** PR #3 open (https://github.com/supersom/RAG-chat-agent/pull/3), branch pushed clean, live-verified against preview app `d2l47euepvccx6`: admin UI renders provider/API-key fields, saved keys are never re-exposed to the client (confirmed via accessibility-tree inspection, not just visual masking), chat correctly routes to the tenant's own provider using their own key (Anthropic-specific auth error confirmed the routing, not just a generic failure), and clearing the key correctly falls back to the main app's defaults.

**Takeaway:** never inline live-fetched command output (`aws ... get-*`, `kubectl get -o yaml`, etc.) directly into a committed file, even a plan/spec doc meant only to describe *what command to run* — use a placeholder and a "fetch fresh before running" note instead. And in a shared-`.git` worktree setup, `git-filter-repo`'s repo-wide default makes it the *wrong* tool for a scoped fix, even though it's the generally-recommended replacement for `filter-branch` in a normal single-checkout repo.

## 2026-07-24 — Main app auth actions surfaced in the chat nav

**Context:** After adding admin/end-user auth flows, the main chat surface still did not expose session actions directly. Admins had to know to navigate to `/admin`, and logged-in users did not have a visible logout control on the main app.

**Decision:** Add role-aware actions to `components/TopNavBar.tsx`: admins see `Manage` (links to `/admin`) and `Log out`; end users see `Log out`; logged-out visitors see no new auth action. Reused `components/LogoutButton.tsx` so logout behavior stays consistent with the admin layout, and added a small logout icon for recognizability.

**Status:** Implemented locally on `worktree-tenant-llm-config` and verified with `npm run typecheck` and `npm run lint`. Not pushed; no Amplify deploy triggered.

## 2026-07-24 — Admin chat sidebar now defaults to live CloudWatch logs

**Context:** While logged into an admin account on the main chat surface, CloudWatch logs were easy to miss because `components/RightSidebar.tsx` always initialized on the Knowledge Base tab and only started polling `/api/logs` when the CloudWatch Logs tab was active. The logs API itself is admin-gated and queries the logged-in tenant's configured `amplifyAppId`/`awsRegion`, so tenant metadata also determines which deployment's logs appear.

**Decision:** When the client session resolves to an admin user, automatically switch the right sidebar to the CloudWatch Logs tab and make the polling effect depend on `canViewLogs` as well as the active tab. This starts polling only after the admin session is known, and keeps non-admin users from polling the admin-only endpoint.

**Status:** Implemented locally on `worktree-tenant-llm-config` and verified with `npm run typecheck` and `npm run lint`. Not pushed; no Amplify deploy triggered.

## 2026-07-24 — Masked fields now have reveal controls

**Context:** Password and API-key inputs should be maskable by default but inspectable by the user when needed. `SettingsModal.tsx` already had a local secret-field eye toggle, but login/signup/admin-user password fields and the tenant LLM API-key field did not.

**Decision:** Add a reusable `components/ui/masked-input.tsx` control with `Eye`/`EyeOff` toggling, then use it for login password, admin signup password, admin user creation password, tenant API key, and the existing settings modal secret fields.

**Status:** Implemented locally on `worktree-tenant-llm-config` and verified with `npm run typecheck` and `npm run lint`. Not pushed; no Amplify deploy triggered.

## 2026-07-24 — Persistent activity history design

**Context:** Chat messages, assistant thinking, knowledge-base source references, and admin CloudWatch logs currently live only in client-side React state. Navigating away, refreshing, logging out, or logging back in loses them. The requested behavior needs durable, per-user history plus admin visibility across users in the same tenant, with a hard guarantee that cross-tenant logs are never exposed.

**Decision:** Document a server-side activity-history design in `docs/superpowers/specs/2026-07-24-persistent-activity-history.md`. The recommended path is a new tenant-keyed DynamoDB activity table, writes from trusted server routes such as `/api/chat`, reads scoped only from the signed NextAuth session, and replacing the admin-facing raw CloudWatch sidebar with persisted tenant-scoped structured app logs. Raw Amplify CloudWatch logs are app-level, so they are not safe as the durable tenant activity feed unless every event is structured, tenant-tagged, sanitized, and filtered server-side.

**Status:** Implemented locally in stagewise commits on `worktree-tenant-llm-config`. The branch now defines the activity DynamoDB table/IAM/env wiring, persists authenticated chat turns and sanitized app logs from `/api/chat`, exposes a session-scoped `/api/activity` read API, hydrates chat/thinking/KB/admin activity-log UI from persisted activity, and includes tenant-isolation tests. Not pushed; no Amplify deploy triggered. Deployment still requires applying the Terraform table/IAM change and provisioning `DYNAMODB_ACTIVITY_TABLE` on the target Amplify app before pushing/deploying.

## 2026-07-24 — Persistent activity history implemented

**Context:** The durable activity-history design above needed to become actual app behavior without using raw app-level CloudWatch as the tenant-visible feed.

**Decision:** Add `CustomerSupportAgent-Activity` as a tenant-keyed DynamoDB table with a `tenantUserId-createdAt-index`, expose `session.user.id`, write authenticated chat turns and sanitized `app_log` records from `/api/chat`, add `/api/activity` with tenant/user scoping, and hydrate `ChatArea`, `LeftSidebar`, and `RightSidebar` from persisted activity. The visible admin log tab is now an Activity Logs feed backed by tenant-scoped records instead of raw CloudWatch events. End users receive only `chat_turn` records from the activity API; admins can read tenant-wide activity and filter to same-tenant users.

**Status:** Implemented locally and verified with typecheck, lint, and the full Vitest suite. Not pushed; no Amplify deploy triggered. Before live verification, apply/provision the new activity table and `DYNAMODB_ACTIVITY_TABLE` env var in the target Amplify environment.

## 2026-07-24 — Persistent activity history deployed to preview

**Context:** Pushing `worktree-tenant-llm-config` triggers Amplify deployment for preview app `d2l47euepvccx6`. The activity-history code required the new `CustomerSupportAgent-Activity` table, its `tenantUserId-createdAt-index`, IAM access for the existing service user, and `DYNAMODB_ACTIVITY_TABLE` in Amplify.

**Decision:** Pushed the branch and let Amplify deploy commit `25d24e3`. Terraform was not applied from this worktree because the local state was not connected to the already-imported resources; `terraform plan` wanted to create 20 resources, not just the activity table. Instead, provisioned only the missing activity table via AWS CLI in `us-east-2`, enabled TTL on `expiresAt`, and updated the existing `DynamoDBTenantsUsersAccess` inline policy for `claude-qkstart-bedrock` to include the activity table and index ARNs. `DYNAMODB_ACTIVITY_TABLE=CustomerSupportAgent-Activity` was already present at the Amplify app level.

**Status:** Amplify job 7 succeeded for `25d24e3`. `CustomerSupportAgent-Activity` and `tenantUserId-createdAt-index` are ACTIVE, TTL is enabled, the app homepage returns 200, and unauthenticated `/api/activity` returns 401 as expected.

## 2026-07-24 — Activity history follow-up fixes

**Context:** After deploying persistent activity history, three behavior gaps surfaced: the Knowledge Base sidebar showed only one source even when Bedrock retrieved multiple relevant chunks, Activity Logs appeared empty on normal successful chats, and the admin activity API exposed a partial/non-UI-backed path for browsing other users' chat records.

**Decision:** Return up to the requested number of RAG sources from `retrieveContext()` instead of slicing to one. Write a sanitized `app_log` record for successful chat turns and guardrail blocks so the admin Activity Logs tab has tenant-scoped events without exposing chat text. Cut the partial admin chat-record browsing path from `/api/activity`: normal activity reads are scoped to the signed-in user's own chat records for both admins and end users, while admins can request `kind=app_log` for tenant-wide sanitized app logs.

**Status:** Implemented locally and verified with typecheck, lint, and the full Vitest suite. Not pushed; no Amplify deploy triggered.

## 2026-07-24 — Chat nav identity context

**Context:** The chat screen should make the active actor and tenant obvious, especially while testing authenticated admin/end-user sessions versus anonymous embed-token sessions.

**Decision:** Add a compact top-right identity block to `TopNavBar`. Authenticated sessions show the session name/email/id, role (`Admin` or `User`), and `session.user.tenantId`. Anonymous sessions show `Anon` and decode the tenant id from the same embed token source used by chat (`meta[name=tenant-token]`, `?t=`, or the development settings token).

**Status:** Implemented locally and verified with typecheck and lint. Not pushed; no Amplify deploy triggered.

## 2026-07-24 — Rich activity logs, message timestamps, and multi-document KB upload

**Context:** Activity Logs were missing much of the lifecycle detail that still appeared in CloudWatch, chat messages had no durable timestamps, and `/admin/knowledge-base` only supported uploading a single file at a time.

**Decision:** Add structured `app_log` records throughout `/api/chat` for request receipt, LLM config resolution, input/output guardrail checks, RAG retrieval, LLM generation, response parsing, and completion timing. Chat turns now persist separate user/assistant message timestamps and the chat UI renders them when hydrating from activity history. The knowledge-base admin upload UI now supports multi-file selection plus local folder selection, uploads every selected item, flattens S3 keys to sanitized filenames, and adds a six-character hash suffix only when a selected batch would otherwise collide after flattening.

**Status:** Implemented locally on `worktree-tenant-llm-config` and verified with `npm run typecheck`, `npm run lint`, and `npm test`. Not pushed; no Amplify deploy triggered.

## 2026-07-24 — Sidebar history ordering and scroll alignment

**Context:** Chat history already rendered chronologically and stayed aligned to the latest message at the bottom, but Assistant Thinking and Knowledge Base history rendered newest-first at the top. Activity Logs also rendered newest-first but were auto-scrolled to the bottom, hiding the latest events.

**Decision:** Render Assistant Thinking and Knowledge Base history chronologically by reversing the newest-first activity query slice and appending live updates, then scroll those panels to the bottom when content changes. Keep Activity Logs newest-first, but scroll them to the top so the latest tenant-scoped log records stay visible.

**Status:** Implemented locally on `worktree-tenant-llm-config` and verified with `npm run typecheck`, `npm run lint`, and `npm test`. Not pushed; no Amplify deploy triggered.

## 2026-07-24 — Activity log metadata details

**Context:** Activity Logs showed high-level lifecycle events, but not enough of the operational context needed to diagnose tenant behavior from the UI: which LLM config was resolved, which provider/model was used, which Bedrock guardrail was checked, and which knowledge base was queried.

**Decision:** Add safe structured metadata helpers for LLM config, guardrails, and RAG retrieval. `/api/chat` now records provider/model/requested model/config source/allowed models, input/output guardrail source/id/version/region/checked text type/duration/block status, and knowledge-base id/region/requested result count/source counts. The Activity Logs sidebar now renders persisted metadata under each log line as compact key/value details. API keys, raw prompts, raw assistant responses, and retrieved snippets are still excluded from app logs.

**Status:** Implemented locally on `worktree-tenant-llm-config` and verified with `npm run typecheck`, `npm run lint`, and `npm test`. Not pushed; no Amplify deploy triggered.

## 2026-07-24 — Bedrock hybrid retrieval attempt reverted

**Context:** Exact-token queries such as arXiv IDs, error codes, tenant IDs, route names, and config keys are weak spots for pure semantic/vector retrieval because the important term is often a literal identifier rather than a concept. A live check against KB `SLXQFWWXPR` confirmed this: semantic retrieval for `What is 1406.2294 about?` did not return the source PDF named with `(1406.2294)`.

**Decision:** Tried `overrideSearchType: "HYBRID"` in the Bedrock `RetrieveCommand`, but the deployed KB returned `HYBRID search type is not supported for search operation on index SLXQFWWXPR`. Reverted the request override and the `requestedSearchType=HYBRID` activity metadata. This KB needs a separate keyword/BM25 index if the backing vector store cannot change.

**Status:** Reverted locally on `worktree-tenant-llm-config` and verified with `npm run typecheck`, `npm run lint`, and `npm test`. Not pushed; no Amplify deploy triggered.

## 2026-07-24 — SQLite FTS5 keyword index for KB uploads

**Context:** Bedrock `overrideSearchType: "HYBRID"` is not supported by the current knowledge-base backing store, but exact-token queries still need BM25-style keyword recall alongside vector retrieval. The app already has an admin upload flow followed by a Bedrock sync action.

**Decision:** Add a server-side SQLite FTS5 keyword index using `better-sqlite3`, with text/PDF extraction via `pdf-parse`. `/admin/knowledge-base` now sends the uploaded S3 keys to `/api/admin/kb/sync`; that route starts the Bedrock ingestion job and incrementally upserts those same objects into a per-tenant/per-KB SQLite index, then stores the `.sqlite` file in S3 under `.customer-support-agent/keyword-indexes/<tenant>/<kb>.sqlite` by default. Chat RAG now searches Bedrock vector results plus the S3-stored FTS index, merges results with reciprocal-rank fusion, and records vector/keyword source counts in activity metadata.

**Status:** Implemented locally on `worktree-tenant-llm-config` and verified with `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. Not pushed; no Amplify deploy triggered.

## 2026-07-24 — Keyword index reconciles from S3 on KB sync

**Context:** The first SQLite FTS5 implementation only indexed keys still present in the admin page's `uploadedKeys` state. That left Bedrock and SQLite out of sync after page refreshes, direct S3 uploads, external updates, or deletions.

**Decision:** Change `/api/admin/kb/sync` to reconcile the keyword index from the tenant knowledge-base S3 data source every time sync runs. The reconcile path lists supported S3 objects, excludes the reserved keyword-index prefix, compares each object against SQLite `documents` metadata (`s3_key`, `etag`, `size`, `last_modified`), indexes new/changed files, skips unchanged files, and deletes SQLite rows for objects no longer present in S3 after a complete scan. Changed files that become oversized or text-empty now have stale FTS rows removed. The admin UI now reports listed, changed/new, unchanged, deleted, indexed, skipped, partial, and error counts.

**Status:** Implemented locally on `worktree-tenant-llm-config` and verified with `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. Not pushed; no Amplify deploy triggered.

## 2026-07-24 — Chat generation failures return persisted fallback replies

**Context:** After the keyword-index deployment, admin chat attempts could show the client-side generic "something went wrong" message when `/api/chat` returned HTTP 500. CloudWatch showed the route could complete RAG and LLM generation but fail while parsing invalid JSON from the model. Because the client treats non-2xx responses as failed sends, the visible reply did not match the server fallback and activity hydration could appear missing.

**Decision:** Keep recording the underlying generation/parse failure as an `app_log`, but return the fallback assistant message as HTTP 200 with a stable response id, empty suggestions/categories, no redirect, debug data, and any already-retrieved RAG source headers. The existing server-side fallback chat persistence remains in place, so failed generation attempts still produce durable user/assistant activity records for authenticated users.

**Status:** Implemented locally on `worktree-tenant-llm-config` and verified with `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. Not pushed; no Amplify deploy triggered.

## 2026-07-24 — Compact chat history sent to `/api/chat`

**Context:** Admin accounts hydrate durable chat history, and the client was sending the entire rendered history back to `/api/chat` on every new message. Large persisted assistant payloads can exceed the route schema's per-message size limit and fail validation before the handler logs `Latest Query`, producing an immediate client-side generic failure and no saved turn.

**Decision:** Send a compact API conversation instead of the full UI history: keep only the last 12 useful messages, reduce assistant JSON payloads to their visible `response` text, cap each message at 7,000 characters, and log the compacted message count/character count in the browser console. `/api/chat` now logs validation issues before returning HTTP 400 so these failures are visible in CloudWatch.

**Status:** Implemented locally on `worktree-tenant-llm-config` and verified with `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. Not pushed; no Amplify deploy triggered.

## 2026-07-25 01:13 PDT — Chat crashing on cold starts: eager `pdf-parse` import in the chat hot path

**Context:** User reported the preview app at `worktree-tenant-llm-config.d2l47euepvccx6.amplifyapp.com` was "still going wrong." Reproduced live: sending any chat message returned "Sorry, something went wrong processing that message" with `/api/chat` returning HTTP 500. CloudWatch (`/aws/amplify/d2l47euepvccx6`) showed the actual failure: `ReferenceError: DOMMatrix is not defined`, thrown at module-load time inside `pdfjs-dist`, preceded by warnings that `@napi-rs/canvas` could not be loaded. Traced the import chain: `app/api/chat/route.ts` imports `retrieveContext` from `app/lib/rag.ts`, which imports `searchKeywordIndex` from `app/lib/kb-keyword-index.ts` (added in the 2026-07-24 SQLite FTS5 keyword-index work), which had a **top-level** `import { PDFParse } from "pdf-parse"`. `PDFParse` is only actually used inside `extractText()`, called only from `reconcileKeywordIndex()` (the KB-sync path) — `searchKeywordIndex()` (the chat-time path) never touches it. Because the import was static, every `/api/chat` request loaded the full `pdf-parse` → `pdfjs-dist` → `@napi-rs/canvas` chain regardless. `@napi-rs/canvas` is a native binary that doesn't work in the Amplify Compute Lambda runtime, so `pdfjs-dist`'s Node fallback throws `DOMMatrix is not defined` at import time — crashing the chat handler on every fresh Lambda container's first invocation, before the request was ever touched. Confirmed via CloudWatch: 3 identical crashes across 3 different log streams (3 different containers) within a 90-second window that morning.

**Decision:** Made the `pdf-parse` import lazy — `const { PDFParse } = await import("pdf-parse")` inside `extractText()`, only reached when actually parsing a `.pdf` during KB sync — instead of a static top-level import in `kb-keyword-index.ts`. One-line fix; no behavior change to KB sync itself.

**Verification:** `npx tsc --noEmit` and `npx eslint app/lib/kb-keyword-index.ts` both clean. Committed (`51f8e3c`) and pushed to `worktree-tenant-llm-config`, triggering Amplify job 15 (`SUCCEED`, 2026-07-25 01:10 PDT). Re-tested live in the browser post-deploy: sent a new chat message, got a normal HTTP 200 and a correct assistant reply ("The result of 2 + 2 is 4"), with clean RAG-retrieval and LLM-generation activity-log entries. Confirmed via CloudWatch that zero `DOMMatrix` errors occurred in the 5 minutes following the fixed request, versus 3 in the hour before.

**Open follow-up (not yet checked):** `@napi-rs/canvas` may still be broken in this Lambda runtime for its *intended* use — actual PDF parsing during KB sync (`reconcileKeywordIndex` → `extractText`) still calls `pdfjs-dist` when a `.pdf` is uploaded to a tenant's knowledge base. The chat crash is fixed because that path is no longer on the hot path, but a PDF KB upload itself has not been verified to succeed in this environment.

**Status:** Fixed and deployed on `worktree-tenant-llm-config` (commit `51f8e3c`, Amplify job 15, `SUCCEED`). Live-verified in production preview.

## 2026-07-25 01:36 PDT — PDF KB upload follow-up: two infra fixes, and the sync-timeout backlog item is now confirmed, not theoretical

**Context:** Follow-up to the `DOMMatrix` chat-crash fix above — needed to verify whether PDF knowledge-base uploads themselves actually work in this Amplify Compute runtime, since `@napi-rs/canvas` (the thing that broke chat) is the same dependency `extractText()` needs for real PDF parsing during KB sync. Tested end-to-end against the shared `claude-qkstrt-kb` S3 bucket (tenant `sdd-live-smoke-test`, KB `SLXQFWWXPR`) using the admin `/admin/knowledge-base` upload + sync UI.

**Finding 1 — S3 CORS was stale, blocking all browser uploads.** Uploading via the admin UI failed with "Failed to fetch"; the browser's presigned-PUT preflight got a 403. The bucket's CORS `AllowedOrigins` only listed `https://worktree-auth-multitenancy-guardrails.d2l47euepvccx6.amplifyapp.com` — the old, now-merged `auth-multitenancy-guardrails` branch's preview URL (see [[auth_multitenancy_guardrails_branch]]), never updated for any branch created since. **Fix:** updated `AllowedOrigins` to `https://*.d2l47euepvccx6.amplifyapp.com` (wildcard covers all preview branches under this Amplify app going forward) plus `https://kbsearch.somdutta.com` (the intended production custom domain). Applied by the user directly (`aws s3api put-bucket-cors`) after the sandbox's auto-mode classifier blocked Claude from writing to shared AWS infra directly — same workaround pattern as prior sessions (see [[feedback_sandbox_secret_blocks]]).

**Finding 2 — IAM policy `KBSourceBucketUploadAccess` only ever granted upload, never read.** With CORS fixed, the upload itself succeeded, but "Sync Knowledge Base" failed immediately: `AccessDenied ... claude-qkstart-bedrock is not authorized to perform: s3:ListBucket on resource: "arn:aws:s3:::claude-qkstrt-kb"`. The inline policy (named, accurately, `KBSourceBucketUploadAccess`) only had `s3:PutObject` on `claude-qkstrt-kb/*` and `css-agent-kb2-materiality-src/*` — never extended for read access when the SQLite FTS5 keyword-index sync feature was added on 2026-07-24. This also invalidated an earlier assumption in this session: prior successful PDF citations seen in chat activity logs (e.g. `Learning Statistics with R (lsr-0.5).pdf`) turned out to come from Bedrock's own vector ingestion (`keywordSourceCount=0`, `vectorSourceCount=3`) — a completely separate pipeline that doesn't touch `pdf-parse` at all. The custom keyword-index sync had in fact **never** completed successfully against this bucket. **Fix:** added `s3:GetObject` (alongside the existing `s3:PutObject`) and a new `s3:ListBucket` statement on the bucket ARNs themselves, applied by the user (`aws iam put-user-policy`) after the same classifier block.

**Finding 3 — `pdf-parse` itself does not crash; the sync times out instead, exactly as `BACKLOG.md` already anticipated.** With both fixes in place, re-running sync processed real PDFs from the shared corpus: CloudWatch showed 0 `ReferenceError`s despite 504 `Cannot load "@napi-rs/canvas"` warnings (one pair per file — confirms `extractText()`'s `PDFParse.getText()` doesn't need canvas rendering, so the missing native binary is cosmetic here, not fatal). But two consecutive sync Lambda invocations each ran for **exactly 28,002ms** and were killed by the Amplify Compute execution timeout — because no `.sqlite` keyword index had ever existed in S3 (blocked by Finding 2 until now), `downloadExistingIndex` found nothing on this first-ever successful-auth run, so `reconcileKeywordIndex` treated all ~2,000 objects in the shared bucket as new and tried to extract text from every one of them in a single request. Since the `.sqlite` file is only written back to S3 once, at the end of the full loop, the timeout discards all extracted work with nothing persisted — meaning **every retry will fail identically and re-burn the same S3-GET/compute cost** until the sync is chunked or backgrounded. Stopped retrying rather than keep re-running an operation known to fail the same way.

**Status:** Chat-hot-path fix (`51f8e3c`) is unaffected and remains verified working. CORS and IAM fixes applied directly against AWS (not app code, no commit). PDF sync itself is now confirmed blocked by a real scaling issue, not a code defect in the parsing logic — see elevated backlog item below.

## 2026-07-25 02:08 PDT — Keyword-index sync checkpointing implemented, TDD, and verified live; corrects the "pdf-parse doesn't crash" claim above

**Context:** Direct follow-up to the confirmed-but-unfixed backlog item from the 01:36 PDT entry above. Implemented resumable/checkpointed reconciliation for `reconcileKeywordIndex` (`app/lib/kb-keyword-index.ts`) so a timeout no longer discards all progress, per explicit product decision to keep resume state inside the `.sqlite` file itself (no sidecar).

**Decision:** Added two tables to the same SQLite schema that already round-trips through S3 — `reconcile_run` (accumulated counters: listed/changed/unchanged/deleted/indexed/chunk/skipped counts, the original listing's own `partial` flag, and a JSON `errors` array) and `reconcile_queue` (the remaining S3 objects still needing processing, keyed by `s3_key`). `reconcileKeywordIndex` now takes optional `timeBudgetMs`/`now` params (env `KEYWORD_INDEX_TIME_BUDGET_MS`, default 20s, when not passed). On a **fresh** invocation (no `reconcile_run` row present) it lists the bucket once, runs the stale-object deletion sweep, and seeds the queue with changed/new objects — all one-time work that a **resumed** invocation (a `reconcile_run` row already exists) skips entirely, going straight to draining the queue. The per-object processing loop checks the time budget before each item; hitting it breaks the loop with items still queued, persists the run/queue state, and the `.sqlite` file gets uploaded to S3 either way (partial or complete) — so a checkpoint is just "upload the file," never a separate write path. `partial` in the response is `true` whenever either the original listing was itself capped (`KEYWORD_INDEX_MAX_RECONCILE_OBJECTS`) or the queue still has remaining items.

`POST /api/admin/kb/sync` now accepts `{ resumeKeywordIndexOnly: true }` so a resume round doesn't also restart the Bedrock ingestion job (`startKbIngestion`) — only the initial sync call does that. `components/admin/KnowledgeBaseManager.tsx` auto-calls itself (`runKeywordIndexSync`) with that flag while the last response reported `partial && mode === "reconcile" && !error`, so a full reconcile of a large bucket now surfaces to the admin as one "Syncing..." state spanning several small requests instead of a single one that times out.

**TDD:** `app/lib/kb-keyword-index.test.ts` — round 1 with a 0ms time budget processes zero objects and checkpoints both as pending (`partial: true`, `indexedObjectCount: 0`); round 2 with a generous budget resumes and finishes both, with a single `ListObjectsV2Command` call across *both* rounds proving resume never re-lists or re-runs change-detection. Watched it fail for the right reason first (no `timeBudgetMs`/`now` params existed, no checkpointing behavior — round 1 just processed everything). Needed one supporting infra fix to make `kb-keyword-index.ts` testable at all: it (like `rag.ts`) imports Next.js's `"server-only"` marker, which isn't a real resolvable npm package outside Next's own build pipeline — added `test/stubs/server-only.ts` (inert `export {}`) aliased in `vitest.config.ts`, benefiting any future test of `rag.ts` too.

**Verification:** `npx tsc --noEmit` clean, `next lint` clean, full suite 47/47 passing, `next build` clean. Committed `3d37bab`, pushed, Amplify job 16 `SUCCEED`. Live-retested against the real `claude-qkstrt-kb` bucket (~1,831 changed/new objects): 8 consecutive checkpointed rounds observed in CloudWatch, each **~20-22 seconds** (`21948ms`, `20680ms`, `21058ms`, `20384ms`, `20569ms`, `20382ms`, `20423ms`, `20589ms`) — comfortably under the platform's execution limit, **zero timeouts**, progress correctly accumulating across rounds in the UI (2 indexed → grew each round, never reset). Stopped the run by navigating away rather than let it churn through the full corpus against a bucket shared with another organization; confirmed via CloudWatch that no further rounds fired after navigating away (exactly 8, none after) — checkpointing means an interrupted resume loses nothing, it just needs re-triggering later.

**Correction to the 01:36 PDT entry's "pdf-parse itself does not crash" claim:** that check grepped CloudWatch for the literal string `ReferenceError`, which only catches *uncaught* crashes reported by Next's own crash formatter — it missed errors caught by `extractText()`'s own per-object `try/catch` inside the processing loop, which never gets logged to CloudWatch as `ReferenceError:` text (it's collected into `run.errors` and returned in the JSON response instead). This live run exposed that gap: of the objects actually attempted across the visible rounds, **only 2 succeeded**; the remainder errored with `DOMMatrix is not defined` for real academic PDFs (`1.0_Diligence_Summary.pdf`, `20200330_COVID-19_India_Perspective_2.0.pdf`, conference-slide PDFs, etc.). The synthetic single-line-text PDF used for the earlier verification apparently never touched whatever `pdfjs-dist` code path real-world PDFs (embedded images, complex fonts/forms) hit that still needs a working canvas even for `getText()`-only extraction. So: the crash is fixed, the timeout is fixed, but **PDF text extraction for the keyword index is still effectively non-functional for most real PDFs** in this Amplify Compute runtime, because `@napi-rs/canvas`'s native binary genuinely doesn't load here. This is a distinct, still-open problem — see backlog.

**Status:** Checkpointing fix implemented, tested, deployed, and live-verified working exactly as designed. PDF-extraction-vs-canvas problem newly confirmed with real data (not fixed this session) — see `BACKLOG.md`.

## 2026-07-25 02:21 PDT — Pure-JS DOMMatrix polyfill fixes real-world PDF extraction, sidestepping the broken `@napi-rs/canvas` native binary entirely

**Context:** Direct follow-up to the PDF-extraction finding from the entry above. Read `pdfjs-dist@5.4.296`'s actual Node source (`node_modules/pdfjs-dist/legacy/build/pdf.mjs`) to find the precise mechanism: it only sources `globalThis.DOMMatrix` (and `ImageData`/`Path2D`) from `@napi-rs/canvas` when `globalThis.DOMMatrix` isn't already set — `if (!globalThis.DOMMatrix) { canvas = require("@napi-rs/canvas"); ... }`. `DOMMatrix` is used for internal 2D transform math while walking a PDF's content stream (text positioning, plus apparently code touched by image/annotation operators) — not for actual pixel rendering, which is why a trivial single-line-text synthetic PDF never hit it while real-world PDFs (embedded images, complex layouts) reliably did.

**Decision:** Since pdfjs-dist only checks truthiness, priming `globalThis.DOMMatrix` ourselves *before* `pdf-parse` loads makes it skip the broken `@napi-rs/canvas` require entirely — the native-binary/architecture-mismatch problem becomes irrelevant rather than something to actually solve. Added `@thednp/dommatrix` (the maintained fork of the deprecated `dommatrix` package — npm flagged the deprecation during install, switched immediately; pure JS, zero dependencies, spec-compliant `DOMMatrix` API surface confirmed by inspecting its source before adopting) as a dependency. New `ensureDOMMatrixPolyfill()` helper in `kb-keyword-index.ts`, called at the top of the `.pdf` branch of `extractText()` (same lazy code path already isolated from the chat hot path by the 2026-07-25 01:13 PDT fix): sets `globalThis.DOMMatrix` from `@thednp/dommatrix`'s default export only if not already present, once per warm Lambda container.

**TDD:** `app/lib/kb-keyword-index.test.ts` — exported `extractText` for direct testing. Test 1: deletes `globalThis.DOMMatrix`, calls `extractText` on a minimal synthetic PDF, asserts the global now === the `@thednp/dommatrix` shim. Watched it fail for the right reason first — in this local sandbox `@napi-rs/canvas` actually loads fine (matching local architecture), so pdfjs-dist's own fallback won the assignment before this fix existed (`[Function DOMMatrix]` from `@napi-rs/canvas`, not `[Function h]` from our shim) — a useful confirmation that the two code paths really do race for the same global. Test 2: pre-sets a sentinel `DOMMatrix`, confirms `extractText` doesn't clobber an already-present one.

**Verification, and an honest limitation of the unit test:** because `@napi-rs/canvas` already works in this local dev sandbox, calling `extractText` against real production PDFs locally succeeds regardless of whether this fix is present — the unit test can't discriminate "our polyfill fixed it" from "the environment was never broken here" for actual extraction success, only for the specific global-assignment behavior. So: pulled the two real PDFs that failed live in the previous entry (`1.8_Diligence_Summary.pdf`, `20200330_COVID-19_India_Perspective_2.0.pdf`) from `claude-qkstrt-kb` via `aws s3 cp` and ran `extractText` against them directly (scratch test file, not committed) — both now extract real text (676 and 35,130 characters respectively, readable and correct: "The 4Ds: Diligence Diligence is taking responsibility for..." / "30 MARCH 2020 COVID-19 India Perspective 2.0..."). `npx tsc --noEmit`, `next lint`, full suite (49/49), and `next build` all clean. The real discriminating test — proving this actually fixes the broken Lambda runtime, not just "works because local canvas happens to work" — is the live re-sync against `claude-qkstrt-kb` after deploy.

**Status:** Implemented, unit-tested, and sanity-verified against real PDF content locally. Committed alongside the checkpointing fix's devlog/backlog updates. Live deploy + re-sync verification pending as the next step.

## 2026-07-25 02:35 PDT — DOMMatrix fix live-verified (0 errors); unblocked a second, distinct pdfjs-dist bundling bug, root-caused and fixed the same way

**Context:** Deployed the DOMMatrix polyfill fix (commit `b1390d6`, Amplify job 17) and re-ran the live sync against `claude-qkstrt-kb`. CloudWatch confirmed **zero** `DOMMatrix is not defined` occurrences in the new run (down from 600+ before) — the polyfill fix is genuinely verified working in the actual broken Lambda runtime, not just locally where `@napi-rs/canvas` happens to already work. But every attempted PDF now failed with a *different* error: `Setting up fake worker failed: "Cannot find module '/var/task/.next/server/chunks/pdf.worker.mjs' imported from /var/task/.next/server/chunks/1774.js"`.

**Root cause, again located by reading `pdfjs-dist`'s actual source rather than guessing:** pdfjs-dist's `PDFWorker` class auto-detects Node.js at static-init time and sets `#isWorkerDisabled = true` — the "fake worker" (running the worker's message handler in-process instead of a real Worker thread) is the *intended* Node code path, not a fallback failure. `#setupFakeWorkerGlobal` first checks `globalThis.pdfjsWorker?.WorkerMessageHandler`, and only if that's absent falls back to `await import(this.workerSrc)`, where `workerSrc` defaults to the *relative, runtime string* `"./pdf.worker.mjs"`. That relative specifier resolves fine when pdfjs-dist runs unbundled (the file sits right next to `pdf.mjs` in `node_modules`), but Next's output file tracing can't follow a runtime-computed import specifier, so `pdf.worker.mjs` never gets copied into the deployed Lambda bundle — hence "Cannot find module" in production only, never locally.

**Decision:** Same pattern as the DOMMatrix fix — pdfjs-dist checks a global before attempting its own broken resolution, so pre-populate that global ourselves. Added `ensurePdfWorkerHandler()`: dynamically imports `pdfjs-dist/legacy/build/pdf.worker.mjs` using a **static, literal** specifier (unlike pdfjs-dist's own runtime-variable specifier, this one *is* traceable by Next's bundler, confirmed by testing the import resolves via plain Node both locally and via bundler-friendly module resolution) and assigns `globalThis.pdfjsWorker = { WorkerMessageHandler }` before `pdf-parse` loads. Needed one supporting fix: added `app/lib/pdfjs-worker.d.ts`, an ambient module declaration, since pdfjs-dist doesn't publish a `.d.ts` for that specific worker subpath (only its top-level entry is typed).

**TDD:** Same two-test shape as the DOMMatrix fix (install-when-absent, don't-clobber-when-present), asserting on `globalThis.pdfjsWorker.WorkerMessageHandler`. Watched it fail for the right reason first: pdfjs-dist never sets that global itself (it only *reads* it as an optional override), so before this fix the assertion correctly found `undefined` regardless of environment — an honestly environment-independent RED, unlike the DOMMatrix test's RED which depended on local `@napi-rs/canvas` happening to already work.

**Verification:** `npx tsc --noEmit`, `next lint`, full suite (51/51), `next build` all clean. Deployed (commit pending push at time of writing) — live re-sync verification against `claude-qkstrt-kb` is the next step, same as the two fixes before it.

**Status:** Implemented and unit-tested. This is now two layers of a genuinely multi-layered "pdfjs-dist doesn't work out of the box in a Next.js serverless bundle" problem, each fixed by the same technique (pre-populate the global pdfjs-dist checks before it tries its own broken resolution). Not treating this as a red flag to stop and reconsider architecture (per the "3+ fixes fail, question everything" heuristic) since each fix has *worked* at eliminating its specific error, not failed and required another attempt at the same problem — it's a legitimately layered compatibility gap, being unwound one confirmed layer at a time.

## 2026-07-25 02:42 PDT — Worker fix live-verified (0 errors); tightened the checkpoint time budget after a genuine near-miss

**Context:** Deployed the worker-handler fix (commit `f348538`, Amplify job 18) and re-ran the live sync. CloudWatch confirmed **zero** `fake worker` and **zero** `DOMMatrix` errors since this deploy — both pdfjs-dist bugs are genuinely fixed in the real broken Lambda runtime. The UI's error list still showed the two previously-known-failing PDFs, but those turned out to be stale entries: `reconcileKeywordIndex`'s checkpointing persists `run.errors` across resumed rounds, and this sync resumed a `reconcile_run`/`reconcile_queue` left over from the *previous* (pre-worker-fix) attempt, in which those two specific files had already been dequeued-with-error before the fix landed — they won't be retried until a genuinely fresh (non-resumed) listing cycle. Meanwhile 8 *new* files (not previously attempted) indexed successfully with 522 chunks in this run, which is the real signal.

**A genuine new failure, not stale-data noise:** the resume chain stopped with "Failed to start sync" after CloudWatch showed a real platform-level `Request timed out - your application took too long to respond` — not our graceful 20s-budget checkpoint. The round immediately before it had already run **28,005ms**, right at the wall the original scaling bug's timeouts hit (`28,002ms`, twice, back in the 01:36 PDT entry). Root cause: the time-budget check only runs *between* objects, not preemptively during one — so a single slow object (a multi-megabyte PDF takes multiple seconds to download, parse, and chunk) can push a round well past a 20s soft budget before the loop gets another chance to check the clock, right up against the real ~28-30s wall with very little margin left.

**Decision:** Lowered `DEFAULT_TIME_BUDGET_MS` from 20s to 12s — a one-line, evidence-based tuning change (not a new behavior), giving a large single-object overrun much more room before hitting the real limit. No test changes needed since all existing tests already pass `timeBudgetMs` explicitly rather than relying on the default.

**Verification:** `npx tsc --noEmit`, `next lint`, full suite (51/51) all clean.

**Status:** Implemented. Deploy and final live confirmation pending as the next step — want to see a full corpus pass complete with zero real timeouts before considering the whole PDF-extraction chain closed.

## 2026-07-25 02:57 PDT — 12s budget alone didn't fix the timeout; root-caused to a single pathological PDF, added a size cap

**Context:** Deployed the 12s time-budget tuning fix and re-ran the live sync. It did **not** help: the resume chain hit a real platform timeout again (`Request timed out`) after a round had already run **28,004.90ms** — essentially identical to the original crash pattern, despite the lower budget. This exposed that the earlier fix addressed the wrong layer: the time-budget check only runs *between* objects in the loop, never *during* one, and JavaScript's single-threadedness means a long synchronous PDF parse can't be interrupted from within the same process no matter how low the between-object budget is set.

**Investigation:** Downloaded the checkpointed `.sqlite` index directly from S3 (`aws s3 cp`) and read `reconcile_queue` to find exactly which object the failed round was about to process next — `pdfs/Debugging Tools for Windows (WinDbg, KD, CDB, NTSD).pdf`, 21MB, sitting first in queue order. Pulled it and timed `extractText` directly: **54,094ms**, extracting 4.5 million characters. For comparison, pulled two more real PDFs at different sizes to calibrate rather than guess: a 5MB paper extracted in ~2s, a 9.3MB reference manual in ~7.3s — both comfortably safe. The jump from 9.3MB(7.3s) to 21MB(54s) is clearly super-linear, not a simple size proportionality, so the danger zone starts somewhere between those two points.

**Decision:** Per explicit product decision (identify and skip the specific problem file(s), rather than build a real per-object hard timeout via `worker_threads`, and rather than accept the limitation as-is) — added a PDF-specific size cap, separate from the existing general `maxObjectBytes` (50MB, which already correctly skips several even-larger files in this same bucket, e.g. a 99MB one, but was too permissive to catch this 21MB case). Set to 12MB by default (`KEYWORD_INDEX_MAX_PDF_BYTES` env override), chosen from the calibration data with margin below where the measured blowup began; checked against the actual remaining queue (1,360 objects) — this only excludes 49 PDFs (~3.6%), not the 105-263 a more conservative threshold would have caught. Only applies to `.pdf`; other extensions parse near-instantly regardless of size via a plain `buffer.toString("utf8")`, so they were never at risk. The check happens against the S3-listing-provided size metadata *before* downloading, so an oversized PDF is never even fetched.

**TDD:** `app/lib/kb-keyword-index.test.ts` — one queued 20MB PDF and one 1KB PDF; asserts the large one is skipped and *never downloaded* (`GetObjectCommand` never called for its key) while the small one is indexed normally. Watched it fail for the right reason first (no size-based PDF filtering existed yet, so both got downloaded and the large one counted as indexed via the mock rather than skipped).

**Verification:** `npx tsc --noEmit`, `next lint`, full suite (52/52), `next build` all clean.

**Status:** Implemented and unit-tested. Deploy and a full live corpus pass (checking for zero real timeouts end to end, not just absence of `DOMMatrix`/`fake worker` errors) is the next and hopefully final step in this chain.

## 2026-07-25 03:04 PDT — Full PDF-extraction fix chain confirmed live: chain closed

**Context:** Deployed the PDF size cap (commit `4358bdd`, Amplify job 20) and re-ran the live sync against `claude-qkstrt-kb` for several rounds. Progress climbed cleanly across the run (8 → 23 indexed, 522 → 1,147 chunks, `skippedObjectCount` 3 → 5 — the size cap catching the known-bad large PDFs) with no new errors added beyond the stale ones already carried over from before these fixes existed.

**Verification:** CloudWatch across the deploy window showed round durations of **12,870ms / 12,876ms / 13,710ms / 14,858ms / 16,064ms** — all comfortably bounded near the 12s soft budget, nowhere close to the ~28-30s platform wall — and **zero** `"timed out"` events. Stopped the run by navigating away (same pattern as every other live check this session); confirmed via CloudWatch that no further rounds fired afterward (settled at 5, none after).

**Status: this closes the PDF-extraction chain from the 01:36 PDT entry onward.** Four fixes, each confirmed live against the actual broken production environment rather than assumed from local testing (which repeatedly could not reproduce these bugs, since this sandbox's `@napi-rs/canvas` happens to work and its filesystem doesn't have Next's bundling gap):
1. `DOMMatrix` polyfill (`b1390d6`) — 0 `DOMMatrix` errors, down from 600+.
2. `pdf.worker.mjs` bundling fix (`f348538`) — 0 `fake worker` errors.
3. Time budget tightened 20s→12s (`adf973a`) — necessary but insufficient alone.
4. PDF size cap (`4358bdd`) — closed the gap fix #3 couldn't: a single pathological object's synchronous processing time, which no between-object budget can protect against.

Remaining, not addressed and not blocking: the ~1,360-object corpus will take many more checkpointed rounds (12-16s each) to fully drain via repeated manual "Sync Knowledge Base" clicks or the UI's auto-resume; nothing currently triggers that to completion unattended. That's the pre-existing, still-open "async/background job" backlog item, now with a much healthier per-round cost than when it was first identified.

