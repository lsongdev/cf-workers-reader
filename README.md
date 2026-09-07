# Reader

A multi-user RSS reader on Cloudflare Workers, Hono and D1, using [my.lsong.org](https://my.lsong.org) OIDC login.

Implementation and acceptance checklist: [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

## Development

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm exec wrangler d1 migrations apply reader-db --local
pnpm dev
```

Configure an OIDC client with the exact `/login/callback` URL for the environment. Production uses `https://read.lsong.org/login/callback`. `OIDC_CLIENT_SECRET` and `SESSION_SECRET` are Worker secrets; do not put them in tracked files.

```sh
pnpm check              # types and Workers-runtime tests
pnpm deploy:production  # remote migrations, then Worker deployment
```

Production configuration lives in `wrangler.jsonc`. Sessions are opaque, hashed in D1 and revocable at logout. Feed and article records are shared; subscriptions and reading state are keyed by the OIDC subject. The MVP will expose Fever for client synchronization using separate credentials, never the OIDC account password.

## Architecture

The frontend is a static browser-native ESM application in `public/app.js`, rendered with Preact and HTM. Its dependencies are vendored under `public/vendor` with their license files. It communicates only through the authenticated JSON API under `/api`.

The Worker owns OIDC, per-user sessions/state and a shared feed registry in D1. A five-minute cron schedules due feeds onto `reader-fetch`; queue consumers use one-use queue tokens and leases, conditional HTTP requests, adaptive polling and backoff. The MVP accepts public RSS/Atom feeds and websites with a feed `<link>`; credentialed private feeds are intentionally excluded because their content cannot be globally deduplicated safely.
