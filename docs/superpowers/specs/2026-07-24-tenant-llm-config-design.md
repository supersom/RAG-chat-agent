# Per-tenant LLM provider/key/model configuration

**Date:** 2026-07-24
**Branch:** `worktree-tenant-llm-config`
**Target deployment for QA:** Amplify app `d2l47euepvccx6`

## Problem

Every tenant currently shares whatever LLM credentials the main deployment has
configured via server env vars (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
`OPENROUTER_API_KEY`), plus a temporary, insecure stopgap where a
client-supplied `apiKey` in the `/api/chat` request body is trusted *ahead of*
the server's own key (added only because this deployment had no real
server-side key provisioned; flagged in `BACKLOG.md` for removal).

Tenants need to be able to configure their own LLM provider, API key, and a
list of allowed models, which take precedence over the main app's defaults
when present. Tenants that don't configure their own should keep working
exactly as they do today.

## Resolution order

For a given chat request, provider + API key + model + allowed-models list
are resolved **as one bundle**, never mixed across tiers (using tenant A's
provider with the server's key, for example, would silently call the wrong
API with the wrong credential shape):

1. **Tenant config** — if the tenant has an API key configured, use its own
   `provider`, `apiKey` (decrypted), `model`, and `allowedModels`.
2. **Main-app server defaults** — whichever of `OPENAI_API_KEY` /
   `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` is set server-side (same
   priority order used today), with `model`/`allowedModels` parsed from
   `NEXT_PUBLIC_MODELS`.
3. **Client-supplied key** — the existing dev-only Settings-modal key,
   used only if neither tier above has a key. Gated server-side on
   `NEXT_PUBLIC_APP_ENV === "development"` — the same flag that already
   gates the Settings-modal UI (`SettingsModal.tsx`), not just hidden in the
   client as today. Deliberately **not** gated on `NODE_ENV`: `NODE_ENV` is
   always `"production"` for any `next build`, including this repo's own
   preview Amplify deployments (verified against app `d2l47euepvccx6`, which
   sets `NEXT_PUBLIC_APP_ENV=development` while running a real production
   build) — gating on `NODE_ENV` would make tier 3 permanently unreachable
   everywhere, defeating the purpose of the preview/test escape hatch this
   tier exists for.

A tenant's LLM config is all-or-nothing: if an admin sets an API key, they
must also set provider and model in the same saved state, otherwise the
config is ambiguous (which model would an API key with no model call?). The
PATCH endpoint validates this against the *merged* tenant record and rejects
partial configurations with a 400.

## Schema change

`app/lib/db/schema.ts` — `llmProviderDefaults` becomes fully optional/partial:

```ts
llmProviderDefaults?: {
  provider?: "openai" | "anthropic" | "openrouter";
  apiKeyCiphertext?: string; // AES-256-GCM, never leaves the server
  model?: string;
  allowedModels?: string[];
}
```

This also fixes a latent bug: `app/api/admin/signup/route.ts` currently
hardcodes `provider: "openai", model: "gpt-4o-mini"` for every new tenant,
which breaks signups on a deployment configured for a different provider
only. New tenants get an empty `llmProviderDefaults` and inherit main-app
defaults (tier 2) until an admin configures their own.

## Encryption

New `app/lib/tenant-secrets.ts`:

- AES-256-GCM via Node's built-in `crypto` module.
- Key derived from a new `TENANT_SECRETS_KEY` env var (32-byte, base64),
  same pattern as the existing `AUTH_SECRET`/`TENANT_JWT_SECRET`.
- `encryptApiKey(plaintext: string): string` /
  `decryptApiKey(ciphertext: string): string`, ciphertext stored as
  `base64(iv + authTag + ciphertext)`.
- Throws if `TENANT_SECRETS_KEY` is missing at encrypt/decrypt time — a
  missing key at that point is a genuine deployment misconfiguration, not a
  recoverable state.

## Admin UI (`components/admin/TenantSettingsForm.tsx` + `/api/admin/tenant`)

- Add a provider `<select>` (openai / anthropic / openrouter).
- Add a masked API-key field (reuse the `SecretField` pattern from
  `SettingsModal.tsx`) — write-only. `GET /api/admin/tenant` never returns
  the real key or ciphertext, only `apiKeyConfigured: boolean`.
- Submitting an empty string clears the stored key; omitting the field
  leaves it unchanged.
- `PATCH` extends the zod schema with the provider enum and an optional,
  nullable `apiKey` string; after merging with the existing record, if the
  result has a key but is missing provider or model, respond 400.

## `/api/chat/route.ts`

Replace the current
`resolvedApiKey = clientApiKey || process.env.OPENAI_API_KEY || ...` chain
with a single `resolveLlmConfig(tenant, clientApiKey)` call implementing the
three-tier order above. The `"id:Name,id2:Name2"` model-list parser
currently duplicated inline in `ChatArea.tsx` gets extracted into a shared
util (e.g. `app/lib/models.ts`) so client and server agree on the format.

## Deployment

`TENANT_SECRETS_KEY` needs to be added to:

- `.env.example` (documented, not a real value)
- `amplify.yml`'s build-time `echo ... >> .env.production` block
- Provisioned directly as an env var on Amplify app `d2l47euepvccx6` — per
  `DEVLOG.md`'s 2026-07-24 entry, new required env vars do not propagate
  anywhere except wherever they're explicitly provisioned; provisioning
  against one app does not cover another.

## Testing

- Extend `app/lib/tenant.test.ts` for the three-tier resolution, including
  the partial-config rejection case (tenant has a key but merged result is
  missing model/provider) and the prod-gating of tier 3.
- New unit tests for `tenant-secrets.ts`: encrypt/decrypt round-trip,
  tamper detection (auth tag), missing-key-env error path.

## Out of scope

The chat UI's model dropdown (`ChatArea.tsx`) sources its list from
`NEXT_PUBLIC_MODELS`/browser localStorage, not the signed-in tenant's actual
`allowedModels` — a pre-existing gap, not something this feature introduces
or fixes. Tracked in `BACKLOG.md` instead.
