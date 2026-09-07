import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { hmacSha256, now, randomToken, sha256 } from "./crypto";
import type { User } from "./types";

export const SESSION_COOKIE = "__Host-session";
const SESSION_TTL = 30 * 24 * 60 * 60;


export async function createSession<E extends { Bindings: Env }>(context: Context<E>, sub: string, name: string | null, username: string): Promise<void> {
  const token = randomToken();
  await context.env.DB.batch([
    context.env.DB.prepare("INSERT INTO users(id, name, username) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username").bind(sub, name, username),
    context.env.DB.prepare("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), sub, now() + SESSION_TTL),
  ]);
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL,
  });
}

export async function currentUser<E extends { Bindings: Env }>(context: Context<E>): Promise<User | null> {
  const cookie = getCookie(context, SESSION_COOKIE);
  if (!cookie) return null;
  return context.env.DB.prepare("SELECT u.id AS sub, u.name, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?")
    .bind(await sha256(cookie), now()).first<User>();
}

export async function revokeSession<E extends { Bindings: Env }>(context: Context<E>): Promise<void> {
  const cookie = getCookie(context, SESSION_COOKIE);
  if (cookie) await context.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(cookie)).run();
  deleteCookie(context, SESSION_COOKIE, { path: "/", secure: true });
}

export async function csrfToken<E extends { Bindings: Env }>(context: Context<E>): Promise<string> {
  const token = getCookie(context, SESSION_COOKIE);
  return token ? hmacSha256(token, `csrf\u0000${context.env.SESSION_SECRET}`) : "";
}

export async function validCsrf<E extends { Bindings: Env }>(context: Context<E>, submitted: unknown): Promise<boolean> {
  if (typeof submitted !== "string" || !submitted) return false;
  const expected = await csrfToken(context);
  if (expected.length !== submitted.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ submitted.charCodeAt(index);
  return difference === 0;
}
