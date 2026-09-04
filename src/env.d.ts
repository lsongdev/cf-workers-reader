export {};

declare global {
  interface Env {
    OIDC_CLIENT_SECRET: string;
    SESSION_SECRET: string;
  }

  namespace Cloudflare {
    interface Env {
      OIDC_CLIENT_SECRET: string;
      SESSION_SECRET: string;
    }
  }
}
