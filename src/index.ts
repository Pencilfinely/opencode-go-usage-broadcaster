import { runScheduled } from "./app";
import { loadConfig } from "./config";
import { handlePushPlusCallback } from "./pushplus";
import { Repository } from "./repository";

export default {
  scheduled(controller, env, ctx): void {
    ctx.waitUntil(runScheduled(controller, env, ctx));
  },

  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
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
