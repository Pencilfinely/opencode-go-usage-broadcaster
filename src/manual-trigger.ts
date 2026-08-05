import type { BroadcastTrigger } from "./app";
import type { AppConfig } from "./config";

type BroadcastResult = "completed" | "duplicate" | "busy";
type BroadcastRunner = (trigger: BroadcastTrigger) => Promise<BroadcastResult>;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/u;

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  ));
}

async function sha256Hex(value: string): Promise<string> {
  return Array.from(await sha256(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function isAuthorized(request: Request, secret: string): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const [bearerDigest, secretDigest] = await Promise.all([
    sha256(bearer),
    sha256(secret)
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(
      left: ArrayBuffer | ArrayBufferView,
      right: ArrayBuffer | ArrayBufferView
    ): boolean;
  };
  return subtle.timingSafeEqual(bearerDigest, secretDigest);
}

export async function handleManualTrigger(
  request: Request,
  config: AppConfig,
  run: BroadcastRunner,
  clock: () => number = Date.now
): Promise<Response> {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.pathname !== "/admin/manual-trigger" ||
    url.search !== "" ||
    !await isAuthorized(request, config.manualTriggerSecret)
  ) {
    return new Response("未找到", { status: 404 });
  }

  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return new Response("请求无效", { status: 400 });
  }

  const result = await run({
    type: "manual",
    occurredAt: clock(),
    idempotencyDigest: await sha256Hex(idempotencyKey)
  });
  if (result === "busy") {
    return new Response("服务繁忙", { status: 503 });
  }
  return new Response(null, { status: 204 });
}
