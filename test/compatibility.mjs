// Real CLI loaders, a packed installation, and local mock endpoints only.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const temp = await mkdtemp(path.join(process.env.OPENCODE_TEST_TMP ?? "/tmp/opencode", "saia-compat-"))
console.log(`Isolated fixtures: ${temp}`)
const uploads = []
const calls = []
let malformedRequest
const server = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const chunk of request) raw += chunk
    if (request.url === "/v1/models") {
      assert.equal(request.method, "POST")
      assert.equal(request.headers.authorization, "Bearer mock-saia-key")
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ data: [{ id: "smoke-coder", name: "Smoke coder", status: "ready", input: ["text"], output: ["text", "thought"] }] }))
      return
    }
    if (request.url === "/api/saia/observations") {
      assert.equal(request.headers["x-ai-usage-token"], "mock-upload-token")
      assert.equal(request.headers.authorization, "Basic bW9jazpwcm94eQ==")
      const payload = JSON.parse(raw)
      assert.deepEqual(Object.keys(payload).sort(), ["observedAt", "windows"])
      assert.ok(!raw.includes("mock-saia-key"))
      assert.deepEqual(payload.windows, [{ window: "hour", limit: 400, remaining: 399 }])
      uploads.push(payload)
      response.writeHead(202, { "Content-Type": "application/json" })
      response.end('{"accepted":true}')
      return
    }
    assert.equal(request.url, "/v1/chat/completions")
    assert.equal(request.headers.authorization, "Bearer mock-saia-key")
    const body = JSON.parse(raw)
    calls.push(body)
    const hasToolResult = body.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("SAIA_SMOKE_TOOL_RESULT"))
    const tool = body.tools?.find((entry) => entry.function?.name === "saia_smoke_echo")
    const toolCall = tool && !hasToolResult
    const content = tool ? "SAIA_SMOKE_OK" : "Smoke title"
    response.writeHead(200, {
      "Content-Type": body.stream ? "text/event-stream" : "application/json",
      "x-ratelimit-limit-requests-hour": "400",
      "x-ratelimit-remaining-requests-hour": "399",
    })
    if (!body.stream) {
      response.end(JSON.stringify({ id: "smoke", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }))
      return
    }
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    chunk({ role: "assistant" })
    if (toolCall) {
      chunk({ tool_calls: [{ index: 0, id: "call_smoke", type: "function", function: { name: "saia_smoke_echo", arguments: "{}" } }] })
      chunk({}, "tool_calls")
    } else {
      chunk({ reasoning_content: "Mock reasoning." })
      chunk({ content })
      chunk({}, "stop")
    }
    response.end("data: [DONE]\n\n")
  } catch (error) {
    malformedRequest = error
    response.writeHead(500)
    response.end("Invalid mock request")
  }
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${server.address().port}`

function run(command, args, cwd, env, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    const collect = (chunk) => { output = (output + chunk).slice(-30_000) }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Timed out: ${command}\n${output}`)) }, timeout)
    child.on("error", (error) => { clearTimeout(timer); reject(error) })
    child.on("exit", (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`${command} exited ${code}\n${output}`))
      else resolve(output)
    })
  })
}

try {
  const pack = JSON.parse(await run("npm", ["pack", "--json", "--pack-destination", temp, "--ignore-scripts"], root, process.env))
  const install = path.join(temp, "installed")
  await mkdir(install)
  await writeFile(path.join(install, "package.json"), '{"private":true}')
  await run("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", path.join(temp, pack[0].filename)], install, process.env)
  const packagePath = path.join(install, "node_modules", "opencode-saia")
  const shipped = JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8"))
  assert.equal(shipped.dependencies, undefined)
  const toolPath = path.join(temp, "smoke-tools")
  await mkdir(toolPath)
  await writeFile(path.join(toolPath, "package.json"), '{"type":"module"}')
  await writeFile(path.join(toolPath, "index.js"), `export default {
    id: "saia-smoke-tools",
    server: async () => ({ tool: { saia_smoke_echo: { description: "Harmless compatibility test", args: {}, execute: async () => "SAIA_SMOKE_TOOL_RESULT" } } }),
    setup: async (ctx) => {
      await ctx.tool.transform(editor => editor.add({ name: "saia_smoke_echo", description: "Harmless compatibility test", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false }, execute: async () => ({ content: "SAIA_SMOKE_TOOL_RESULT" }) }))
      if (process.env.SAIA_TEST_SAVED_KEY) {
        const integrations = await ctx.integration.list()
        if (!integrations.data.some(i => i.id === "saia")) throw new Error("SAIA is missing from /connect")
        await ctx.integration.connect.key({ integrationID: "saia", key: process.env.SAIA_TEST_SAVED_KEY })
        let ready = false
        for (let i = 0; i < 100; i++) {
          const models = await ctx.model.list()
          if (models.data.some(m => m.providerID === "saia" && m.id === "smoke-coder")) { ready = true; break }
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        if (!ready) throw new Error("SAIA did not discover models after connecting")
      }
    }
  }`)
  const options = { baseURL: `${base}/v1`, models: { "smoke-coder": { tools: true, reasoningField: "reasoning_content" } } }
  const versions = process.argv.includes("--v2-only") ? ["v2"] : ["v1", "v2"]
  for (const { version, mode } of versions.flatMap(version => ["environment", "saved-key"].map(mode => ({ version, mode })))) {
    const directory = path.join(temp, `${version}-${mode}`)
    await mkdir(directory)
    const config = version === "v1" ? {
      plugin: [[path.join(packagePath, "dist", "index.js"), options], path.join(toolPath, "index.js")],
      enabled_providers: ["saia"],
    } : {
      plugins: [{ package: packagePath, options }, toolPath],
      policies: [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "saia", effect: "allow" }],
    }
    await writeFile(path.join(directory, "opencode.json"), JSON.stringify(config))
    const env = {
      PATH: process.env.PATH,
      HOME: directory,
      XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_CACHE_HOME: path.join(directory, "cache"),
      XDG_STATE_HOME: path.join(directory, "state"),
      TMPDIR: temp,
      npm_config_cache: path.join(temp, "npm-cache"),
      OPENCODE_DISABLE_FREE_MODELS: "1",
      SAIA_AI_USAGE_URL: base,
      SAIA_AI_USAGE_UPLOAD_TOKEN: "mock-upload-token",
      SAIA_AI_USAGE_PROXY_AUTHORIZATION: "Basic bW9jazpwcm94eQ==",
    }
    if (mode === "environment") env.SAIA_API_KEY = "mock-saia-key"
    else if (version === "v1") {
      const storage = path.join(env.XDG_DATA_HOME, "opencode")
      await mkdir(storage, { recursive: true })
      await writeFile(path.join(storage, "auth.json"), JSON.stringify({ saia: { type: "api", key: "mock-saia-key" } }), { mode: 0o600 })
    } else env.SAIA_TEST_SAVED_KEY = "mock-saia-key"
    const beforeCalls = calls.length
    const beforeUploads = uploads.length
    const command = version === "v1" ? "npm" : (process.env.OPENCODE_V2_BIN ?? "opencode")
    const prefix = version === "v1" ? ["exec", "--yes", "--package=opencode-ai@1.18.29", "--", "opencode"] : ["--standalone"]
    const output = await run(command, [...prefix, ...(version === "v1" ? ["--print-logs", "--log-level", "DEBUG"] : []), "run", "--thinking", "--format", "json", "--model", "saia/smoke-coder", "Call saia_smoke_echo once, then reply SAIA_SMOKE_OK."], directory, env)
    assert.ok(output.includes("SAIA_SMOKE_OK"), `${version}: completion missing\n${output}`)
    assert.ok(output.includes("Mock reasoning."), `${version}: streamed reasoning missing\n${output}`)
    assert.ok(calls.slice(beforeCalls).some((body) => body.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("SAIA_SMOKE_TOOL_RESULT"))), `${version}: complete tool cycle missing\n${output}`)
    assert.ok(uploads.length > beforeUploads, `${version}: response headers were not reported\n${output}`)
    if (malformedRequest) throw malformedRequest
    console.log(`${version} (${mode}): packed plugin loaded; streaming, reasoning, tool round-trip, and passive quota upload passed (${uploads.length - beforeUploads} observations)`)
  }
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
