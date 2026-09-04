import { Layout } from "./layout";

export interface LandingPageProps {
  name: string;
  error?: string | null;
}

export function LandingPage({ name, error }: LandingPageProps) {
  return (
    <Layout title={name} error={error}>
      <section class="site-hero">
        <p class="eyebrow">{name} · Your personal reading space</p>
        <h2 class="site-hero-title">Follow what matters.<br />Read at your pace.</h2>
        <p class="site-hero-copy">One place for your RSS subscriptions. Your subscriptions, reading progress and saved articles stay with your account.</p>
        <div class="site-hero-actions">
          <a class="button button-primary" href="/login">Sign in with my.lsong.org</a>
        </div>
      </section>
      <p class="landing-developer-link"><a href="/health">Service health</a></p>
    </Layout>
  );
}
