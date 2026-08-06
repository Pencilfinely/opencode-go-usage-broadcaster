import { parseSessionBundle } from "./opencode-session";

export interface AppConfig {
  sourceName: "fixture" | "opencode-console";
  fixtureJson: string;
  consoleEnabled: boolean;
  authGeneration: string;
  manualTriggerSecret: string;
  sessionBundle?: string;
  pushplus: {
    token: string;
    topic: string;
    callbackSecret: string;
    callbackBaseUrl: string;
  };
  usageChart: {
    publicBaseUrl: string;
    signingSecret: string;
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error("Missing required binding: " + name);
  return value;
}

const UNAVAILABLE_AUTH_GENERATION = "unavailable-session-bundle";

function sessionAuthGeneration(raw: string | undefined): string {
  if (raw === undefined) return UNAVAILABLE_AUTH_GENERATION;
  try {
    return parseSessionBundle(raw).generation;
  } catch {
    return UNAVAILABLE_AUTH_GENERATION;
  }
}

export function loadConfig(env: Cloudflare.Env): AppConfig {
  const bindings = env as unknown as Record<string, string | undefined>;
  const sourceName = bindings.USAGE_SOURCE;
  if (sourceName !== "fixture" && sourceName !== "opencode-console") {
    throw new Error("USAGE_SOURCE must be fixture or opencode-console");
  }

  const callbackBase = new URL(
    required(bindings.PUSHPLUS_CALLBACK_BASE_URL, "PUSHPLUS_CALLBACK_BASE_URL")
  );
  if (
    callbackBase.protocol !== "https:" &&
    callbackBase.origin !== "http://localhost:8787"
  ) {
    throw new Error("PUSHPLUS_CALLBACK_BASE_URL must use HTTPS");
  }
  if (callbackBase.username || callbackBase.password) {
    throw new Error("PUSHPLUS_CALLBACK_BASE_URL must not contain user info");
  }
  if (
    callbackBase.pathname !== "/" ||
    callbackBase.search ||
    callbackBase.hash
  ) {
    throw new Error("PUSHPLUS_CALLBACK_BASE_URL must be an origin only");
  }
  if (
    callbackBase.protocol === "https:" &&
    callbackBase.port &&
    callbackBase.port !== "443"
  ) {
    throw new Error("PUSHPLUS_CALLBACK_BASE_URL must use the standard port");
  }

  const callbackSecret = required(
    bindings.PUSHPLUS_CALLBACK_SECRET,
    "PUSHPLUS_CALLBACK_SECRET"
  );
  if (callbackSecret.length < 32) {
    throw new Error("PUSHPLUS_CALLBACK_SECRET must be at least 32 characters");
  }

  const manualTriggerSecret = required(
    bindings.MANUAL_TRIGGER_SECRET,
    "MANUAL_TRIGGER_SECRET"
  );
  if (manualTriggerSecret.length < 32) {
    throw new Error("MANUAL_TRIGGER_SECRET must be at least 32 characters");
  }

  const publicBase = new URL(required(bindings.PUBLIC_BASE_URL, "PUBLIC_BASE_URL"));
  if (publicBase.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS");
  }
  if (publicBase.username || publicBase.password) {
    throw new Error("PUBLIC_BASE_URL must not contain user info");
  }
  if (publicBase.pathname !== "/" || publicBase.search || publicBase.hash) {
    throw new Error("PUBLIC_BASE_URL must be an origin only");
  }
  if (publicBase.port && publicBase.port !== "443") {
    throw new Error("PUBLIC_BASE_URL must use the standard port");
  }
  const usageChartSigningSecret = required(
    bindings.USAGE_CHART_SIGNING_SECRET,
    "USAGE_CHART_SIGNING_SECRET"
  );
  if (usageChartSigningSecret.length < 32) {
    throw new Error("USAGE_CHART_SIGNING_SECRET must be at least 32 characters");
  }

  const consoleEnabled = bindings.OPENCODE_CONSOLE_ENABLED === "true";
  const sessionBundle = sourceName === "opencode-console" && consoleEnabled
    ? bindings.OPENCODE_SESSION_BUNDLE
    : undefined;

  return {
    sourceName,
    fixtureJson: bindings.USAGE_FIXTURE_JSON ?? "",
    consoleEnabled,
    manualTriggerSecret,
    authGeneration: sourceName === "opencode-console" && consoleEnabled
      ? sessionAuthGeneration(sessionBundle)
      : required(bindings.OPENCODE_AUTH_GENERATION, "OPENCODE_AUTH_GENERATION"),
    ...(sessionBundle === undefined ? {} : { sessionBundle }),
    pushplus: {
      token: required(bindings.PUSHPLUS_TOKEN, "PUSHPLUS_TOKEN"),
      topic: required(bindings.PUSHPLUS_TOPIC, "PUSHPLUS_TOPIC"),
      callbackSecret,
      callbackBaseUrl: callbackBase.origin
    },
    usageChart: {
      publicBaseUrl: publicBase.origin,
      signingSecret: usageChartSigningSecret
    }
  };
}
