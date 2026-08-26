import { Hono, type Context, type Next } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { createSession, csrfToken, currentUser, revokeSession, validCsrf } from "./auth";
import { sha256 } from "./crypto";
import { beginOidcLogin, completeOidcLogin } from "./oidc";
import { HomePage } from "./views/home";
import { LandingPage } from "./views/landing";

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

app.use("/login*", loginRateLimit);

app.get("/health", (context) =>
  context.json({ status: "ok", service: "cf-workers-template" }),
);

app.get("/", async (context) => {
  const user = await currentUser(context);
  if (!user) return context.html(<LandingPage name={context.env.APP_NAME} />);
  return context.html(<HomePage name={context.env.APP_NAME} user={user} csrf={await csrfToken(context)} />);
});

app.get("/login", async (context) => {
  if (await currentUser(context)) return context.redirect("/");
  return context.redirect(await beginOidcLogin(context, context.req.query("return_to")));
});

app.get("/login/callback", async (context) => {
  const code = context.req.query("code");
  const state = context.req.query("state");
  if (!code || !state || context.req.query("error")) {
    return context.html(<LandingPage name={context.env.APP_NAME} error="Sign-in was cancelled or returned an invalid response." />, 400);
  }
  try {
    const result = await completeOidcLogin(context, code, state);
    await createSession(context, result.claims.sub, result.claims.displayName);
    return context.redirect(result.returnTo);
  } catch (error) {
    console.error(JSON.stringify({ event: "oidc_login_failed", message: error instanceof Error ? error.message : "unknown" }));
    return context.html(<LandingPage name={context.env.APP_NAME} error="Sign-in could not be completed. Please try again." />, 401);
  }
});

app.post("/logout", async (context) => {
  const body = await formValues(context.req.raw);
  if (!(await validCsrf(context, body.csrf_token))) {
    const user = await currentUser(context);
    if (!user) return context.html(<LandingPage name={context.env.APP_NAME} error="The form expired." />, 403);
    return context.html(<HomePage name={context.env.APP_NAME} user={user} csrf={await csrfToken(context)} error="The form expired." />, 403);
  }
  await revokeSession(context);
  return context.redirect("/");
});

app.notFound((context) => context.text("Not Found", 404));

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
      return context.html(<LandingPage name={context.env.APP_NAME} error="Too many sign-in attempts. Try again shortly." />, 429);
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "rate_limit_error", path: context.req.path, message: error instanceof Error ? error.message : "unknown" }));
  }
  return next();
}

async function formValues(request: Request): Promise<Record<string, string>> {
  const data = await request.formData();
  const values: Record<string, string> = {};
  data.forEach((value, key) => {
    if (typeof value === "string") values[key] = value;
  });
  return values;
}

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
