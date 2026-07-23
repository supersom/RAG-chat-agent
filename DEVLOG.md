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
