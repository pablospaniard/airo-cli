import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const migrations = await readD1Migrations("./sync-worker/migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./sync-worker/wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          GITHUB_CLIENT_SECRET: "github-client-secret-test",
        },
      },
    }),
  ],
  test: {
    include: ["sync-worker/test/**/*.test.ts"],
    setupFiles: ["./sync-worker/test/apply-migrations.ts"],
  },
});
