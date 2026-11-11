import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../dist/index.js"

const endpoint = "https://chat-ai.academiccloud.de/v1"
const quotaHeaders = { "x-ratelimit-limit-requests-hour": "400", "x-ratelimit-remaining-requests-hour": "399" }
const inventory = { data: [{ id: "test-coder", name: "Test coder", status: "ready", input: ["text", "image"], output: ["text", "thought"] }] }
const envNames = ["SAIA_API_KEY", "SAIA_BASE_URL", "SAIA_AI_USAGE_URL", "SAIA_AI_USAGE_UPLOAD_TOKEN", "SAIA_AI_USAGE_PROXY_AUTHORIZATION", "OPENCODE_AUTH_CONTENT"]

function configure(t) {
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
  const originalFetch = globalThis.fetch
  for (const name of envNames) delete process.env[name]
  process.env.SAIA_API_KEY = "saia-test-secret"
  process.env.OPENCODE_AUTH_CONTENT = "{}"
  process.env.SAIA_AI_USAGE_URL = "https://usage.example/base"
  process.env.SAIA_AI_USAGE_UPLOAD_TOKEN = "upload-test-secret"
  t.after(() => {
    globalThis.fetch = originalFetch
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  })
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
async function until(predicate) { for (let i = 0; i < 50; i++) { if (predicate()) return; await tick() } assert.ok(predicate()) }
const request = (path = "chat/completions", key = "saia-test-secret") => new Request(`${endpoint}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: "private prompt" })

function mockV2(options = {}) {
  const state = { connection: process.env.SAIA_API_KEY ? { type: "env", name: "SAIA_API_KEY" } : undefined, key: process.env.SAIA_API_KEY, methods: [], integrations: {}, definition: undefined, hook: undefined, scope: undefined, reloads: 0 }
  let transform, wake
  const context = {
    options,
    integration: {
      transform: async (callback) => callback({ update: (id, update) => { const value = { id, name: id }; update(value); state.integrations[id] = value }, method: { update: (method) => state.methods.push(method) } }),
      connection: { active: async () => state.connection, resolve: async () => state.key ? { type: "key", key: state.key } : undefined },
    },
    provider: {
      transform: async (callback) => { transform = callback; callback({ add: (value) => { state.definition = value } }) },
      reload: async () => { state.reloads++; transform({ add: (value) => { state.definition = value } }) },
    },
    session: { hook: async (name, callback, scope) => { assert.equal(name, "http.response"); state.hook = callback; state.scope = scope } },
    event: { async *subscribe({ signal }) {
      while (!signal.aborted) {
        const event = await new Promise((resolve) => {
          wake = resolve
          signal.addEventListener("abort", () => resolve(undefined), { once: true })
        })
        if (!event) return
        yield event
      }
    } },
  }
  return { state, context, change(key, id = "credential-test") {
    state.key = key
    state.connection = key ? { type: "credential", id, label: id, method: "key" } : undefined
    wake?.({ type: "credential.switched", data: { integrationID: "saia", credentialID: key ? id : null } })
  } }
}

test("one default export exposes both documented loader entrypoints", () => {
  assert.equal(plugin.id, "saia")
  assert.equal(typeof plugin.server, "function")
  assert.equal(typeof plugin.setup, "function")
})

test("both versions register /connect before any API key exists", async (t) => {
  configure(t)
  delete process.env.SAIA_API_KEY
  globalThis.fetch = async () => { throw new Error("must not fetch before connecting") }
  const hooks = await plugin.server({}, {})
  t.after(() => hooks.dispose())
  assert.equal(hooks.auth.provider, "saia")
  assert.deepEqual(hooks.auth.methods, [{ type: "api", label: "SAIA API key" }])
  const config = {}
  await hooks.config(config)
  assert.equal(config.provider.saia.name, "SAIA")
  assert.deepEqual(config.provider.saia.models, {})
  const mock = mockV2()
  const cleanup = await plugin.setup(mock.context)
  t.after(cleanup)
  assert.equal(mock.state.integrations.saia.name, "SAIA")
  assert.ok(mock.state.methods.some((entry) => entry.method.type === "key"))
  assert.ok(mock.state.methods.some((entry) => entry.method.type === "env"))
  assert.equal(mock.state.definition.models.length, 0)
  assert.equal(mock.state.definition.info.settings.apiKey, undefined)
})

test("V1 uses saved keys before environment keys for discovery and header capture", async (t) => {
  configure(t)
  const uploads = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) { assert.equal(init.headers.Authorization, "Bearer saved-key"); return Response.json(inventory) }
    uploads.push({ url, init }); return Response.json({ accepted: true }, { status: 202 })
  }
  const hooks = await plugin.server({}, { models: { "test-coder": { tools: true } } })
  t.after(() => hooks.dispose())
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ saia: { type: "api", key: "saved-key" } })
  const unrelated = { name: "Keep me" }
  const config = { model: "other/model", provider: { other: unrelated, saia: { models: { manual: { name: "Manual" } } } } }
  await hooks.config(config)
  assert.equal(config.provider.other, unrelated)
  assert.equal(config.model, "other/model")
  assert.equal(config.provider.saia.models.manual.name, "Manual")
  assert.equal(config.provider.saia.models["test-coder"].tool_call, true)
  assert.equal(config.provider.saia.models["test-coder"].reasoning, true)
  assert.equal(config.provider.saia.options.apiKey, undefined)
  const response = new Response("private answer", { status: 429, headers: quotaHeaders })
  const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "saved-key" }), { options: { fetch: async () => response } })
  assert.equal(loaded.apiKey, "saved-key")
  assert.equal(await loaded.fetch(request("chat/completions", "saved-key")), response)
  await tick()
  assert.equal(response.bodyUsed, false)
  assert.equal(uploads.length, 1)
  await loaded.fetch(request("models", "saved-key"))
  await loaded.fetch(request("chat/completions", "other-account"))
  await tick()
  assert.equal(uploads.length, 1)
})

test("V1 does not reuse inventory from a previous saved key on discovery failure", async (t) => {
  configure(t)
  const originalWarn = console.warn
  console.warn = () => {}
  t.after(() => { console.warn = originalWarn })
  let fail = false
  globalThis.fetch = async () => { if (fail) throw new Error("secret failure"); return Response.json(inventory) }
  const hooks = await plugin.server({}, {})
  t.after(() => hooks.dispose())
  const config = {}
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ saia: { type: "api", key: "first" } })
  await hooks.config(config)
  assert.equal(Object.keys(config.provider.saia.models).length, 1)
  fail = true
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ saia: { type: "api", key: "second" } })
  await hooks.config(config)
  assert.deepEqual(config.provider.saia.models, {})
})

test("V1 discards a late inventory after a concurrent saved-account switch", async (t) => {
  configure(t)
  delete process.env.SAIA_AI_USAGE_URL
  delete process.env.SAIA_AI_USAGE_UPLOAD_TOKEN
  let release
  globalThis.fetch = async (url, init) => {
    if (init.headers.Authorization === "Bearer first") return new Promise((resolve) => { release = () => resolve(Response.json({ data: [{ ...inventory.data[0], id: "old-account" }] })) })
    return Response.json({ data: [{ ...inventory.data[0], id: "new-account" }] })
  }
  const hooks = await plugin.server({}, {})
  t.after(() => hooks.dispose())
  const config = {}
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ saia: { type: "api", key: "first" } })
  const first = hooks.config(config)
  await until(() => Boolean(release))
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ saia: { type: "api", key: "second" } })
  await hooks.config(config)
  release()
  await first
  assert.ok(config.provider.saia.models["new-account"])
  assert.equal(config.provider.saia.models["old-account"], undefined)
  await hooks.config(config)
  assert.ok(config.provider.saia.models["new-account"])
})

test("V1 removes generated models when the saved key changes while a refresh is in flight", async (t) => {
  configure(t)
  delete process.env.SAIA_AI_USAGE_URL
  delete process.env.SAIA_AI_USAGE_UPLOAD_TOKEN
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  t.after(() => { Date.now = originalNow })
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ saia: { type: "api", key: "first" } })
  globalThis.fetch = async () => Response.json(inventory)
  const hooks = await plugin.server({}, { refreshIntervalMs: 1000 })
  t.after(() => hooks.dispose())
  const config = { provider: { saia: { models: { manual: { name: "Keep" } } } } }
  await hooks.config(config)
  assert.ok(config.provider.saia.models["test-coder"])
  let release
  globalThis.fetch = async () => new Promise((resolve) => { release = () => resolve(Response.json(inventory)) })
  now += 1001
  const refresh = hooks.config(config)
  await until(() => Boolean(release))
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ saia: { type: "api", key: "second" } })
  release()
  await refresh
  assert.equal(config.provider.saia.models["test-coder"], undefined)
  assert.equal(config.provider.saia.models.manual.name, "Keep")
})

test("V1 refresh removes retired generated models but preserves explicit manual entries", async (t) => {
  configure(t)
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  t.after(() => { Date.now = originalNow })
  let result = inventory
  globalThis.fetch = async () => Response.json(result)
  const hooks = await plugin.server({}, { refreshIntervalMs: 1000 })
  t.after(() => hooks.dispose())
  const config = { provider: { saia: { models: { manual: { name: "Keep" } } } } }
  await hooks.config(config)
  result = { data: [{ ...inventory.data[0], id: "replacement" }] }
  now += 1001
  await hooks.config(config)
  assert.equal(config.provider.saia.models["test-coder"], undefined)
  assert.ok(config.provider.saia.models.replacement)
  assert.equal(config.provider.saia.models.manual.name, "Keep")
})

test("V2 resolves and binds saved credentials without putting secrets into provider metadata", async (t) => {
  configure(t)
  const uploads = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) { assert.equal(init.headers.Authorization, "Bearer saved-key"); return Response.json(inventory) }
    uploads.push({ url, init }); return Response.json({ accepted: false }, { status: 202 })
  }
  const mock = mockV2({ models: { "test-coder": { tools: true, context: 100000, output: 10000 } } })
  mock.state.connection = { type: "credential", id: "saved", label: "Saved", method: "key" }
  mock.state.key = "saved-key"
  t.after(await plugin.setup(mock.context))
  assert.deepEqual(mock.state.scope, { providerID: "saia" })
  const definition = mock.state.definition
  assert.equal(definition.info.integrationID, "saia")
  assert.equal(definition.info.package, "@opencode/ai/providers/openai-compatible")
  assert.equal(definition.info.settings.apiKey, undefined)
  assert.deepEqual(definition.sourceConnection, mock.state.connection)
  assert.equal(definition.models[0].capabilities.tools, true)
  assert.deepEqual(definition.models[0].limit, { context: 100000, output: 10000 })
  const response = new Response("private streamed answer", { headers: quotaHeaders })
  const event = { request: request("chat/completions", "saved-key"), response }
  assert.equal(mock.state.hook(event), undefined)
  assert.equal(event.response, response)
  assert.equal(response.bodyUsed, false)
  await tick()
  assert.equal(uploads.length, 1)
})

test("V2 connecting after startup discovers models, and disconnecting removes them", async (t) => {
  configure(t)
  delete process.env.SAIA_API_KEY
  globalThis.fetch = async () => Response.json(inventory)
  const mock = mockV2()
  t.after(await plugin.setup(mock.context))
  assert.equal(mock.state.definition.models.length, 0)
  mock.change("connected-key")
  await until(() => mock.state.definition.models.length === 1)
  assert.equal(mock.state.definition.sourceConnection.id, "credential-test")
  mock.change(undefined)
  await until(() => mock.state.definition.models.length === 0 && mock.state.definition.sourceConnection === undefined)
})

test("V2 discards a late response from an account switched during discovery", async (t) => {
  configure(t)
  delete process.env.SAIA_API_KEY
  let release
  globalThis.fetch = async (url, init) => {
    if (init.headers.Authorization === "Bearer first") return new Promise((resolve) => { release = () => resolve(Response.json({ data: [{ ...inventory.data[0], id: "old-account" }] })) })
    return Response.json({ data: [{ ...inventory.data[0], id: "new-account" }] })
  }
  const mock = mockV2()
  t.after(await plugin.setup(mock.context))
  mock.change("first", "first-id")
  await until(() => Boolean(release))
  mock.change("second", "second-id")
  release()
  await until(() => mock.state.definition.models[0]?.id === "new-account")
  assert.equal(mock.state.definition.sourceConnection.id, "second-id")
})
