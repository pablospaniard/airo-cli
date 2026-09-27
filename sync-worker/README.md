# AIRO encrypted sync Worker

This directory contains the optional Cloudflare Worker used by AIRO's development-branch sync milestone. The npm package does not need this service for routing, orchestration, portable archives, or local learning.

The Worker authenticates devices with GitHub's device flow, stores only hashes of AIRO session tokens, and persists opaque encrypted event and setting envelopes in D1. Encryption and recovery-key handling happen in the CLI. Provider credentials, API keys, executable paths, permission settings, and Jev consent are outside the sync schema.

## Provisioning

1. Create a GitHub OAuth App, enable Device Flow, and retain its public client ID.
2. Authenticate Wrangler and create the database:

   ```bash
   pnpm exec wrangler login
   pnpm exec wrangler d1 create airo-sync
   ```

3. Replace the placeholder D1 database ID and GitHub client ID in `wrangler.jsonc`. Use a separate GitHub OAuth App and D1 database for each environment.
4. Apply the migration and deploy:

   ```bash
   pnpm exec wrangler d1 migrations apply airo-sync --remote --config sync-worker/wrangler.jsonc
   pnpm exec wrangler deploy --config sync-worker/wrangler.jsonc
   ```

The GitHub client ID is public OAuth configuration, not a secret. Do not add a GitHub client secret: this implementation deliberately uses the device flow and never persists GitHub access tokens.

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
- Devices can be listed and individually revoked.
- Requests are size-bounded, validated, and rate-limited before storage.
- History events are append-only and idempotent by account and event ID.
- Settings use optimistic per-key revisions.
- The first wrapped account key is immutable through the API, preventing another device from silently replacing it.
- Account export returns the encrypted server-side representation. Account deletion cascades through D1.

Cloudflare logs must never include request bodies, authorization headers, GitHub tokens, or encrypted envelopes. The Worker emits only structured path-level errors.
