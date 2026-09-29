# AIRO encrypted sync Worker

This directory contains the optional Cloudflare Worker used by AIRO's development-branch sync milestone. The npm package does not need this service for routing, orchestration, portable archives, or local learning.

The CLI completes GitHub's device flow directly. It sends the resulting short-lived GitHub token once to the Worker, which validates the account with GitHub and discards the token. The Worker stores only hashes of AIRO session tokens and persists opaque encrypted event and setting envelopes in D1. Encryption and recovery-key handling happen in the CLI. Provider credentials, API keys, executable paths, permission settings, and Jev consent are outside the sync schema.

Deploy the Worker under an application-owned HTTPS URL and configure that URL explicitly in the client. This does not make sync part of the currently published npm package.

## Provisioning

1. Create a GitHub OAuth App, enable Device Flow, and retain its client ID and client secret.
2. Authenticate Wrangler and create the database:

   ```bash
   pnpm exec wrangler login
   pnpm exec wrangler d1 create airo-sync
   ```

3. Replace the placeholder D1 database ID and GitHub client ID in `wrangler.jsonc`. Use a separate GitHub OAuth App and D1 database for each environment.
4. Store the OAuth app secret as a Worker secret. For local development, copy `.dev.vars.example` to `.dev.vars` and replace its placeholder:

   ```bash
   pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --config sync-worker/wrangler.jsonc
   ```

5. Apply the migrations and deploy:

   ```bash
   pnpm exec wrangler d1 migrations apply airo-sync --remote --config sync-worker/wrangler.jsonc
   pnpm exec wrangler deploy --config sync-worker/wrangler.jsonc
   ```

The GitHub client ID is public OAuth configuration. The client secret is used only by the Worker to call GitHub's pinned `2022-11-28` OAuth token-check endpoint and prove that an incoming token belongs to this OAuth app; keep it in a Worker secret, never `wrangler.jsonc`. GitHub access tokens exist only in CLI and Worker memory during identity exchange and are never persisted.

## Local verification

```bash
pnpm exec wrangler types --config sync-worker/wrangler.jsonc sync-worker/worker-configuration.d.ts
pnpm exec wrangler deploy --dry-run --config sync-worker/wrangler.jsonc
pnpm run test:sync-worker
```

The tests run in Cloudflare's Workers runtime integration with an isolated local D1 database. `pnpm validate` runs both the package suite and these Worker tests.

## Operational boundary

- Access tokens expire after 15 minutes; refresh tokens expire after 30 days and rotate as a family.
- Reuse of a rotated refresh token revokes the remaining family.
- The only unauthenticated API operations are health, public OAuth configuration, GitHub identity exchange, and token refresh. Every data, settings, key, export, device, logout, and deletion operation requires a valid device access token and is scoped to its account.
- Public authentication operations have a network-edge throttle in addition to token/device-specific limits. Unknown routes are rejected before any token database lookup.
- A daily scheduled cleanup removes expired sessions; revoked session records are retained for 30 days. Encrypted user data and device audit entries are not age-deleted.
- Devices can be listed and individually revoked.
- Retried GitHub exchanges revoke prior token families for that device before issuing replacements.
- Requests are size-bounded, validated, and rate-limited before storage.
- History events are append-only and idempotent by account, record kind, record ID, and keyed content version. A changed record creates a new cursor entry; clients apply the newest received version.
- Settings use optimistic per-key revisions.
- The first wrapped account key is immutable through the API, preventing another device from silently replacing it.
- Account export returns the encrypted server-side representation. Account deletion cascades through D1.

Cloudflare logs must never include request bodies, authorization headers, GitHub tokens, or encrypted envelopes. The Worker emits only structured path-level errors.

This is a public CLI service, so the hostname and GitHub OAuth client ID are necessarily public and the binary is reproducible by third parties. The OAuth client secret stays server-side and binds identity exchange to AIRO's GitHub app; security does not rely on an embedded secret or spoofable client header. Possession of a valid authorization for that app is required to create a device session, and possession of that device's AIRO token is required for all private operations. Cloudflare Access is not placed in front of the public API because it would add a separate interactive identity gate that ordinary CLI users cannot satisfy transparently.
