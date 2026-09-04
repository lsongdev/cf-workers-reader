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
    expect(html).toContain("Follow what matters.");
    expect(html).toContain("Sign in");
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

    const home = await call("/", { headers: { Cookie: cookie } });
    const html = await home.text();
    expect(html).toContain("Sign out");
    expect(html).toContain("Welcome, Test User");
  });

  it("rejects callbacks without the transaction cookie", async () => {
    const { state } = await oidcLogin();
    const replay = await call(`/login/callback?code=test-code&state=${encodeURIComponent(state)}`);
    expect(replay.status).toBe(401);
  });

  it("revokes sessions on logout and requires CSRF", async () => {
    const { completed } = await oidcLogin();
    const cookie = sessionCookie(completed);
    const html = await (await call("/", { headers: { Cookie: cookie } })).text();
    const csrf = html.match(/name="csrf_token" value="([^"]+)"/)![1]!;
    expect((await call("/logout", { method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams({ csrf_token: "wrong" }) })).status).toBe(403);
    expect((await call("/logout", { method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams({ csrf_token: csrf }) })).status).toBe(302);
    expect(await (await call("/", { headers: { Cookie: cookie } })).text()).not.toContain("Sign out");
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
    expect(replay.status).toBe(401);
  });

  it("returns 404 for unknown routes", async () => {
    const response = await call("/not-found");
    expect(response.status).toBe(404);
  });
});
