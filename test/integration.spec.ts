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
    expect(response.headers.get("Content-Security-Policy")).toContain("img-src 'self' https:");
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    const frontend = await (await call("/app.js")).text();
    expect(frontend).toContain("htm.bind(h)");
    expect(frontend).toContain("from '/vendor/preact.js'");
  });

  it("serves separate subscription, article-list and reading views", async () => {
    for (const path of ["/", "/subscribe", "/articles?filter=unread", "/article/1?return=%2Farticles%3Ffilter%3Dunread"]) {
      const response = await call(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<script type="module" src="/app.js"></script>');
    }
    const frontend = await (await call("/app.js")).text();
    expect(frontend).toContain("function FeedsView");
    expect(frontend).toContain("function SubscribeView");
    expect(frontend).toContain("function ArticlesView");
    expect(frontend).toContain("function ArticleView");
    expect(frontend).not.toContain("reader-grid");
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
    expect(await me.json()).toMatchObject({ user: { sub: "subject-testuser", name: "Test User", username: "testuser" } });
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
import { ensureScheduler, refreshFeed, runSchedulerHeartbeat, subscribe, nextInterval } from '../src/feeds';
import { parseFeed, parseOpml, publicFeedUrl, boundedText, discoverFeed } from '../src/feed-content';
import { md5, sha256 } from '../src/crypto';
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
    const initialHeaders = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(initialHeaders.get('User-Agent')).toContain('LsongReader/1.0');
    expect(initialHeaders.get('Accept')).toContain('application/rss+xml');
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
    upstream.mockImplementation(async () => new Response(rss.replace('Hello ', 'Updated ')));
    await refreshFeed(env,id);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE feed_id=?').bind(id).first()).toEqual({ n: 1 });
    expect(await env.DB.prepare('SELECT content FROM items WHERE feed_id=?').bind(id).first<{ content: string }>()).toMatchObject({ content: expect.stringContaining('Updated') });
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
    expect((await boundedText(new Response('x'.repeat(2_100_000)))).length).toBe(2_100_000);
    await expect(boundedText(new Response('123456'),5)).rejects.toThrow();
  });

  it('parses representative RSS, Atom, and nested OPML fixtures', async () => {
    const fixtures = env as unknown as { TEST_RSS_FIXTURE: string; TEST_ATOM_FIXTURE: string; TEST_OPML_FIXTURE: string };
    const rssFeed = await parseFeed(fixtures.TEST_RSS_FIXTURE, 'https://fixture.lsong.org/rss.xml');
    expect(rssFeed).toMatchObject({ title: 'RSS Fixture', site_url: 'https://fixture.lsong.org/' });
    expect(rssFeed.items[0]).toMatchObject({ title: 'Image article', url: 'https://fixture.lsong.org/posts/image', author: 'RSS Author' });
    expect(rssFeed.items[0]?.content).toContain('<img src="https://images.lsong.org/comic.png" alt="Comic" title="Caption" loading="lazy" decoding="async" referrerpolicy="no-referrer">');
    expect(rssFeed.items[0]?.content).toContain('<figcaption>Safe caption</figcaption>');
    expect(rssFeed.items[0]?.content).not.toMatch(/onerror|script|bad\(\)/);

    const atomFeed = await parseFeed(fixtures.TEST_ATOM_FIXTURE, 'https://atom.lsong.org/feed.xml');
    expect(atomFeed).toMatchObject({ title: 'Atom Fixture', site_url: 'https://atom.lsong.org/' });
    expect(atomFeed.items[0]).toMatchObject({ guid: 'tag:atom.lsong.org,2026:one', url: 'https://atom.lsong.org/entries/one', author: 'Atom Author' });
    expect(atomFeed.items[0]?.content).toContain('https://images.lsong.org/atom.png');

    expect(parseOpml(fixtures.TEST_OPML_FIXTURE)).toEqual([
      { url: 'https://atom.lsong.org/feed.xml', title: 'Atom Fixture', folder: 'Engineering / Web' },
      { url: 'https://fixture.lsong.org/rss.xml', title: 'RSS Fixture', folder: 'Engineering' },
      { url: 'https://top.lsong.org/feed', title: "Fred's & Notes", folder: '' },
    ]);
    expect(() => parseOpml('<!DOCTYPE opml><opml><body/></opml>')).toThrow();
  });

  it('imports OPML in the background and exposes existing resources', async () => {
    const alice = await account('reader-opml');
    const fixture = (env as unknown as { TEST_OPML_FIXTURE: string }).TEST_OPML_FIXTURE;
    const imported = await alice('/subscriptions/import', 'POST', { opml: fixture });
    expect(imported.status).toBe(201);
    expect(await imported.json()).toMatchObject({ imported: 3, updated: 0, skipped: 0, failed: 0, queued: 3 });
    const subscriptions = await (await alice('/subscriptions')).json<Array<{ title: string; folder: string }>>();
    expect(subscriptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Atom Fixture', folder: 'Engineering / Web' }),
      expect.objectContaining({ title: 'RSS Fixture', folder: 'Engineering' }),
      expect.objectContaining({ title: "Fred's & Notes", folder: '' }),
    ]));
    expect(await (await alice('/subscriptions/import', 'POST', { opml: fixture })).json()).toMatchObject({ imported: 0, updated: 3, skipped: 0, failed: 0 });
    await env.DB.prepare("UPDATE feeds SET last_success_at=unixepoch() WHERE title='Atom Fixture'").run();
    expect(await (await alice('/feed-directory')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Atom Fixture', subscribed: 1 })]));
    const bob = await account('reader-directory');
    expect(await (await bob('/feed-directory')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Atom Fixture', subscribed: 0 })]));
    expect((await bob('/subscriptions', 'POST', { url: 'https://atom.lsong.org/feed.xml' })).status).toBe(201);
  });

  it('accepts HTML doctypes inside CDATA while still rejecting XML DTDs', async () => {
    const wrappedXml = '<?xml version="1.0"?><rss><channel><title>Wrapped</title><item><guid>w</guid><title>Wrapped article</title><description><![CDATA[<!DOCTYPE html><html><body><p>Kept text</p><script>drop()</script></body></html>]]></description></item></channel></rss>';
    const wrapped = await parseFeed(wrappedXml, 'https://wrapped.lsong.org/feed');
    expect(wrapped.items[0]?.content).toContain('<p>Kept text</p>');
    expect(wrapped.items[0]?.content).not.toContain('drop()');
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(wrappedXml, { headers: { 'Content-Type': 'application/rss+xml' } }));
    expect((await discoverFeed('https://wrapped.lsong.org/feed')).parsed.title).toBe('Wrapped');
    expect(upstream).toHaveBeenCalledTimes(1);
    await expect(parseFeed('<!DOCTYPE rss><rss><channel><title>Unsafe</title></channel></rss>', 'https://wrapped.lsong.org/feed')).rejects.toThrow();
  });

  it('keeps one idempotent delayed-queue scheduler chain', async () => {
    await env.DB.prepare('UPDATE scheduler_state SET token=NULL, sequence=0, last_seen_at=0, lease_until=0 WHERE id=1').run();
    const send = vi.fn(async (_body: unknown, _options?: unknown) => ({}));
    const sendBatch = vi.fn(async (_messages: unknown) => ({}));
    const schedulerEnv = { DB: env.DB, FETCH_QUEUE: { send, sendBatch } } as unknown as Env;
    expect(await ensureScheduler(schedulerEnv)).toBe(true);
    expect(await ensureScheduler(schedulerEnv)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const first = send.mock.calls[0]![0] as { type:'schedule'; token:string; sequence:number };
    expect(first).toMatchObject({ type:'schedule', sequence:0 });
    await runSchedulerHeartbeat(schedulerEnv, first);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual([{ ...first, sequence:1 }, { delaySeconds:300 }]);
    await runSchedulerHeartbeat(schedulerEnv, first);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare('SELECT sequence, lease_until FROM scheduler_state WHERE id=1').first()).toEqual({ sequence:1, lease_until:0 });
  });
});


describe('Fever API v3', () => {
  afterEach(() => vi.restoreAllMocks());
  it('matches required MD5 vectors', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('rejects credentials whose username no longer matches OIDC', async () => {
    const alice = await account('reader-legacy');
    const legacyKey = md5('reader-legacy@local:old-password');
    await env.DB.prepare('INSERT INTO api_credentials(user_id,key_hash,username) VALUES (?,?,?)')
      .bind('reader-legacy', await sha256(legacyKey), 'reader-legacy@local').run();

    const status = await (await alice('/client-credential')).json<{ credential: unknown }>();
    expect(status.credential).toBeNull();
    expect(await (await call('/fever/?api&feeds', { method: 'POST', body: new URLSearchParams({ api_key: legacyKey }) })).json())
      .toMatchObject({ auth: 0 });
  });

  it('syncs feeds, groups, items and per-user state, then revokes access', async () => {
    const alice = await account('reader-alice');
    const subscriptions = await (await alice('/subscriptions')).json<Array<{ id:number; title:string }>>();
    const feed = subscriptions[0]!;
    await alice(`/subscriptions/${feed.id}`, 'PATCH', { title: feed.title, folder: 'Reading' });
    const issued = await (await alice('/client-credential', 'POST', {})).json<{ endpoint:string;username:string;password:string }>();
    expect(issued.endpoint).toBe('http://localhost/fever/');
    expect(issued.username).toBe('testuser');
    const status = await (await alice('/client-credential')).json<{credential:Record<string,unknown>}>();
    expect(status.credential).not.toHaveProperty('password');
    expect(status.credential).not.toHaveProperty('key_hash');
    const key = md5(`${issued.username}:${issued.password}`);
    const fever = async (query:string, fields:Record<string,string>={}) => call('/fever/?api&'+query, { method:'POST', body:new URLSearchParams({ api_key:key, ...fields }) });
    expect(await (await call('/fever/?api&feeds',{method:'POST',body:new URLSearchParams({api_key:'00000000000000000000000000000000'})})).json()).toMatchObject({api_version:3,auth:0});
    const catalog = await (await fever('feeds&groups&favicons')).json<{auth:number;feeds:Array<{id:number}>;groups:Array<{id:number;title:string}>;feeds_groups:Array<{group_id:number;feed_ids:string}>;favicons:unknown[]} >();
    expect(catalog.auth).toBe(1);
    expect(catalog.feeds.map(value=>value.id)).toContain(feed.id);
    expect(catalog.groups.map(value=>value.title)).toContain('Reading');
    expect(catalog.feeds_groups.some(value=>value.feed_ids.split(',').includes(String(feed.id)))).toBe(true);
    expect(catalog.favicons).toEqual([]);
    const page = await (await fever('items&max_id=0')).json<{items:Array<{id:number;is_read:number;is_saved:number;html:string}>;total_items:number}>();
    expect(page.total_items).toBeGreaterThan(0);
    const item = page.items[0]!;
    expect(item.html).toContain('<p>');
    expect((await (await fever('items&with_ids='+item.id)).json<{items:unknown[]}>()).items).toHaveLength(1);
    expect((await (await fever('items&since_id='+item.id)).json<{items:unknown[]}>()).items).toEqual([]);
    const saved = await (await fever('',{mark:'item',as:'saved',id:String(item.id)})).json<{saved_item_ids:string}>();
    expect(saved.saved_item_ids.split(',')).toContain(String(item.id));
    await fever('',{mark:'item',as:'read',id:String(item.id)});
    const unread = await (await fever('unread_item_ids')).json<{unread_item_ids:string}>();
    expect(unread.unread_item_ids.split(',')).not.toContain(String(item.id));
    await fever('',{mark:'item',as:'unread',id:String(item.id)});
    expect((await (await fever('unread_item_ids')).json<{unread_item_ids:string}>()).unread_item_ids.split(',')).toContain(String(item.id));
    await fever('',{mark:'feed',as:'read',id:String(feed.id),before:String(Math.floor(Date.now()/1000)+1)});
    expect((await (await fever('unread_item_ids')).json<{unread_item_ids:string}>()).unread_item_ids.split(',')).not.toContain(String(item.id));
    const rotated = await (await alice('/client-credential','POST',{})).json<{username:string;password:string}>();
    expect((await fever('feeds')).json()).resolves.toMatchObject({auth:0});
    const nextKey=md5(`${rotated.username}:${rotated.password}`);
    expect(await (await call('/fever/?api&feeds',{method:'POST',body:new URLSearchParams({api_key:nextKey})})).json()).toMatchObject({auth:1});
    await alice('/client-credential','DELETE');
    expect(await (await call('/fever/?api&feeds',{method:'POST',body:new URLSearchParams({api_key:nextKey})})).json()).toMatchObject({auth:0});
  });

  it('keeps one user’s Fever catalog invisible to another', async () => {
    const bob = await account('reader-bob');
    const issued = await (await bob('/client-credential','POST',{})).json<{username:string;password:string}>();
    const response = await call('/fever/?api&feeds&items&unread_item_ids',{method:'POST',body:new URLSearchParams({api_key:md5(`${issued.username}:${issued.password}`)})});
    const body=await response.json<{auth:number;feeds:unknown[];items:unknown[];unread_item_ids:string}>();
    expect(body).toMatchObject({auth:1,feeds:[],items:[],unread_item_ids:''});
  });
});
