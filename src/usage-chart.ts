import type { UsageAggregate, UsageChartDataV1, UsageHourBucket } from "./usage-domain";
import type { UsageChartSnapshotRow } from "./repository";

const HOUR_MS = 60 * 60 * 1000;
const SNAPSHOT_ID = /^[a-f0-9]{64}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/u;

export interface UsageChartConfig {
  publicBaseUrl: string;
  signingSecret: string;
}

export interface UsageChartSnapshotReader {
  loadUsageChartSnapshot(id: string): Promise<UsageChartSnapshotRow | null>;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => field in value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseBucket(value: unknown, expectedStartAt: number): UsageHourBucket {
  if (!isRecord(value) || !hasExactFields(value, [
    "startAt",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheTokens"
  ])) {
    throw new Error("图表小时桶无效");
  }
  if (
    value.startAt !== expectedStartAt ||
    !isNonNegativeSafeInteger(value.startAt) ||
    !isNonNegativeSafeInteger(value.inputTokens) ||
    !isNonNegativeSafeInteger(value.outputTokens) ||
    !isNonNegativeSafeInteger(value.reasoningTokens) ||
    !isNonNegativeSafeInteger(value.cacheTokens)
  ) {
    throw new Error("图表小时桶无效");
  }
  return {
    startAt: value.startAt,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    reasoningTokens: value.reasoningTokens,
    cacheTokens: value.cacheTokens
  };
}

export function parseUsageChartDataV1(raw: string): UsageChartDataV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("图表快照 JSON 无效");
  }
  if (!isRecord(parsed) || !hasExactFields(parsed, [
    "version",
    "observedAt",
    "truncated",
    "buckets"
  ])) {
    throw new Error("图表快照格式无效");
  }
  if (
    parsed.version !== 1 ||
    !isNonNegativeSafeInteger(parsed.observedAt) ||
    typeof parsed.truncated !== "boolean" ||
    !Array.isArray(parsed.buckets) ||
    parsed.buckets.length !== 24
  ) {
    throw new Error("图表快照格式无效");
  }
  const firstStartAt = parsed.buckets[0] && isRecord(parsed.buckets[0])
    ? parsed.buckets[0].startAt
    : undefined;
  if (!isNonNegativeSafeInteger(firstStartAt) || firstStartAt % HOUR_MS !== 0) {
    throw new Error("图表小时桶无效");
  }
  const buckets = parsed.buckets.map((bucket, index) =>
    parseBucket(bucket, firstStartAt + index * HOUR_MS)
  );
  return {
    version: 1,
    observedAt: parsed.observedAt,
    truncated: parsed.truncated,
    buckets
  };
}

export function serializeUsageChartData(aggregate: UsageAggregate): string {
  const data = parseUsageChartDataV1(JSON.stringify({
    version: 1,
    observedAt: aggregate.observedAt,
    truncated: aggregate.truncated,
    buckets: aggregate.buckets
  }));
  return JSON.stringify(data);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!SIGNATURE.test(value)) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.byteLength === 32 && toBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function importSigningKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

function signingPayload(snapshotId: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode("usage-chart:v1:" + snapshotId));
}

export async function signUsageChart(secret: string, snapshotId: string): Promise<string> {
  if (!SNAPSHOT_ID.test(snapshotId)) throw new Error("图表快照编号无效");
  const key = await importSigningKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, signingPayload(snapshotId));
  return toBase64Url(new Uint8Array(signature));
}

export async function verifyUsageChartSignature(
  secret: string,
  snapshotId: string,
  signature: string
): Promise<boolean> {
  if (!SNAPSHOT_ID.test(snapshotId)) return false;
  const signatureBytes = fromBase64Url(signature);
  if (signatureBytes === null) return false;
  const key = await importSigningKey(secret, ["verify"]);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(signatureBytes),
    signingPayload(snapshotId)
  );
}

export async function createUsageChartUrl(
  config: UsageChartConfig,
  snapshotId: string
): Promise<string> {
  const signature = await signUsageChart(config.signingSecret, snapshotId);
  const url = new URL("/charts/usage/" + snapshotId + ".svg", config.publicBaseUrl);
  url.search = "?sig=" + signature;
  return url.toString();
}

export function renderUsageChartSvg(data: UsageChartDataV1): string {
  const left = 52;
  const top = 72;
  const plotWidth = 648;
  const plotHeight = 220;
  const slotWidth = plotWidth / 24;
  const barWidth = slotWidth - 6;
  const totals = data.buckets.map((bucket) =>
    bucket.inputTokens + bucket.outputTokens +
    bucket.reasoningTokens + bucket.cacheTokens
  );
  const maximum = Math.max(1, ...totals);
  const hourFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hourCycle: "h23"
  });
  const observedFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const layers = [
    ["inputTokens", "#2563eb"],
    ["outputTokens", "#16a34a"],
    ["reasoningTokens", "#7c3aed"],
    ["cacheTokens", "#f59e0b"]
  ] as const;
  const bars = data.buckets.map((bucket, index) => {
    const x = left + index * slotWidth + 3;
    let y = top + plotHeight;
    const rectangles = layers.map(([field, color]) => {
      const height = bucket[field] / maximum * plotHeight;
      y -= height;
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" ` +
        `width="${barWidth.toFixed(2)}" height="${height.toFixed(2)}" ` +
        `fill="${color}"/>`;
    }).join("");
    const label = index % 3 === 0
      ? `<text x="${(x + barWidth / 2).toFixed(2)}" y="310" ` +
        `text-anchor="middle" font-size="11">` +
        escapeXml(hourFormatter.format(new Date(bucket.startAt))) + `</text>`
      : "";
    return rectangles + label;
  }).join("");
  const note = (data.truncated
    ? "仅含已采集的最新记录"
    : "当前小时为部分小时") +
    "；观测于 " + observedFormatter.format(new Date(data.observedAt));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 360" ` +
    `role="img" aria-label="最近 24 小时 Token 分层图">` +
    `<rect width="720" height="360" fill="#ffffff"/>` +
    `<text x="24" y="30" font-size="18" font-weight="700">最近 24 小时 Token</text>` +
    `<text x="52" y="62" font-size="11">最大每小时 ${maximum}</text>` +
    `<line x1="52" y1="292" x2="700" y2="292" stroke="#94a3b8"/>` +
    bars +
    `<text x="24" y="338" font-size="11">${escapeXml(note)}</text>` +
    `<g font-size="11">` +
    `<text x="400" y="30" fill="#2563eb">■ 输入</text>` +
    `<text x="470" y="30" fill="#16a34a">■ 输出</text>` +
    `<text x="540" y="30" fill="#7c3aed">■ 推理</text>` +
    `<text x="610" y="30" fill="#f59e0b">■ 缓存</text>` +
    `</g></svg>`;
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

export async function handleUsageChartRequest(
  request: Request,
  config: UsageChartConfig,
  repository: UsageChartSnapshotReader
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const match = /^\/charts\/usage\/([a-f0-9]{64})\.svg$/u.exec(url.pathname);
    const query = /^\?sig=([A-Za-z0-9_-]{43})$/u.exec(url.search);
    if (
      request.method !== "GET" ||
      request.headers.has("Cookie") ||
      request.headers.has("Authorization") ||
      match === null ||
      query === null
    ) return notFound();

    const snapshotId = match[1]!;
    const signature = query[1]!;
    if (!await verifyUsageChartSignature(config.signingSecret, snapshotId, signature)) {
      return notFound();
    }
    const snapshot = await repository.loadUsageChartSnapshot(snapshotId);
    if (!snapshot || snapshot.id !== snapshotId) return notFound();

    const svg = renderUsageChartSvg(parseUsageChartDataV1(snapshot.chartJson));
    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=3600"
      }
    });
  } catch {
    return notFound();
  }
}
