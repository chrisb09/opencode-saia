import test from "node:test";
import assert from "node:assert/strict";
import { parseQuotaHeaders } from "../dist/quota.js";

const WINDOWS = ["10s", "minute", "hour", "day", "month"];

function current(window, limit, remaining) {
  return {
    [`x-ratelimit-limit-requests-${window}`]: String(limit),
    [`x-ratelimit-remaining-requests-${window}`]: String(remaining),
  };
}

function legacy(window, limit, remaining) {
  return {
    [`x-ratelimit-limit-${window}`]: String(limit),
    [`x-ratelimit-remaining-${window}`]: String(remaining),
  };
}

test("parses every current-generation window", () => {
  const headers = new Headers();
  const expected = [];
  WINDOWS.forEach((window, index) => {
    const limit = 100 + index;
    const remaining = 50 + index;
    for (const [name, value] of Object.entries(current(window, limit, remaining))) {
      headers.set(name, value);
    }
    expected.push({ window, limit, remaining });
  });
  assert.deepEqual(parseQuotaHeaders(headers), expected);
});

test("falls back to a complete legacy pair", () => {
  const headers = new Headers(legacy("minute", 60, 12));
  assert.deepEqual(parseQuotaHeaders(headers), [
    { window: "minute", limit: 60, remaining: 12 },
  ]);
});

test("current pair wins over legacy pair for the same window", () => {
  const headers = new Headers({
    ...legacy("minute", 60, 12),
    ...current("minute", 90, 80),
  });
  assert.deepEqual(parseQuotaHeaders(headers), [
    { window: "minute", limit: 90, remaining: 80 },
  ]);
});

test("falls back to legacy when the current pair is incomplete or invalid", () => {
  for (const broken of [
    { "x-ratelimit-limit-requests-minute": "90" },
    { "x-ratelimit-remaining-requests-minute": "80" },
    {
      "x-ratelimit-limit-requests-minute": "nope",
      "x-ratelimit-remaining-requests-minute": "80",
    },
    {
      "x-ratelimit-limit-requests-minute": "90",
      "x-ratelimit-remaining-requests-minute": "91",
    },
  ]) {
    const headers = new Headers({ ...legacy("minute", 60, 12), ...broken });
    assert.deepEqual(parseQuotaHeaders(headers), [
      { window: "minute", limit: 60, remaining: 12 },
    ]);
  }
});

test("never combines current and legacy generations", () => {
  const headers = new Headers({
    "x-ratelimit-limit-requests-minute": "90",
    "x-ratelimit-remaining-minute": "12",
    "x-ratelimit-limit-hour": "100",
    "x-ratelimit-remaining-requests-hour": "80",
  });
  assert.deepEqual(parseQuotaHeaders(headers), []);
});

test("mixes generations only across independent windows", () => {
  const headers = new Headers({
    ...current("minute", 90, 80),
    ...legacy("hour", 1000, 900),
  });
  assert.deepEqual(parseQuotaHeaders(headers), [
    { window: "minute", limit: 90, remaining: 80 },
    { window: "hour", limit: 1000, remaining: 900 },
  ]);
});

test("rejects incomplete pairs", () => {
  assert.deepEqual(
    parseQuotaHeaders(
      new Headers({ "x-ratelimit-limit-requests-minute": "10" }),
    ),
    [],
  );
  assert.deepEqual(
    parseQuotaHeaders(
      new Headers({ "x-ratelimit-remaining-requests-minute": "5" }),
    ),
    [],
  );
  assert.deepEqual(
    parseQuotaHeaders(new Headers({ "x-ratelimit-limit-minute": "10" })),
    [],
  );
});

test("trims values but accepts digits only", () => {
  const headers = new Headers({
    "x-ratelimit-limit-requests-minute": " 10 ",
    "x-ratelimit-remaining-requests-minute": "\t5 ",
  });
  assert.deepEqual(parseQuotaHeaders(headers), [
    { window: "minute", limit: 10, remaining: 5 },
  ]);

  for (const bad of ["", " ", "1.0", "-1", "+1", "1e2", "10x", "0x10", "1_0"]) {
    const invalid = new Headers({
      "x-ratelimit-limit-requests-minute": bad,
      "x-ratelimit-remaining-requests-minute": "5",
    });
    assert.deepEqual(parseQuotaHeaders(invalid), [], `limit ${JSON.stringify(bad)}`);
  }
});

test("enforces safe integer bounds", () => {
  const unsafe = String(Number.MAX_SAFE_INTEGER + 1);
  for (const [limit, remaining] of [
    [unsafe, "1"],
    ["10", unsafe],
    ["0", "0"],
    ["10", "-1"],
    ["10", "11"],
  ]) {
    const headers = new Headers({
      "x-ratelimit-limit-requests-minute": limit,
      "x-ratelimit-remaining-requests-minute": remaining,
    });
    assert.deepEqual(parseQuotaHeaders(headers), [], `${limit}/${remaining}`);
  }

  const max = String(Number.MAX_SAFE_INTEGER);
  const headers = new Headers({
    "x-ratelimit-limit-requests-minute": max,
    "x-ratelimit-remaining-requests-minute": max,
  });
  assert.deepEqual(parseQuotaHeaders(headers), [
    { window: "minute", limit: Number.MAX_SAFE_INTEGER, remaining: Number.MAX_SAFE_INTEGER },
  ]);
});

test("rejects duplicate joined header values", () => {
  const headers = new Headers({
    "x-ratelimit-remaining-requests-minute": "5",
  });
  headers.append("x-ratelimit-limit-requests-minute", "10");
  headers.append("x-ratelimit-limit-requests-minute", "20");
  assert.deepEqual(parseQuotaHeaders(headers), []);

  const remaining = new Headers({
    "x-ratelimit-limit-requests-minute": "10",
  });
  remaining.append("x-ratelimit-remaining-requests-minute", "5");
  remaining.append("x-ratelimit-remaining-requests-minute", "4");
  assert.deepEqual(parseQuotaHeaders(remaining), []);
});

test("header names are case-insensitive", () => {
  const headers = new Headers({
    "X-RateLimit-Limit-Requests-Hour": "100",
    "X-RateLimit-Remaining-Requests-Hour": "75",
  });
  assert.deepEqual(parseQuotaHeaders(headers), [
    { window: "hour", limit: 100, remaining: 75 },
  ]);
});

test("ignores resets, token quotas, and unknown windows", () => {
  const headers = new Headers({
    "x-ratelimit-reset-requests-minute": "10",
    "x-ratelimit-limit-tokens-minute": "1000",
    "x-ratelimit-remaining-tokens-minute": "999",
    "x-ratelimit-limit-requests-week": "100",
    "x-ratelimit-remaining-requests-week": "99",
  });
  assert.deepEqual(parseQuotaHeaders(headers), []);
});

test("returns an empty list without quota headers", () => {
  assert.deepEqual(parseQuotaHeaders(new Headers()), []);
});
