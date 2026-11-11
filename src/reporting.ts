import { parseQuotaHeaders, type Observation } from "./quota.js";

export interface ReporterOptions {
  fetch?: typeof globalThis.fetch;
  warn?: (message: string) => void;
  now?: () => Date;
  timeoutMs?: number;
}

export interface Reporter {
  observe(headers: Headers, observedAt?: string): void;
  dispose(): void;
  idle(): Promise<void>;
}

interface Config {
  endpoint: string;
  token: string;
  authorization?: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 3000;

function isValidHeaderValue(value: string): boolean {
  if (value.length === 0) return false;
  // Reject CR/LF, NUL and other control characters, plus code units above
  // 0xff: fetch requires header values to be ByteStrings. Horizontal tab is
  // allowed.
  return !/[\u0000-\u0008\u000a-\u001f\u007f\u0100-\uffff]/.test(value);
}

function isBasicAuthorization(value: string): boolean {
  const match = /^Basic[ \t]+(\S+)$/i.exec(value.trim());
  const encoded = match?.[1];
  if (encoded === undefined || encoded.length === 0) return false;
  if (encoded.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  try {
    const decoded = Buffer.from(encoded, "base64");
    return decoded.length > 0 && decoded.toString("base64") === encoded;
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
  );
}

function buildEndpoint(url: URL): string {
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/api/saia/observations`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function readConfig(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
  timeoutMs: number,
): Config | undefined {
  const rawUrl =
    typeof env?.SAIA_AI_USAGE_URL === "string" ? env.SAIA_AI_USAGE_URL : "";
  const rawToken =
    typeof env?.SAIA_AI_USAGE_UPLOAD_TOKEN === "string"
      ? env.SAIA_AI_USAGE_UPLOAD_TOKEN
      : "";
  const urlText = rawUrl.trim();
  const tokenPresent = rawToken.trim() !== "";

  if (urlText === "" && !tokenPresent) return undefined;

  if (urlText === "" || !tokenPresent) {
    warn(
      "opencode-saia: ai_usage reporting disabled: SAIA_AI_USAGE_URL and SAIA_AI_USAGE_UPLOAD_TOKEN must both be set",
    );
    return undefined;
  }

  if (!isValidHeaderValue(rawToken) || rawToken !== rawToken.trim()) {
    warn(
      "opencode-saia: ai_usage reporting disabled: SAIA_AI_USAGE_UPLOAD_TOKEN is not a valid header value",
    );
    return undefined;
  }

  const apiKey =
    typeof env?.SAIA_API_KEY === "string" ? env.SAIA_API_KEY : "";
  if (apiKey !== "" && rawToken === apiKey) {
    warn(
      "opencode-saia: ai_usage reporting disabled: SAIA_AI_USAGE_UPLOAD_TOKEN must not equal SAIA_API_KEY",
    );
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    warn(
      "opencode-saia: ai_usage reporting disabled: SAIA_AI_USAGE_URL is not a valid URL",
    );
    return undefined;
  }

  if (url.username !== "" || url.password !== "") {
    warn(
      "opencode-saia: ai_usage reporting disabled: SAIA_AI_USAGE_URL must not contain userinfo",
    );
    return undefined;
  }

  if (url.search !== "" || url.hash !== "") {
    warn(
      "opencode-saia: ai_usage reporting disabled: SAIA_AI_USAGE_URL must not contain a query or fragment",
    );
    return undefined;
  }

  const https = url.protocol === "https:";
  const localHttp = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (!https && !localHttp) {
    warn(
      "opencode-saia: ai_usage reporting disabled: SAIA_AI_USAGE_URL must use HTTPS, or HTTP on 127.0.0.1 or [::1]",
    );
    return undefined;
  }

  let authorization: string | undefined;
  const rawProxy =
    typeof env?.SAIA_AI_USAGE_PROXY_AUTHORIZATION === "string"
      ? env.SAIA_AI_USAGE_PROXY_AUTHORIZATION
      : "";
  if (rawProxy.trim() !== "") {
    if (!isValidHeaderValue(rawProxy)) {
      warn(
        "opencode-saia: ai_usage reporting disabled: SAIA_AI_USAGE_PROXY_AUTHORIZATION is not a valid header value",
      );
      return undefined;
    }
    if (!isBasicAuthorization(rawProxy)) {
      warn(
        "opencode-saia: ai_usage reporting disabled: SAIA_AI_USAGE_PROXY_AUTHORIZATION must be a Basic base64 authorization value",
      );
      return undefined;
    }
    authorization = rawProxy;
  }

  return {
    endpoint: buildEndpoint(url),
    token: rawToken,
    authorization,
    timeoutMs,
  };
}

function timestampValue(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isNewer(candidate: string, current: string): boolean {
  const a = timestampValue(candidate);
  const b = timestampValue(current);
  if (a !== undefined && b !== undefined) return a > b;
  if (a !== undefined) return true;
  if (b !== undefined) return false;
  return candidate > current;
}

function payload(snapshot: Observation): string {
  return JSON.stringify({
    observedAt: snapshot.observedAt,
    windows: snapshot.windows.map(({ window, limit, remaining }) => ({
      window,
      limit,
      remaining,
    })),
  });
}

export function createReporter(
  env: NodeJS.ProcessEnv,
  options: ReporterOptions = {},
): Reporter {
  const warned = new Set<string>();
  const warn = (message: string): void => {
    if (warned.has(message)) return;
    warned.add(message);
    try {
      options.warn?.(message);
    } catch {
      // A failing warning sink must never escape.
    }
  };

  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const config = readConfig(env, warn, timeoutMs);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  let disposed = false;
  let active: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let pending: Observation | undefined;

  function currentTimestamp(): string | undefined {
    try {
      const value = now();
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
      }
    } catch {
      // Fall through: no timestamp means no upload.
    }
    return undefined;
  }

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-AI-Usage-Token": config!.token,
    };
    if (config!.authorization !== undefined) {
      headers.Authorization = config!.authorization;
    }
    return headers;
  }

  function start(snapshot: Observation): void {
    const abort = new AbortController();
    controller = abort;
    const running = upload(snapshot, abort)
      .catch(() => {
        // upload() reports its own failures; never reject from the queue.
      })
      .finally(() => {
        if (controller === abort) controller = undefined;
        if (active === running) active = undefined;
        if (!disposed && pending !== undefined) {
          const next = pending;
          pending = undefined;
          start(next);
        }
      });
    active = running;
  }

  function observe(headers: Headers, observedAt?: string): void {
    if (disposed || config === undefined) return;
    try {
      const windows = parseQuotaHeaders(headers);
      if (windows.length === 0) return;
      const timestamp =
        observedAt !== undefined ? observedAt : currentTimestamp();
      if (timestamp === undefined) return;
      const snapshot: Observation = { observedAt: timestamp, windows };

      if (active !== undefined) {
        if (
          pending === undefined ||
          isNewer(snapshot.observedAt, pending.observedAt)
        ) {
          pending = snapshot;
        }
        return;
      }
      start(snapshot);
    } catch {
      // observe() must never throw.
    }
  }

  function dispose(): void {
    disposed = true;
    pending = undefined;
    if (controller !== undefined) {
      try {
        controller.abort();
      } catch {
        // Ignore abort failures.
      }
      controller = undefined;
    }
    active = undefined;
  }

  async function idle(): Promise<void> {
    while (active !== undefined) {
      await active.catch(() => {
        // The queue never rejects; this is defensive.
      });
    }
  }

  return { observe, dispose, idle };

  async function upload(
    snapshot: Observation,
    abort: AbortController,
  ): Promise<void> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = fetchImpl(config!.endpoint, {
      method: "POST",
      headers: buildHeaders(),
      body: payload(snapshot),
      redirect: "error",
      signal: abort.signal,
    });

    const timeout = new Promise<Response>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          abort.abort();
        } catch {
          // Ignore abort failures.
        }
        reject(new Error("timeout"));
      }, config!.timeoutMs);
    });

    try {
      const response = await Promise.race([request, timeout]);
      const status = response.status;

      if (status >= 200 && status < 300) {
        discardBody(response);
        return;
      }

      discardBody(response);
      if (!disposed) {
        warn(`opencode-saia: ai_usage upload failed (HTTP ${status})`);
      }
    } catch {
      if (timedOut) {
        // The request may settle after the timeout; release a late body.
        request.then(discardBody).catch(() => {});
      }
      if (!disposed) {
        if (timedOut) {
          warn("opencode-saia: ai_usage upload timed out");
        } else {
          warn("opencode-saia: ai_usage upload failed (network error)");
        }
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function discardBody(response: Response): void {
  try {
    if (response.body !== null && response.body !== undefined) {
      const canceled = response.body.cancel();
      if (canceled !== undefined && typeof canceled.catch === "function") {
        canceled.catch(() => {
          // The body may already be consumed or unavailable.
        });
      }
    }
  } catch {
    // The body may already be consumed or unavailable.
  }
}
