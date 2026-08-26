import { Layout } from "./layout";

export interface LandingPageProps {
  name: string;
  error?: string | null;
}

export function LandingPage({ name, error }: LandingPageProps) {
  return (
    <Layout title={name} error={error}>
      <section class="site-hero">
        <p class="eyebrow">{name} · Edge-native starter</p>
        <h2 class="site-hero-title">Build at the edge.<br />Start with trust.</h2>
        <p class="site-hero-copy">
          A production-minded Cloudflare Workers template with Hono, secure OIDC authentication,
          and the essentials already wired together.
        </p>
        <div class="site-hero-actions">
          <a class="button button-primary" href="/login">Get started</a>
          <a class="button button-secondary" href="#features">Explore the stack</a>
        </div>
      </section>

      <section class="landing-features" id="features" aria-label="Template features">
        <article>
          <span class="landing-feature-mark" aria-hidden="true">01</span>
          <h2>Secure by default</h2>
          <p>OIDC with PKCE, signed sessions, CSRF protection, rate limiting, and hardened response headers.</p>
        </article>
        <article>
          <span class="landing-feature-mark" aria-hidden="true">02</span>
          <h2>Made for the edge</h2>
          <p>Hono and Cloudflare Workers keep the runtime small, fast, and close to every user.</p>
        </article>
        <article>
          <span class="landing-feature-mark" aria-hidden="true">03</span>
          <h2>Ready to become yours</h2>
          <p>Typed configuration and focused primitives give you a clean base without framework clutter.</p>
        </article>
      </section>

      <p class="landing-developer-link">
        Cloudflare Workers template · <a href="/health">Check service health</a>
      </p>
    </Layout>
  );
}
