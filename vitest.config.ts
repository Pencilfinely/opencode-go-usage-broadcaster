import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "migrations")
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            PUSHPLUS_TOKEN: "test-token",
            PUSHPLUS_TOPIC: "test-topic",
            PUSHPLUS_SECRET_KEY: "test-pushplus-secret-key-32-bytes-minimum",
            PUSHPLUS_CALLBACK_SECRET: "test-callback-secret-32-bytes-minimum",
            PUSHPLUS_CALLBACK_BASE_URL: "https://worker.test",
            USAGE_CHART_SIGNING_SECRET: "test-usage-chart-signing-secret-32-bytes-minimum"
          }
        }
      })
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"]
    }
  };
});
