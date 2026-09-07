import { fever } from "./fever";
import { reader } from "./reader";
import { scheduleFeeds, refreshFeed } from "./feeds";
import { Hono, type Context, type Next } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { createSession, currentUser } from "./auth";
import { sha256 } from "./crypto";
import { beginOidcLogin, completeOidcLogin } from "./oidc";

const app = new Hono<{ Bindings: Env }>();

app.use("*", secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://lsong.org"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
    baseUri: ["'none'"],
  },
  referrerPolicy: "no-referrer",
  xFrameOptions: "DENY",
}));

app.use("*", async (context, next) => {
  await next();
  if (context.req.path.startsWith("/api/") || context.req.path.startsWith("/login") || context.req.path.startsWith("/fever")) context.header("Cache-Control", "no-store");
});

app.use("/login*", loginRateLimit);

app.get("/health", (context) =>
  context.json({ status: "ok", service: "reader" }),
);

app.get("/", (context) => asset(context, "/index.html"));
app.get("/settings", (context) => asset(context, "/index.html"));

app.get("/login", async (context) => {
  if (await currentUser(context)) return context.redirect("/");
  return context.redirect(await beginOidcLogin(context, context.req.query("return_to")));
});

app.get("/login/callback", async (context) => {
  const code = context.req.query("code");
  const state = context.req.query("state");
  if (!code || !state || context.req.query("error")) {
    return context.redirect("/?error=signin", 302);
  }
  try {
    const result = await completeOidcLogin(context, code, state);
    await createSession(context, result.claims.sub, result.claims.displayName);
    return context.redirect(result.returnTo);
  } catch (error) {
    console.error(JSON.stringify({ event: "oidc_login_failed", message: error instanceof Error ? error.message : "unknown" }));
    return context.redirect("/?error=signin", 302);
  }
});

app.route("/api", reader);
app.route("/fever", fever);

app.notFound(async (context) => cloneResponse(await context.env.ASSETS.fetch(context.req.raw)));

app.onError(async (error, context) => {
  console.error(JSON.stringify({ event: "request_error", path: context.req.path, message: error.message }));
  return context.text("Internal Server Error", 500);
});

async function loginRateLimit(context: Context<{ Bindings: Env }>, next: Next) {
  const address = context.req.header("CF-Connecting-IP") || "unknown";
  const key = await sha256(`${context.req.path}:${address}:${context.env.SESSION_SECRET}`);
  try {
    const result = await context.env.AUTH_RATE_LIMITER.limit({ key });
    if (!result.success) {
      context.header("Retry-After", "60");
      return context.json({ error: "Too many sign-in attempts. Try again shortly." }, 429);
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "rate_limit_error", path: context.req.path, message: error instanceof Error ? error.message : "unknown" }));
  }
  return next();
}

function cloneResponse(response: Response): Response { return new Response(response.body, response); }

async function asset(context: Context<{ Bindings: Env }>, path: string): Promise<Response> {
  return cloneResponse(await context.env.ASSETS.fetch(new Request(new URL(path, context.req.url), context.req.raw)));
}

export default {
  fetch: app.fetch,
  async scheduled(_event, env) { await scheduleFeeds(env); },
  async queue(batch, env) {
    for (const message of batch.messages) {
      await refreshFeed(env, message.body.id, message.body.token);
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, { id: number; token: string }>;
