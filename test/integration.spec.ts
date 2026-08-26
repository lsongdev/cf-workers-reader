import { exports } from "cloudflare:workers";
import { exportJWK, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

const origin = "http://localhost";

async function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${origin}${path}`, init));
}

async function oidcLogin() {
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
    .setSubject("subject-testuser")
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
  return { started, authorization, completed, state };
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

describe("template", () => {
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
    expect(html).toContain("Cloudflare Workers template");
    expect(html).toContain("Sign in with OIDC");
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

  it("prevents state replay attack", async () => {
    const { state } = await oidcLogin();
    const replay = await call(`/login/callback?code=test-code&state=${encodeURIComponent(state)}`);
    expect(replay.status).toBe(401);
  });

  it("returns 404 for unknown routes", async () => {
    const response = await call("/not-found");
    expect(response.status).toBe(404);
  });
});
