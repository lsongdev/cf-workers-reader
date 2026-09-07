import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_SCHEMA: readFileSync("migrations/0001_reader.sql", "utf8") + readFileSync("migrations/0002_oidc_transactions.sql", "utf8") + readFileSync("migrations/0003_queue_tokens.sql", "utf8") + readFileSync("migrations/0004_fever.sql", "utf8") + readFileSync("migrations/0005_queue_scheduler.sql", "utf8") + readFileSync("migrations/0006_oidc_username.sql", "utf8"),
          TEST_RSS_FIXTURE: readFileSync("test/fixtures/rss2.xml", "utf8"),
          TEST_ATOM_FIXTURE: readFileSync("test/fixtures/atom.xml", "utf8"),
          TEST_OPML_FIXTURE: readFileSync("test/fixtures/subscriptions.opml", "utf8"),
          APP_URL: "http://localhost",
          OIDC_ISSUER: "https://my.idp.example.com",
          OIDC_CLIENT_ID: "test-client-id",
          OIDC_CLIENT_SECRET: "test-client-secret",
          SESSION_SECRET: "test-session-secret",
        },
      },
    }),
  ],
});
