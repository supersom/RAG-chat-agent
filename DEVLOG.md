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
