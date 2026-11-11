import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { apiKeyFrom, accountReporter } from "../dist/auth.js"
import { readV1ApiKey } from "../dist/v1.js"

test("V1 reads only the SAIA API key from its native credential file without changing it", async () => {
  const home = await mkdtemp("/tmp/opencode/saia-auth-")
  const directory = path.join(home, "opencode")
  await mkdir(directory)
  const file = path.join(directory, "auth.json")
  const contents = JSON.stringify({ saia: { type: "api", key: "saved-saia-key" }, other: { type: "api", key: "other-private-key" } })
  await writeFile(file, contents, { mode: 0o600 })
  assert.equal(await readV1ApiKey({ XDG_DATA_HOME: home }), "saved-saia-key")
  assert.equal(await readFile(file, "utf8"), contents)
  assert.equal(await readV1ApiKey({ XDG_DATA_HOME: home, OPENCODE_AUTH_CONTENT: JSON.stringify({ saia: { type: "api", key: "inline-key" } }) }), "inline-key")
  assert.equal(await readV1ApiKey({ XDG_DATA_HOME: home, OPENCODE_AUTH_CONTENT: "{}" }), undefined)
  assert.equal(await readV1ApiKey({ XDG_DATA_HOME: path.join(home, "absent") }), undefined)
  await writeFile(file, "not json: private-key")
  await assert.rejects(readV1ApiKey({ XDG_DATA_HOME: home }), { message: "Unable to read the saved SAIA credential" })
})

test("extracts only API-key credentials and sanitizes malformed keys", () => {
  assert.equal(apiKeyFrom({ type: "api", key: "v1-key" }), "v1-key")
  assert.equal(apiKeyFrom({ type: "key", key: "v2-key" }), "v2-key")
  assert.equal(apiKeyFrom({ type: "key", key: "  copied-key  " }), "copied-key")
  assert.equal(apiKeyFrom({ type: "oauth", access: "not-an-api-key" }), undefined)
  assert.equal(apiKeyFrom(undefined), undefined)
  assert.throws(() => apiKeyFrom({ type: "api", key: "secret\nkey" }), { message: "Invalid SAIA API key" })
})

test("account reporter blocks mixing different saved-key quota scopes", async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const uploads = [], warnings = []
  globalThis.fetch = async (url, init) => { uploads.push(init); return Response.json({ accepted: true }, { status: 202 }) }
  const reporter = accountReporter({ SAIA_AI_USAGE_URL: "https://usage.example", SAIA_AI_USAGE_UPLOAD_TOKEN: "upload-token" }, (message) => warnings.push(message))
  t.after(() => reporter.dispose())
  const headers = new Headers({ "x-ratelimit-limit-hour": "400", "x-ratelimit-remaining-hour": "399" })
  reporter.activate("first-key")
  reporter.observe(headers, new Date().toISOString(), "other-key")
  reporter.observe(headers, new Date().toISOString(), "first-key")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(uploads.length, 1)
  reporter.activate("second-key")
  reporter.observe(headers, new Date().toISOString(), "second-key")
  reporter.observe(headers, new Date().toISOString(), "first-key")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(uploads.length, 1)
  assert.equal(warnings.length, 1)
  assert.ok(!JSON.stringify(warnings).includes("first-key"))
})

test("saved keys cannot accidentally be reused as the upload token", async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error("must not send a saved SAIA key") }
  const reporter = accountReporter({ SAIA_AI_USAGE_URL: "https://usage.example", SAIA_AI_USAGE_UPLOAD_TOKEN: "saved-key" }, () => {})
  t.after(() => reporter.dispose())
  reporter.activate("saved-key")
  reporter.observe(new Headers({ "x-ratelimit-limit-hour": "400", "x-ratelimit-remaining-hour": "399" }), new Date().toISOString(), "saved-key")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 0)
})

test("whitespace cannot bypass the saved-key upload-token guard", async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error("must not send a padded SAIA key") }
  const reporter = accountReporter({ SAIA_AI_USAGE_URL: "https://usage.example", SAIA_AI_USAGE_UPLOAD_TOKEN: " saved-key " }, () => {})
  t.after(() => reporter.dispose())
  reporter.activate("saved-key")
  reporter.observe(new Headers({ "x-ratelimit-limit-hour": "400", "x-ratelimit-remaining-hour": "399" }), new Date().toISOString(), "saved-key")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 0)
})

test("a saved key cannot hide an environment SAIA key mistakenly used as upload token", async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error("must not send either SAIA key") }
  const reporter = accountReporter({ SAIA_API_KEY: "environment-key", SAIA_AI_USAGE_URL: "https://usage.example", SAIA_AI_USAGE_UPLOAD_TOKEN: "environment-key" }, () => {})
  t.after(() => reporter.dispose())
  reporter.activate("saved-key")
  reporter.observe(new Headers({ "x-ratelimit-limit-hour": "400", "x-ratelimit-remaining-hour": "399" }), new Date().toISOString(), "saved-key")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 0)
})
