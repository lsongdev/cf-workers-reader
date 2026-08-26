export {};

declare global {
  interface Env {
    APP_NAME: string;
    APP_URL: string;
    OIDC_ISSUER: string;
    OIDC_CLIENT_ID: string;
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
