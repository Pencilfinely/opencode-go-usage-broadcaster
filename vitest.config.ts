import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PUSHPLUS_TOKEN: "test-token",
          PUSHPLUS_TOPIC: "test-topic",
          PUSHPLUS_CALLBACK_SECRET: "test-callback-secret-32-bytes-minimum",
          PUSHPLUS_CALLBACK_BASE_URL: "https://worker.test"
        }
      }
    })
  ]
});
