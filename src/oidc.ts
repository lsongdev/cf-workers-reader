import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { base64Url, hmacSha256, now, pkceChallenge, randomToken, safeReturnTo, unsafeParsePayload } from "./crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

const OIDC_COOKIE = "__Host-oidc_state";
const TRANSACTION_TTL = 600;

type AppContext = Context<{ Bindings: Env }>;

export interface IdentityClaims {
  sub: string;
  preferredUsername: string;
  displayName: string | null;
}

export async function beginOidcLogin(context: AppContext, returnToValue?: string | null): Promise<string> {
  const state = randomToken();
  const verifier = randomToken(48);
  const nonce = randomToken();
  const payload = base64Url(new TextEncoder().encode(
    JSON.stringify({ s: state, v: verifier, n: nonce, r: safeReturnTo(returnToValue), e: now() + TRANSACTION_TTL }),
  ));
  const sig = await hmacSha256(payload, context.env.OIDC_CLIENT_SECRET);
  setCookie(context, OIDC_COOKIE, `${payload}.${sig}`, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: TRANSACTION_TTL,
  });
  const url = new URL("/oauth/authorize", context.env.OIDC_ISSUER);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: context.env.OIDC_CLIENT_ID,
    redirect_uri: callbackUrl(context.env),
    scope: "openid profile",
    state,
    nonce,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function completeOidcLogin(
  context: AppContext,
  code: string,
  state: string,
): Promise<{ claims: IdentityClaims; returnTo: string }> {
  const cookie = getCookie(context, OIDC_COOKIE);
  deleteCookie(context, OIDC_COOKIE, { path: "/", secure: true });
  if (!cookie) throw new Error("The sign-in request expired or was already used.");
  const dot = cookie.indexOf(".");
  if (dot === -1) throw new Error("Invalid sign-in cookie.");
  const encoded = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  if ((await hmacSha256(encoded, context.env.OIDC_CLIENT_SECRET)) !== sig) throw new Error("Invalid sign-in cookie.");
  const txn = unsafeParsePayload<{ s: string; v: string; n: string; r: string; e: number }>(encoded);
  if (!txn || txn.e < now()) throw new Error("The sign-in request expired.");
  if (txn.s !== state) throw new Error("State mismatch.");

  const tokenResponse = await fetch(new URL("/oauth/token", context.env.OIDC_ISSUER), {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${context.env.OIDC_CLIENT_ID}:${context.env.OIDC_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(context.env),
      code_verifier: txn.v,
    }),
  });
  const tokens = await tokenResponse.json<{ id_token?: string; error?: string }>();
  if (!tokenResponse.ok || !tokens.id_token) {
    throw new Error(
      tokens.error ? `Identity provider rejected the request: ${tokens.error}` : "Identity provider token exchange failed.",
    );
  }

  const jwksResponse = await fetch(new URL("/.well-known/jwks.json", context.env.OIDC_ISSUER), {
    headers: { Accept: "application/json" },
  });
  if (!jwksResponse.ok) throw new Error("Identity provider signing keys are unavailable.");
  const jwks = await jwksResponse.json<JSONWebKeySet>();
  const verified = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
    issuer: context.env.OIDC_ISSUER,
    audience: context.env.OIDC_CLIENT_ID,
    algorithms: ["ES256"],
  });
  if (
    verified.payload.token_use !== "id" ||
    verified.payload.nonce !== txn.n ||
    typeof verified.payload.sub !== "string" ||
    typeof verified.payload.preferred_username !== "string"
  ) {
    throw new Error("Identity token claims are invalid.");
  }
  return {
    claims: {
      sub: verified.payload.sub,
      preferredUsername: verified.payload.preferred_username,
      displayName: typeof verified.payload.name === "string" ? verified.payload.name.slice(0, 100) : null,
    },
    returnTo: safeReturnTo(txn.r),
  };
}

function callbackUrl(env: Env): string {
  return new URL("/login/callback", env.APP_URL).toString();
}
