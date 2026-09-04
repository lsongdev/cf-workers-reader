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
