import test from "node:test";
import assert from "node:assert/strict";
import { createReporter } from "../dist/reporting.js";

function quotaHeaders(extra = {}) {
  return new Headers({
    "x-ratelimit-limit-requests-minute": "100",
    "x-ratelimit-remaining-requests-minute": "42",
    ...extra,
  });
}

function env(overrides = {}) {
  return {
    SAIA_AI_USAGE_URL: "https://usage.example.test",
    SAIA_AI_USAGE_UPLOAD_TOKEN: "upload-secret",
    ...overrides,
  };
}

function response(status = 202, body = null) {
  return new Response(body, { status });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("disabled without URL and token", async () => {
  const warnings = [];
  let calls = 0;
  const reporter = createReporter(
    {},
    {
      fetch: async () => {
        calls += 1;
        return response();
      },
      warn: (message) => warnings.push(message),
    },
  );
  reporter.observe(quotaHeaders());
  await reporter.idle();
  assert.equal(calls, 0);
  assert.deepEqual(warnings, []);
  reporter.dispose();
});

test("partial configuration warns and disables", async () => {
  for (const partial of [
    { SAIA_AI_USAGE_URL: "https://usage.example.test" },
    { SAIA_AI_USAGE_UPLOAD_TOKEN: "upload-secret" },
  ]) {
    const warnings = [];
    let calls = 0;
    const reporter = createReporter(partial, {
      fetch: async () => {
        calls += 1;
        return response();
      },
      warn: (message) => warnings.push(message),
    });
    reporter.observe(quotaHeaders());
    await reporter.idle();
    assert.equal(calls, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /disabled/);
    assert.ok(!warnings[0].includes("upload-secret"));
    reporter.dispose();
  }
});

test("bad configuration warns without values and disables", async () => {
  const cases = [
    { SAIA_AI_USAGE_URL: "not a url" },
    { SAIA_AI_USAGE_URL: "http://usage.example.test" },
    { SAIA_AI_USAGE_URL: "http://localhost:8080" },
    { SAIA_AI_USAGE_URL: "http://127.0.0.2:8080" },
    { SAIA_AI_USAGE_URL: "https://user:pass@usage.example.test" },
    { SAIA_AI_USAGE_URL: "https://usage.example.test?token=secret" },
    { SAIA_AI_USAGE_URL: "https://usage.example.test#secret" },
    { SAIA_AI_USAGE_UPLOAD_TOKEN: "abc\r\nx-evil: 1" },
    {
      SAIA_AI_USAGE_PROXY_AUTHORIZATION: "Basic abc\r\nx-evil: 1",
    },
  ];
  for (const overrides of cases) {
    const warnings = [];
    let calls = 0;
    const reporter = createReporter(env(overrides), {
      fetch: async () => {
        calls += 1;
        return response();
      },
      warn: (message) => warnings.push(message),
    });
    reporter.observe(quotaHeaders());
    await reporter.idle();
    assert.equal(calls, 0, JSON.stringify(overrides));
    assert.equal(warnings.length, 1, JSON.stringify(overrides));
    assert.match(warnings[0], /disabled/);
    assert.ok(!warnings[0].includes("secret"));
    assert.ok(!warnings[0].includes("pass"));
    reporter.dispose();
  }
});

test("allows HTTP only on literal loopback hosts", async () => {
  for (const base of [
    "http://127.0.0.1:8787",
    "http://[::1]:8787/base/",
  ]) {
    let called;
    const reporter = createReporter(env({ SAIA_AI_USAGE_URL: base }), {
      fetch: async (url) => {
        called = String(url);
        return response();
      },
    });
    reporter.observe(quotaHeaders());
    await reporter.idle();
    assert.ok(called, base);
    assert.ok(called.startsWith(base.replace(/\/$/, "")), base);
    assert.ok(called.endsWith("/api/saia/observations"), base);
    reporter.dispose();
  }
});

test("preserves an optional HTTPS base path", async () => {
  let called;
  const reporter = createReporter(
    env({ SAIA_AI_USAGE_URL: "https://usage.example.test/base/" }),
    {
      fetch: async (url) => {
        called = String(url);
        return response();
      },
    },
  );
  reporter.observe(quotaHeaders());
  await reporter.idle();
  assert.equal(called, "https://usage.example.test/base/api/saia/observations");
  reporter.dispose();
});

test("sends only allowlisted headers and body", async () => {
  let call;
  const reporter = createReporter(
    env({ SAIA_AI_USAGE_PROXY_AUTHORIZATION: "Basic dXNlcjpwYXNz" }),
    {
      fetch: async (url, init) => {
        call = { url, init };
        return response();
      },
    },
  );
  reporter.observe(
    quotaHeaders({
      authorization: "Bearer saia-secret",
      "x-saia-key": "saia-secret",
      "content-type": "text/plain",
    }),
    "2026-01-02T03:04:05.000Z",
  );
  await reporter.idle();

  const names = Object.keys(call.init.headers)
    .map((name) => name.toLowerCase())
    .sort();
  assert.deepEqual(names, ["authorization", "content-type", "x-ai-usage-token"]);
  assert.equal(call.init.headers["X-AI-Usage-Token"], "upload-secret");
  assert.equal(call.init.headers.Authorization, "Basic dXNlcjpwYXNz");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.headers["Content-Type"], "application/json");

  const body = JSON.parse(call.init.body);
  assert.deepEqual(Object.keys(body).sort(), ["observedAt", "windows"]);
  assert.equal(body.observedAt, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(body.windows, [
    { window: "minute", limit: 100, remaining: 42 },
  ]);
  assert.ok(!call.init.body.includes("saia-secret"));
  assert.ok(!call.init.body.includes("upload-secret"));
  reporter.dispose();
});

test("does not send Authorization without proxy authorization", async () => {
  let headers;
  const reporter = createReporter(env(), {
    fetch: async (_url, init) => {
      headers = init.headers;
      return response();
    },
  });
  reporter.observe(quotaHeaders());
  await reporter.idle();
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["X-AI-Usage-Token"], "upload-secret");
  reporter.dispose();
});

test("does not upload without parsed windows", async () => {
  let calls = 0;
  const reporter = createReporter(env(), {
    fetch: async () => {
      calls += 1;
      return response();
    },
  });
  reporter.observe(
    new Headers({ authorization: "Bearer saia-secret", "x-saia-key": "secret" }),
  );
  await reporter.idle();
  assert.equal(calls, 0);
  reporter.dispose();
});

test("202 accepted true and false are both success", async () => {
  const warnings = [];
  const bodies = [];
  const reporter = createReporter(env(), {
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ accepted: bodies.length === 1 }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    },
    warn: (message) => warnings.push(message),
  });
  reporter.observe(quotaHeaders(), "2026-01-01T00:00:00.000Z");
  await reporter.idle();
  reporter.observe(quotaHeaders(), "2026-01-01T00:00:01.000Z");
  await reporter.idle();
  assert.equal(bodies.length, 2);
  assert.deepEqual(warnings, []);
  reporter.dispose();
});

test("cancels unconsumed response bodies", async () => {
  let canceled = 0;
  const reporter = createReporter(env(), {
    fetch: async () => ({
      status: 202,
      body: {
        cancel: async () => {
          canceled += 1;
        },
      },
    }),
  });
  reporter.observe(quotaHeaders());
  await reporter.idle();
  assert.equal(canceled, 1);
  reporter.dispose();
});

test("failed HTTP statuses warn without blocking or leaking details", async () => {
  for (const status of [400, 401, 404, 429, 500, 503]) {
    const warnings = [];
    const reporter = createReporter(env(), {
      fetch: async () => response(status),
      warn: (message) => warnings.push(message),
    });
    reporter.observe(quotaHeaders());
    await reporter.idle();
    assert.equal(warnings.length, 1, String(status));
    assert.match(warnings[0], new RegExp(`HTTP ${status}`));
    assert.ok(!warnings[0].includes("upload-secret"));
    reporter.dispose();
  }
});

test("rejects redirects", async () => {
  const warnings = [];
  let init;
  const reporter = createReporter(env(), {
    fetch: async (_url, options) => {
      init = options;
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.test" },
      });
    },
    warn: (message) => warnings.push(message),
  });
  reporter.observe(quotaHeaders());
  await reporter.idle();
  assert.equal(init.redirect, "error");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /HTTP 302/);
  reporter.dispose();
});

test("network failures warn with sanitized text and do not retry", async () => {
  const warnings = [];
  let calls = 0;
  const reporter = createReporter(env(), {
    fetch: async () => {
      calls += 1;
      throw new Error("boom upload-secret");
    },
    warn: (message) => warnings.push(message),
  });
  reporter.observe(quotaHeaders());
  await reporter.idle();
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /network error/);
  assert.ok(!warnings[0].includes("upload-secret"));
  assert.ok(!warnings[0].includes("boom"));
  reporter.dispose();
});

test("timeouts warn and settle even if fetch ignores abort", async () => {
  const warnings = [];
  const reporter = createReporter(env(), {
    fetch: () => new Promise(() => {}),
    warn: (message) => warnings.push(message),
    timeoutMs: 20,
  });
  reporter.observe(quotaHeaders());
  await reporter.idle();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /timed out/);
  reporter.dispose();
});

test("warning callback failures do not escape", async () => {
  const reporter = createReporter(env(), {
    fetch: async () => response(500),
    warn: () => {
      throw new Error("warn sink failed");
    },
  });
  assert.doesNotThrow(() => reporter.observe(quotaHeaders()));
  await reporter.idle();
  reporter.dispose();
});

test("observe returns before the network completes", async () => {
  const gate = deferred();
  let calls = 0;
  const reporter = createReporter(env(), {
    fetch: () => {
      calls += 1;
      return gate.promise;
    },
    timeoutMs: 1000,
  });
  reporter.observe(quotaHeaders());
  assert.equal(calls, 1);
  let drained = false;
  const idle = reporter.idle().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  gate.resolve(response());
  await idle;
  assert.equal(drained, true);
  reporter.dispose();
});

test("keeps one in-flight upload and the newest pending snapshot", async () => {
  const gates = [];
  const bodies = [];
  let calls = 0;
  const reporter = createReporter(env(), {
    fetch: async (_url, init) => {
      calls += 1;
      bodies.push(JSON.parse(init.body));
      return new Promise((resolve) => gates.push(resolve));
    },
    timeoutMs: 1000,
  });

  reporter.observe(quotaHeaders(), "2026-01-01T00:00:01.000Z");
  reporter.observe(quotaHeaders(), "2026-01-01T00:00:03.000Z");
  reporter.observe(quotaHeaders(), "2026-01-01T00:00:02.000Z");
  assert.equal(calls, 1);

  gates[0](response());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);
  assert.equal(bodies[1].observedAt, "2026-01-01T00:00:03.000Z");

  gates[1](response());
  await reporter.idle();
  assert.equal(calls, 2);
  reporter.dispose();
});

test("dispose aborts the active upload and clears pending work", async () => {
  let signal;
  let calls = 0;
  const gate = deferred();
  const reporter = createReporter(env(), {
    fetch: (_url, init) => {
      calls += 1;
      signal = init.signal;
      return gate.promise;
    },
    timeoutMs: 1000,
  });

  reporter.observe(quotaHeaders(), "2026-01-01T00:00:01.000Z");
  reporter.observe(quotaHeaders(), "2026-01-01T00:00:02.000Z");
  reporter.dispose();
  assert.equal(signal.aborted, true);
  await reporter.idle();

  gate.resolve(response());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
});

test("uses observedAt verbatim and defaults to now", async () => {
  const bodies = [];
  const fixed = new Date("2026-05-06T07:08:09.000Z");
  const reporter = createReporter(env(), {
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return response();
    },
    now: () => fixed,
  });

  reporter.observe(quotaHeaders());
  await reporter.idle();
  assert.equal(bodies[0].observedAt, fixed.toISOString());

  reporter.observe(quotaHeaders(), "not-a-date");
  await reporter.idle();
  assert.equal(bodies[1].observedAt, "not-a-date");
  reporter.dispose();
});

test("does not carry missing windows forward", async () => {
  const bodies = [];
  const reporter = createReporter(env(), {
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return response();
    },
  });

  reporter.observe(quotaHeaders(), "2026-01-01T00:00:00.000Z");
  await reporter.idle();
  reporter.observe(
    new Headers({
      "x-ratelimit-limit-requests-hour": "1000",
      "x-ratelimit-remaining-requests-hour": "900",
    }),
    "2026-01-01T00:00:01.000Z",
  );
  await reporter.idle();

  assert.deepEqual(bodies[0].windows, [
    { window: "minute", limit: 100, remaining: 42 },
  ]);
  assert.deepEqual(bodies[1].windows, [
    { window: "hour", limit: 1000, remaining: 900 },
  ]);
  reporter.dispose();
});

test("rejects non-Basic or malformed proxy authorization", async () => {
  for (const value of [
    "Bearer abc",
    "Basic !!!",
    "Basic abc",
    "Basic YR==",
    "Basic ",
  ]) {
    const warnings = [];
    let calls = 0;
    const reporter = createReporter(
      env({ SAIA_AI_USAGE_PROXY_AUTHORIZATION: value }),
      {
        fetch: async () => {
          calls += 1;
          return response();
        },
        warn: (message) => warnings.push(message),
      },
    );
    reporter.observe(quotaHeaders());
    await reporter.idle();
    assert.equal(calls, 0, value);
    assert.equal(warnings.length, 1, value);
    assert.match(warnings[0], /Basic base64/);
    reporter.dispose();
  }
});

test("rejects header values with code units above 0xff", async () => {
  for (const overrides of [
    { SAIA_AI_USAGE_UPLOAD_TOKEN: "abc\u0100" },
    { SAIA_AI_USAGE_PROXY_AUTHORIZATION: "Basic dXNlcjpwYXNz\u0100" },
  ]) {
    const warnings = [];
    let calls = 0;
    const reporter = createReporter(env(overrides), {
      fetch: async () => {
        calls += 1;
        return response();
      },
      warn: (message) => warnings.push(message),
    });
    reporter.observe(quotaHeaders());
    await reporter.idle();
    assert.equal(calls, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /valid header value/);
    reporter.dispose();
  }
});

test("disables when the upload token equals SAIA_API_KEY", async () => {
  const warnings = [];
  let calls = 0;
  const reporter = createReporter(
    env({
      SAIA_AI_USAGE_UPLOAD_TOKEN: "same-secret",
      SAIA_API_KEY: "same-secret",
    }),
    {
      fetch: async () => {
        calls += 1;
        return response();
      },
      warn: (message) => warnings.push(message),
    },
  );
  reporter.observe(quotaHeaders());
  await reporter.idle();
  assert.equal(calls, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /must not equal SAIA_API_KEY/);
  assert.ok(!warnings[0].includes("same-secret"));
  reporter.dispose();
});

test("does not wait for a hanging response body cancel", async () => {
  let canceled = false;
  const reporter = createReporter(env(), {
    fetch: async () => ({
      status: 202,
      body: {
        cancel: () => {
          canceled = true;
          return new Promise(() => {});
        },
      },
    }),
    timeoutMs: 1000,
  });
  reporter.observe(quotaHeaders());
  const result = await Promise.race([
    reporter.idle().then(() => "drained"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 100)),
  ]);
  assert.equal(result, "drained");
  assert.equal(canceled, true);
  reporter.dispose();
});
