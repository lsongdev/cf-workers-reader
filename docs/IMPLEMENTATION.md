# Reader MVP implementation

Reference: https://chatgpt.com/share/6a9ae0f5-cda0-83e8-8e96-365845675b88
Read in browser on 2026-09-04. The reference explicitly proposes an MVP with shared feeds/items, independent subscriptions and sparse user state, URL aliases, item deduplication, conditional HTTP requests, adaptive polling and a Cron → Queue fetcher with leases. Feed directories, recommendations, WebSub, full-text fetching, AI summaries and prediction by historical median are future work. Public feeds only for MVP; credentials/private feeds must not enter a public directory.

## Milestones (commit and deploy each)

1. **Foundation**: D1 schema, OIDC integration with my.lsong.org, revocable sessions, HTTPS origin, CSRF, test harness and deployed database.
2. **Reader**: RSS/Atom discovery and parsing, public URL validation, shared feeds and aliases, scheduled queue fetching, conditional GET, adaptive intervals/backoff/leases, subscription management, unread/starred state and usable web UI. Verify multi-user isolation, duplicate subscriptions/items, parser and fetch failures.
3. **Client API and acceptance**: Fever API with separately revocable per-user credentials; feeds/groups/items/read/star sync. Verify protocol requests, authorization and cross-user isolation. Production smoke and real OIDC browser flow, document endpoint/setup and limitations.

## Acceptance evidence

Do not mark complete until all three milestones are committed/deployed and their behavior is verified. Local mock OIDC tests prove code behavior but do not prove the actual provider has accepted the HTTPS redirect URI. Production real sign-in remains a separate gate.

## Current infrastructure

- Worker: reader
- Intended origin: https://read.lsong.org
- D1: reader-db (387f83ed-954c-473f-b1a7-cc8146fe8109)
- Queue reserved: reader-fetch (consumer wiring in milestone 2)
- OIDC client already existed; OIDC_CLIENT_SECRET already installed.
- SESSION_SECRET newly generated and installed through Wrangler without logging it.
- Migration 0001_reader.sql applied remotely successfully.

### Milestone 1 validation

- `pnpm check`: TypeScript and 9 Workers-runtime integration tests passed (2026-09-04), including OIDC success/PKCE, distinct subjects, logout revocation, CSRF rejection and state replay with the original cookie.
- Preserve compatibility date 2026-07-29 and existing locked toolchain: downloading the latest runtime tarball stalled and an independent fetch timed out; cached locked dependencies restored with `pnpm install --offline --frozen-lockfile`. No requirement depends on the newer compatibility date.
- Migration 0002 adds one-use OIDC transactions.
