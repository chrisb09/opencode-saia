export interface QuotaWindow {
  window: "10s" | "minute" | "hour" | "day" | "month";
  limit: number;
  remaining: number;
}

export interface Observation {
  observedAt: string;
  windows: QuotaWindow[];
}

const WINDOWS = ["10s", "minute", "hour", "day", "month"] as const;

type WindowName = (typeof WINDOWS)[number];

function parseInteger(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parsePair(
  headers: Headers,
  limitName: string,
  remainingName: string,
): { limit: number; remaining: number } | undefined {
  const limit = parseInteger(headers.get(limitName));
  const remaining = parseInteger(headers.get(remainingName));
  if (limit === undefined || remaining === undefined) return undefined;
  if (limit <= 0) return undefined;
  if (remaining < 0 || remaining > limit) return undefined;
  return { limit, remaining };
}

export function parseQuotaHeaders(headers: Headers): QuotaWindow[] {
  if (!headers || typeof headers.get !== "function") return [];

  const windows: QuotaWindow[] = [];

  for (const window of WINDOWS) {
    const current = parsePair(
      headers,
      `x-ratelimit-limit-requests-${window}`,
      `x-ratelimit-remaining-requests-${window}`,
    );

    // A legacy pair is only used as a whole; never mix current and legacy
    // generations for the same window.
    const legacy =
      current === undefined
        ? parsePair(
            headers,
            `x-ratelimit-limit-${window}`,
            `x-ratelimit-remaining-${window}`,
          )
        : undefined;

    const pair = current ?? legacy;
    if (pair !== undefined) {
      windows.push({ window, limit: pair.limit, remaining: pair.remaining });
    }
  }

  return windows;
}
