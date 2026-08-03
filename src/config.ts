export interface AppConfig {
  sourceName: "fixture" | "opencode-console";
  fixtureJson: string;
  consoleEnabled: boolean;
  authGeneration: string;
  pushplus: {
    token: string;
    topic: string;
    callbackSecret: string;
    callbackBaseUrl: string;
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error("Missing required binding: " + name);
  return value;
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

  return {
    sourceName,
    fixtureJson: bindings.USAGE_FIXTURE_JSON ?? "",
    consoleEnabled: bindings.OPENCODE_CONSOLE_ENABLED === "true",
    authGeneration: required(
      bindings.OPENCODE_AUTH_GENERATION,
      "OPENCODE_AUTH_GENERATION"
    ),
    pushplus: {
      token: required(bindings.PUSHPLUS_TOKEN, "PUSHPLUS_TOKEN"),
      topic: required(bindings.PUSHPLUS_TOPIC, "PUSHPLUS_TOPIC"),
      callbackSecret,
      callbackBaseUrl: callbackBase.origin
    }
  };
}
