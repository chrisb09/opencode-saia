import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { createReporter } from "../dist/reporting.js"

test("real HTTP uploads never follow a redirect carrying the upload credentials", async (t) => {
  const received = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    received.push({ url: request.url, headers: request.headers, body })
    response.writeHead(302, { Location: "/must-not-receive-credentials" })
    response.end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  const warnings = []
  const reporter = createReporter({
    SAIA_API_KEY: "never-upload-saia-key",
    SAIA_AI_USAGE_URL: `http://127.0.0.1:${server.address().port}/prefix`,
    SAIA_AI_USAGE_UPLOAD_TOKEN: "upload-secret",
    SAIA_AI_USAGE_PROXY_AUTHORIZATION: "Basic cHJveHk6c2VjcmV0",
  }, { warn: (message) => warnings.push(message) })
  t.after(() => reporter.dispose())
  reporter.observe(new Headers({
    "x-ratelimit-limit-requests-day": "800",
    "x-ratelimit-remaining-requests-day": "799",
    authorization: "Bearer never-upload-saia-key",
    "x-private-prompt": "never-upload-prompt",
  }))
  await reporter.idle()
  assert.equal(received.length, 1)
  assert.equal(received[0].url, "/prefix/api/saia/observations")
  assert.equal(received[0].headers["x-ai-usage-token"], "upload-secret")
  assert.equal(received[0].headers.authorization, "Basic cHJveHk6c2VjcmV0")
  const serialized = JSON.stringify(received)
  assert.ok(!serialized.includes("never-upload-saia-key"))
  assert.ok(!serialized.includes("never-upload-prompt"))
  assert.deepEqual(Object.keys(JSON.parse(received[0].body)).sort(), ["observedAt", "windows"])
  assert.ok(warnings.length > 0)
  assert.ok(!warnings.join(" ").includes("upload-secret"))
})
