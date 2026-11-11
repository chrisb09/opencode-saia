import assert from "node:assert/strict"
import test from "node:test"
import { fetchModels, hasConfiguredCredential, isInferenceRequest, modelProperties, parseModels, settingsFrom } from "../dist/models.js"

const ready = (id, extra = {}) => ({ id, status: "ready", input: ["text"], output: ["text"], ...extra })
const settings = () => settingsFrom({}, { SAIA_API_KEY: "test-key" })

test("discovers new IDs and reported modalities/reasoning without a curated catalog", () => {
  const models = parseModels({ data: [
    ready("future-model", { name: "Future", input: ["text", "image", "image", "video"], output: ["text", "thought"] }),
    ready("embedding", { output: ["embeddings"] }),
    ready("starting", { status: "starting" }),
  ] })
  assert.deepEqual(models, [{ id: "future-model", name: "Future", input: ["text", "image", "video"], output: ["text", "thought"] }])
  assert.equal(modelProperties(models[0], settings()).tools, false)
})

test("rejects malformed inventories and duplicate IDs", () => {
  for (const body of [null, {}, { data: [ready("bad", { input: [5] })] }, { data: [ready("bad#variant")] }, { data: [ready("same"), ready("same")] }]) {
    assert.throws(() => parseModels(body))
  }
  assert.deepEqual(parseModels({ data: [] }), [])
})

test("validates settings and applies explicit tools, budgets, and reasoning-field overrides", () => {
  assert.equal(settingsFrom({}, {}).apiKey, "")
  const configured = settingsFrom({ models: { coder: { tools: true, context: 262144, output: 8192, reasoningField: "reasoning_content" } } }, { SAIA_API_KEY: "key" })
  assert.deepEqual(modelProperties(ready("coder"), configured), { tools: true, limit: { context: 262144, output: 8192 }, compatibility: { reasoningField: "reasoning_content" } })
  for (const options of [{ baseURL: "http://remote.example/v1" }, { baseURL: "https://user:secret@example.test/v1" }, { baseURL: "https://example.test/v1?q=secret" }, { refreshIntervalMs: 0 }, { models: { coder: { output: -1 } } }, { models: { coder: { tools: "yes" } } }, { models: { coder: { reasoningField: "content" } } }]) {
    assert.throws(() => settingsFrom(options, { SAIA_API_KEY: "key" }))
  }
  assert.equal(settingsFrom({ baseURL: "http://127.0.0.1:1234/v1/" }, { SAIA_API_KEY: "key" }).baseURL, "http://127.0.0.1:1234/v1")
})

test("uses model-specific budgets, explicit overrides, and unknown-model fallback", () => {
  const budgets = {
    "deepseek-v4-flash-0731": [1000000,32768], "deepseek-v4.1-flash-1017": [1000000,32768],
    "eurollm-22b-instruct-2512": [32768,4096], "gemma-4-31b-it": [256000,16384],
    "glm-5.3": [1000000,32768], "glm-5.3-flash": [1000000,32768],
    "meta-llama-3.1-8b-instruct": [128000,8192], "mistral-large-4-1t-a52b": [1000000,32768],
    "qwen3-30b-a3b-instruct-2507": [256000,16384], "qwen3-coder-next": [256000,16384],
    "qwen3-omni-30b-a3b-instruct": [256000,16384], "qwen3.5-397b-a17b": [256000,32768],
    "qwen3.6-35b-a3b": [262000,16384], "qwen3.8-27b": [262000,32768],
  }
  for (const [id, [context, output]] of Object.entries(budgets)) {
    assert.deepEqual(modelProperties(ready(id), settings()).limit, { context, output }, id)
  }
  assert.deepEqual(modelProperties(ready("unknown"), settings()).limit, { context: 32768, output: 4096 })
  const configured = settingsFrom({ models: { "qwen3-coder-next": { context: 123456 } } }, {})
  assert.deepEqual(modelProperties(ready("qwen3-coder-next"), configured).limit, { context: 123456, output: 16384 })
})

test("enables only verified tools on the default endpoint, respecting explicit overrides", () => {
  const passed = ["deepseek-v4-flash-0731", "deepseek-v4.1-flash-1017", "gemma-4-31b-it", "glm-5.3", "glm-5.3-flash", "meta-llama-3.1-8b-instruct", "qwen3-30b-a3b-instruct-2507", "qwen3-coder-next", "qwen3.5-397b-a17b", "qwen3.6-35b-a3b", "qwen3.8-27b"]
  const unverified = ["eurollm-22b-instruct-2512", "mistral-large-4-1t-a52b", "qwen3-omni-30b-a3b-instruct", "unknown"]
  for (const id of passed) assert.equal(modelProperties(ready(id), settings()).tools, true, id)
  for (const id of unverified) assert.equal(modelProperties(ready(id), settings()).tools, false, id)
  const custom = settingsFrom({ baseURL: "https://other.example/v1", models: { "glm-5.3": { tools: true } } }, {})
  assert.equal(modelProperties(ready("qwen3-coder-next"), custom).tools, false)
  assert.equal(modelProperties(ready("glm-5.3"), custom).tools, true)
  const disabled = settingsFrom({ models: { "glm-5.3": { tools: false } } }, {})
  assert.equal(modelProperties(ready("glm-5.3"), disabled).tools, false)
})

test("discovery uses the documented authenticated POST and rejects redirects", async () => {
  let call
  const models = await fetchModels(settings(), async (url, init) => {
    call = { url, init }
    return Response.json({ data: [ready("new-coder")] })
  })
  assert.equal(models[0].id, "new-coder")
  assert.equal(call.url, "https://chat-ai.academiccloud.de/v1/models")
  assert.equal(call.init.method, "POST")
  assert.equal(call.init.redirect, "error")
  assert.equal(call.init.headers.Authorization, "Bearer test-key")
  await assert.rejects(fetchModels(settings(), async () => new Response("secret error", { status: 401 })), /HTTP 401/)
})

test("inference matching excludes discovery, unrelated paths and different origins", () => {
  const base = settings().baseURL
  assert.equal(isInferenceRequest(new Request(`${base}/chat/completions`, { method: "POST" }), base), true)
  for (const path of ["models", "images/generations", "api/saia/observations", "chat/completions/other"]) assert.equal(isInferenceRequest(`${base}/${path}`, base, "POST"), false)
  assert.equal(isInferenceRequest(`${base}/chat/completions`, base, "GET"), false)
  assert.equal(isInferenceRequest("https://other.example/v1/chat/completions", base, "POST"), false)
  assert.equal(isInferenceRequest("https://example.test/proxy/v1/chat/completions", "https://example.test/proxy/v1", "POST"), true)
})

test("quota scope is bound to the configured credential, including Request header override semantics", () => {
  const request = new Request("https://example.test", { headers: { Authorization: "Bearer key" } })
  assert.equal(hasConfiguredCredential(request, undefined, "key"), true)
  assert.equal(hasConfiguredCredential(request, { headers: { Authorization: "Bearer other-account" } }, "key"), false)
  assert.equal(hasConfiguredCredential(request, { headers: {} }, "key"), false)
})
