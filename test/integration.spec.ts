import { env, exports } from "cloudflare:workers";
import { exportJWK, SignJWT } from "jose";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";

beforeAll(async () => {
  const schema = (env as unknown as { TEST_SCHEMA: string }).TEST_SCHEMA;
  await env.DB.batch(schema.split(";").filter(sql => sql.trim()).map(sql => env.DB.prepare(sql)));
});

const origin = "http://localhost";

async function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${origin}${path}`, { redirect: "manual", ...init }));
}

async function oidcLogin(subject = "subject-testuser") {
  const started = await call("/login?return_to=%2F", { redirect: "manual" });
  expect(started.status).toBe(302);
  const authorization = new URL(started.headers.get("Location")!);
  const state = authorization.searchParams.get("state")!;
  const nonce = authorization.searchParams.get("nonce")!;
  const oidcCookie = started.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";

  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "test-key",
    alg: "ES256",
    use: "sig",
  };

  const idToken = await new SignJWT({
    nonce,
    preferred_username: "testuser",
    name: "Test User",
    token_use: "id",
  })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer("https://my.idp.example.com")
    .setAudience("test-client-id")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://my.idp.example.com/oauth/token") {
      return Response.json({ id_token: idToken, access_token: "unused", token_type: "Bearer" });
    }
    if (url === "https://my.idp.example.com/.well-known/jwks.json") {
      return Response.json({ keys: [publicJwk] });
    }
    return new Response("Unexpected request", { status: 500 });
  });

  const completed = await call(
    `/login/callback?code=test-code&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: oidcCookie }, redirect: "manual" },
  );
  return { started, authorization, completed, state, oidcCookie };
}

function sessionCookie(response: Response): string {
  const cookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) {
    if (cookie.startsWith("__Host-session=")) {
      return cookie.split(";", 1)[0]!;
    }
  }
  throw new Error("Session cookie missing");
}

describe("reader", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns health check", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "ok" });
  });

  it("returns landing page for anonymous users", async () => {
    const response = await call("/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    const frontend = await (await call("/app.js")).text();
    expect(frontend).toContain("htm.bind(h)");
    expect(frontend).toContain("from '/vendor/preact.js'");
  });

  it("redirects anonymous user to OIDC provider", async () => {
    const response = await call("/login", { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.pathname).toBe("/oauth/authorize");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
  });

  it("completes OIDC login and creates session", async () => {
    const { completed } = await oidcLogin();
    expect(completed.status).toBe(302);
    expect(completed.headers.get("Location")).toBe("/");
    const cookie = sessionCookie(completed);
    expect(cookie).toContain("__Host-session=");

    const me = await call("/api/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { sub: "subject-testuser", name: "Test User" } });
  });

  it("rejects callbacks without the transaction cookie", async () => {
    const { state } = await oidcLogin();
    const replay = await call(`/login/callback?code=test-code&state=${encodeURIComponent(state)}`);
    expect(replay.headers.get("Location")).toBe("/?error=signin");
  });

  it("revokes sessions on logout and requires CSRF", async () => {
    const { completed } = await oidcLogin();
    const cookie = sessionCookie(completed);
    const csrf = (await (await call("/api/me", { headers: { Cookie: cookie } })).json<{ csrf: string }>()).csrf;
    expect((await call("/api/logout", { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": "wrong" } })).status).toBe(403);
    expect((await call("/api/logout", { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrf } })).status).toBe(200);
    expect((await call("/api/me", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("keeps sessions tied to distinct OIDC subjects", async () => {
    const first = sessionCookie((await oidcLogin("alice")).completed);
    const second = sessionCookie((await oidcLogin("bob")).completed);
    expect(first).not.toBe(second);
    const users = await env.DB.prepare("SELECT id FROM users WHERE id IN ('alice', 'bob') ORDER BY id").all();
    expect(users.results).toEqual([{ id: "alice" }, { id: "bob" }]);
    const counts = await env.DB.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM sessions WHERE user_id IN ('alice', 'bob')").first<{ count: number }>();
    expect(counts?.count).toBe(2);
  });

  it("consumes OIDC state even when the original cookie is replayed", async () => {
    const { state, oidcCookie } = await oidcLogin();
    const replay = await call(`/login/callback?code=test-code&state=${encodeURIComponent(state)}`, { headers: { Cookie: oidcCookie } });
    expect(replay.headers.get("Location")).toBe("/?error=signin");
  });

  it("returns 404 for unknown routes", async () => {
    const response = await call("/not-found");
    expect(response.status).toBe(404);
  });
});

// Reader acceptance: two accounts share storage/fetches but never subscription or item state.
import { refreshFeed, subscribe, nextInterval } from '../src/feeds';
import { parseFeed, publicFeedUrl, boundedText } from '../src/feed-content';
const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Shared blog</title><link>https://blog.lsong.org</link><item><guid>post-1</guid><title>First article</title><link>https://blog.lsong.org/first</link><description><![CDATA[<p>Hello <strong>reader</strong><script>alert(1)</script><a href="javascript:alert(1)" onclick="evil()">bad</a></p>]]></description><pubDate>Fri, 04 Sep 2026 00:00:00 GMT</pubDate></item></channel></rss>`;

async function account(subject: string) {
  const cookie = sessionCookie((await oidcLogin(subject)).completed);
  const csrf = (await (await call('/api/me', { headers: { Cookie: cookie } })).json<{ csrf: string }>()).csrf;
  return async (path: string, method = 'GET', body?: unknown) => call('/api' + path, { method, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('shared reader', () => {
  afterEach(() => vi.restoreAllMocks());
  it('discovers, deduplicates and isolates two users end to end', async () => {
    const alice = await account('reader-alice');
    const bob = await account('reader-bob');
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url === 'https://blog.lsong.org/') return new Response('<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>', { headers: { 'Content-Type': 'text/html' } });
      return new Response(rss, { headers: { ETag: 'v1' } });
    });
    upstream.mockClear();
    const first = await alice('/subscriptions', 'POST', { url: 'https://blog.lsong.org/' });
    expect(first.status).toBe(201);
    const { id } = await first.json<{ id: number }>();
    expect((await bob('/subscriptions', 'POST', { url: 'https://blog.lsong.org/feed.xml' })).status).toBe(201);
    expect((await alice('/subscriptions', 'POST', { url: 'https://blog.lsong.org/#tracking' })).status).toBe(201);
    expect(upstream).toHaveBeenCalledTimes(2);
    const entries = await (await alice('/items')).json<Array<{ id: number; read: number }>>();
    expect(entries).toHaveLength(1);
    const article = entries[0]!.id;
    expect((await alice(`/items/${article}`, 'PATCH', { read: true, starred: true })).status).toBe(200);
    expect(await (await alice('/items?filter=unread')).json()).toEqual([]);
    expect(await (await bob('/items?filter=unread')).json()).toHaveLength(1);
    expect(await (await bob('/items?filter=starred')).json()).toEqual([]);
    expect((await alice('/mark-read', 'POST', { feed: id })).status).toBe(200);
    await alice(`/items/${article}`, 'PATCH', { read: false });
    expect(await (await alice('/items?filter=unread')).json()).toHaveLength(1);
    await bob(`/subscriptions/${id}`, 'DELETE');
    expect((await bob(`/items/${article}`)).status).toBe(404);
    expect((await bob(`/items/${article}`, 'PATCH', { read: true })).status).toBe(404);
    expect(await (await alice('/subscriptions')).json()).toHaveLength(1);
    expect((await call('/api/items')).status).toBe(401);
  });

  it('uses conditional fetches, leases, item dedupe and failure backoff', async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO users(id) VALUES ('fetch-user')").run();
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(rss, { headers: { ETag: 'v1' } }));
    const id = await subscribe(env, 'fetch-user', 'https://fetch.lsong.org/feed.xml');
    await env.DB.prepare('UPDATE feeds SET next_fetch_at=0 WHERE id=?').bind(id).run();
    upstream.mockImplementation(async (_input, init) => {
      expect(new Headers(init?.headers).get('If-None-Match')).toBe('v1');
      return new Response(null, { status: 304 });
    });
    await Promise.all([refreshFeed(env,id), refreshFeed(env,id)]);
    expect(upstream).toHaveBeenCalledTimes(2); // initial fetch + exactly one leased refresh
    const feed = await env.DB.prepare('SELECT fetch_interval, error_count FROM feeds WHERE id=?').bind(id).first();
    expect(feed).toMatchObject({ fetch_interval: 2700, error_count: 0 });
    await env.DB.prepare('UPDATE feeds SET next_fetch_at=0 WHERE id=?').bind(id).run();
    upstream.mockImplementation(async () => new Response(rss));
    await refreshFeed(env,id);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE feed_id=?').bind(id).first()).toEqual({ n: 1 });
    await env.DB.prepare('UPDATE feeds SET next_fetch_at=0 WHERE id=?').bind(id).run();
    upstream.mockImplementation(async () => new Response('bad', { status: 503 }));
    await refreshFeed(env,id);
    expect(await env.DB.prepare('SELECT error_count, error, fetching_until FROM feeds WHERE id=?').bind(id).first()).toMatchObject({ error_count: 1, error: 'HTTP 503', fetching_until: 0 });
    expect(nextInterval(300, 1)).toBe(300);
    expect(nextInterval(43200, 0)).toBe(43200);
  });

  it('parses Atom and sanitizes content, rejects dangerous URLs and XML', async () => {
    const feed = await parseFeed(rss, 'https://blog.lsong.org/feed');
    expect(feed.items[0]?.content).toContain('<strong>reader</strong>');
    expect(feed.items[0]?.content).not.toMatch(/script|onclick|javascript:/);
    const atom = await parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><id>one</id><title>A</title><link href="/a"/><summary>Summary</summary></entry></feed>', 'https://atom.lsong.org/feed');
    expect(atom.items[0]?.url).toBe('https://atom.lsong.org/a');
    for (const url of ['http://127.0.0.1/rss','http://[::1]/','http://localhost/x','https://a:b@lsong.org/rss','file:///tmp/a','https://lsong.org/feed?token=secret']) expect(() => publicFeedUrl(url)).toThrow();
    await expect(parseFeed('<!DOCTYPE rss [<!ENTITY a "bad">]><rss/>','https://lsong.org/feed')).rejects.toThrow();
    await expect(boundedText(new Response('123456'),5)).rejects.toThrow();
  });
});
