import { runBroadcast, runScheduled } from "./app";
import { loadConfig } from "./config";
import { handleManualTrigger } from "./manual-trigger";
import { handlePushPlusCallback } from "./pushplus";
import { Repository } from "./repository";

export default {
  scheduled(controller, env, ctx): void {
    ctx.waitUntil(runScheduled(controller, env, ctx));
  },

  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/admin/manual-trigger") {
      const config = loadConfig(env);
      return await handleManualTrigger(
        request,
        config,
        (trigger) => runBroadcast(trigger, env)
      );
    }
    if (
      request.method !== "POST" ||
      !url.pathname.startsWith("/callbacks/pushplus/")
    ) {
      return new Response("Not found", { status: 404 });
    }
    const config = loadConfig(env);
    return handlePushPlusCallback(
      request,
      config.pushplus,
      new Repository(env.DB)
    );
  }
} satisfies ExportedHandler<Cloudflare.Env>;
