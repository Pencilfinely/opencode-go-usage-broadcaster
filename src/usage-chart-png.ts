import type { UsageAggregate } from "./usage-domain";
import {
  parseUsageChartDataV1,
  renderUsageChartSvg,
  serializeUsageChartData
} from "./usage-chart";

const PNG_WIDTH = 720;
const PNG_HEIGHT = 360;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_PNG_BYTES = 2 * 1024 * 1024;

export interface RenderedUsageChartPng {
  bytes: Uint8Array;
  browserMs: number | null;
}

export class UsageChartPngError extends Error {
  constructor() {
    super("usage_chart_png_invalid");
    this.name = "UsageChartPngError";
  }
}

function renderHtml(svg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" ` +
    `content="default-src 'none'; style-src 'unsafe-inline'">` +
    `<style>html,body{margin:0;width:720px;height:360px;background:#fff}` +
    `body>svg{display:block;width:720px;height:360px}</style></head>` +
    `<body>${svg}</body></html>`;
}

function browserMs(response: Response): number | null {
  const header = response.headers.get("X-Browser-Ms-Used");
  if (header === null || header.trim() === "") return null;
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function validPng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 24) return false;
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(8) === 13 &&
    bytes[12] === 0x49 && bytes[13] === 0x48 &&
    bytes[14] === 0x44 && bytes[15] === 0x52 &&
    view.getUint32(16) === PNG_WIDTH && view.getUint32(20) === PNG_HEIGHT;
}

async function readPng(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new UsageChartPngError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_PNG_BYTES) {
        await reader.cancel();
        throw new UsageChartPngError();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof UsageChartPngError) throw error;
    throw new UsageChartPngError();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function renderUsageChartPng(
  browser: Pick<BrowserRun, "quickAction">,
  aggregate: UsageAggregate
): Promise<RenderedUsageChartPng> {
  const data = parseUsageChartDataV1(serializeUsageChartData(aggregate));
  const response = await browser.quickAction("screenshot", {
    html: renderHtml(renderUsageChartSvg(data)),
    viewport: { width: PNG_WIDTH, height: PNG_HEIGHT, deviceScaleFactor: 1 },
    selector: "body > svg",
    setJavaScriptEnabled: false,
    actionTimeout: 10_000,
    cacheTTL: 0,
    screenshotOptions: {
      type: "png",
      encoding: "binary",
      omitBackground: false
    }
  });
  if (response.status !== 200 || !response.headers.get("Content-Type")
    ?.toLowerCase().startsWith("image/png")) {
    throw new UsageChartPngError();
  }

  const bytes = await readPng(response);
  if (!validPng(bytes)) throw new UsageChartPngError();
  return { bytes, browserMs: browserMs(response) };
}
