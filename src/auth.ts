import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { base64Url, hmacSha256, now, unsafeParsePayload } from "./crypto";
import type { User } from "./types";

export const SESSION_COOKIE = "__Host-session";
const SESSION_TTL = 30 * 24 * 60 * 60;

type AppContext = Context<{ Bindings: Env }>;

export async function createSession(context: AppContext, sub: string, name: string | null): Promise<void> {
  const payload = base64Url(new TextEncoder().encode(
    JSON.stringify({ sub, name, e: now() + SESSION_TTL }),
  ));
  const sig = await hmacSha256(payload, context.env.SESSION_SECRET);
  setCookie(context, SESSION_COOKIE, `${payload}.${sig}`, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

export async function currentUser(context: AppContext): Promise<User | null> {
  const cookie = getCookie(context, SESSION_COOKIE);
  if (!cookie) return null;
  const dot = cookie.indexOf(".");
  if (dot === -1) return null;
  const encoded = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  if ((await hmacSha256(encoded, context.env.SESSION_SECRET)) !== sig) return null;
  const payload = unsafeParsePayload<{ sub: string; name: string | null; e: number }>(encoded);
  if (!payload || payload.e < now()) return null;
  return { sub: payload.sub, name: payload.name };
}

export async function revokeSession(context: AppContext): Promise<void> {
  deleteCookie(context, SESSION_COOKIE, { path: "/", secure: true });
}

export async function csrfToken(context: AppContext): Promise<string> {
  const token = getCookie(context, SESSION_COOKIE);
  return token ? hmacSha256(token, `csrf\u0000${context.env.SESSION_SECRET}`) : "";
}

export async function validCsrf(context: AppContext, submitted: unknown): Promise<boolean> {
  if (typeof submitted !== "string" || !submitted) return false;
  const expected = await csrfToken(context);
  if (expected.length !== submitted.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ submitted.charCodeAt(index);
  }
  return difference === 0;
}
