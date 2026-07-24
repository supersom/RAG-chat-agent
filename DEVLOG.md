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

**Status:** Design documented locally. Implementation is backlogged because it requires a new table, IAM/env provisioning, persistence helpers, new APIs, UI hydration, and cross-tenant regression tests. Not pushed; no Amplify deploy triggered.

