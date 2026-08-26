import type { Child } from "hono/jsx";
import type { User } from "../types";

export function Layout(props: {
  title: string;
  children: Child;
  user?: User | null;
  notice?: string | null;
  error?: string | null;
  csrf?: string;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="description" content="A secure Cloudflare Workers starter with Hono and OIDC authentication." />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="stylesheet" href="/main.css" />
        <title>{props.title}</title>
      </head>
      <body class="layout-container">
        <header class="navbar" role="banner">
          <a class="navbar-brand" href="/" aria-label={`${props.title} home`}>
            <img class="navbar-brand-mark" src="https://lsong.org/assets/web/icon.png" alt="" width="22" height="22" />
            <span>{props.title}</span>
          </a>
          <nav aria-label="Account navigation">
            {props.user ? (
              <>
                {props.user.name && <span class="address">{props.user.name}</span>}
                <form class="nav-form" method="post" action="/logout">
                  <HiddenCsrf token={props.csrf || ""} />
                  <button class="button button-link" type="submit">Sign out</button>
                </form>
              </>
            ) : (
              <a class="button button-link" href="/login">Sign in</a>
            )}
          </nav>
        </header>
        <main>
          {props.notice && <div class="alert notice" role="status">{props.notice}</div>}
          {props.error && <div class="alert error" role="alert">{props.error}</div>}
          {props.children}
        </main>
        <footer>
          <span>{props.title}</span>
          <span>Part of lsong.org</span>
        </footer>
      </body>
    </html>
  );
}

export function HiddenCsrf({ token }: { token: string }) {
  return <input type="hidden" name="csrf_token" value={token} />;
}
