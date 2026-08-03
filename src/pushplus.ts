import type { AppConfig } from "./config";
import type { Repository } from "./repository";

const encoder = new TextEncoder();
const PUSHPLUS_URL = "https://www.pushplus.plus/send";
const MAX_CALLBACK_BODY_BYTES = 4096;
const RETRY_DELAY_MS = 30 * 60 * 1000;

function base64url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function importHmac(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function callbackPayload(eventId: string, expires: number): ArrayBuffer {
  const encoded = encoder.encode(eventId + ":" + expires);
  const payload = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(payload).set(encoded);
  return payload;
}

export async function signCallback(
  secret: string,
  eventId: string,
  expires: number
): Promise<string> {
  const result = await crypto.subtle.sign(
    "HMAC",
    await importHmac(secret),
    callbackPayload(eventId, expires)
  );
  return base64url(new Uint8Array(result));
}

export async function verifyCallback(
  secret: string,
  eventId: string,
  expires: number,
  signature: string
): Promise<boolean> {
  const expected = await signCallback(secret, eventId, expires);
  if (expected.length !== signature.length) return false;
  let different = 0;
  for (let index = 0; index < expected.length; index += 1) {
    different |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return different === 0;
}

export async function dispatchDue(
  repo: Repository,
  config: AppConfig["pushplus"],
  clock: () => number = Date.now,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  for (let sent = 0; sent < 5; sent += 1) {
    const owner = crypto.randomUUID();
    const claimNow = clock();
    const event = await repo.claimDueEvent(owner, claimNow, 60_000);
    if (!event) return;
    const signature = await signCallback(
      config.callbackSecret,
      event.id,
      event.notAfter
    );
    const callbackUrl =
      config.callbackBaseUrl +
      "/callbacks/pushplus/" +
      encodeURIComponent(event.id) +
      "/" +
      event.notAfter +
      "/" +
      signature;

    const prepareNow = clock();
    if (event.notAfter <= prepareNow || event.leaseUntil <= prepareNow) {
      await repo.expireOrRequeueClaim(
        event.id,
        event.attemptCount,
        event.leaseOwner,
        prepareNow
      );
      return;
    }
    const renewedLeaseUntil = await repo.prepareDispatchClaim(
      event.id,
      event.attemptCount,
      event.leaseOwner,
      prepareNow,
      60_000
    );
    if (renewedLeaseUntil === null) {
      await repo.expireOrRequeueClaim(
        event.id,
        event.attemptCount,
        event.leaseOwner,
        clock()
      );
      return;
    }

    const sendNow = clock();
    if (event.notAfter <= sendNow || renewedLeaseUntil <= sendNow) {
      await repo.expireOrRequeueClaim(
        event.id,
        event.attemptCount,
        event.leaseOwner,
        sendNow
      );
      return;
    }
    try {
      const response = await fetchImpl(PUSHPLUS_URL, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: config.token,
          topic: config.topic,
          title: event.title,
          content: event.content,
          template: "html",
          channel: "wechat",
          callbackUrl,
          timestamp: event.notAfter
        })
      });
      if (!response.ok) throw new Error("pushplus_http_" + response.status);
      const result = await response.json() as {
        code?: number;
        data?: string;
      };
      if (result.code !== 200 || !result.data) {
        throw new Error("pushplus_rejected");
      }
      const responseNow = clock();
      const accepted = await repo.markAttemptAccepted(
        event.id,
        event.attemptCount,
        event.leaseOwner,
        result.data,
        responseNow
      );
      if (!accepted) {
        await repo.expireOrRequeueClaim(
          event.id,
          event.attemptCount,
          event.leaseOwner,
          responseNow
        );
      }
    } catch {
      const failureNow = clock();
      const failed = await repo.markAttemptFailure(
        event.id,
        event.attemptCount,
        event.leaseOwner,
        failureNow,
        failureNow + RETRY_DELAY_MS
      );
      if (!failed) {
        await repo.expireOrRequeueClaim(
          event.id,
          event.attemptCount,
          event.leaseOwner,
          failureNow
        );
      }
    }
  }
}

async function readBoundedCallbackBody(request: Request): Promise<string | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !/^\d+$/u.test(declaredLength) ||
      !Number.isSafeInteger(parsedLength) ||
      parsedLength > MAX_CALLBACK_BODY_BYTES
    ) {
      return null;
    }
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_CALLBACK_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

export async function handlePushPlusCallback(
  request: Request,
  config: Pick<AppConfig["pushplus"], "callbackSecret">,
  repo: Pick<Repository, "markCallbackSuccess" | "markCallbackFailure">,
  clock: () => number = Date.now
): Promise<Response> {
  if (request.method !== "POST") return notFound();

  const segments = new URL(request.url).pathname.split("/");
  if (
    segments.length !== 6 ||
    segments[0] !== "" ||
    segments[1] !== "callbacks" ||
    segments[2] !== "pushplus" ||
    !segments[3] ||
    !segments[4] ||
    !segments[5]
  ) {
    return notFound();
  }

  let eventId: string;
  try {
    eventId = decodeURIComponent(segments[3]);
  } catch {
    return notFound();
  }
  if (!eventId || !/^\d+$/u.test(segments[4])) return notFound();

  const expires = Number(segments[4]);
  if (!Number.isSafeInteger(expires) || expires <= clock()) return notFound();
  if (
    !await verifyCallback(
      config.callbackSecret,
      eventId,
      expires,
      segments[5]
    )
  ) {
    return notFound();
  }

  const rawBody = await readBoundedCallbackBody(request);
  if (rawBody === null) return notFound();

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return notFound();
  }
  if (typeof payload !== "object" || payload === null) return notFound();

  const callback = payload as {
    event?: unknown;
    messageInfo?: unknown;
  };
  if (
    callback.event !== "message_complate" ||
    typeof callback.messageInfo !== "object" ||
    callback.messageInfo === null
  ) {
    return notFound();
  }

  const messageInfo = callback.messageInfo as {
    shortCode?: unknown;
    sendStatus?: unknown;
  };
  if (
    typeof messageInfo.shortCode !== "string" ||
    messageInfo.shortCode.length === 0 ||
    (messageInfo.sendStatus !== 2 && messageInfo.sendStatus !== 3)
  ) {
    return notFound();
  }

  const transitionNow = clock();
  if (expires <= transitionNow) return notFound();
  const transitioned = messageInfo.sendStatus === 2
    ? await repo.markCallbackSuccess(
        eventId,
        messageInfo.shortCode,
        transitionNow
      )
    : await repo.markCallbackFailure(
      eventId,
      messageInfo.shortCode,
      transitionNow,
      transitionNow + RETRY_DELAY_MS
    );
  if (!transitioned) return notFound();

  return Response.json({ code: 200, msg: "success" });
}
