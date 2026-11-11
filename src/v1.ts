import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { Config, Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { apiKeyFrom, accountReporter } from "./auth.js"
import { fetchModels, hasConfiguredCredential, isInferenceRequest, isMedia, modelProperties, settingsFrom, type SaiaModel } from "./models.js"

// V1's provider.models hook skips new custom providers. Read only its native SAIA
// credential for config-time discovery; OpenCode still owns login and all writes.
export async function readV1ApiKey(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  let auth: unknown
  if (env.OPENCODE_AUTH_CONTENT) {
    try { auth = JSON.parse(env.OPENCODE_AUTH_CONTENT) } catch { /* Match V1's file fallback for invalid inline JSON. */ }
  }
  if (auth === undefined) {
    const dataHome = env.XDG_DATA_HOME || path.join(env.HOME || homedir(), ".local", "share")
    try { auth = JSON.parse(await readFile(path.join(dataHome, "opencode", "auth.json"), "utf8")) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw new Error("Unable to read the saved SAIA credential")
    }
  }
  return apiKeyFrom(auth && typeof auth === "object" ? (auth as Record<string, unknown>).saia : undefined)
}

export async function server(_input: PluginInput, options: PluginOptions = {}): Promise<Hooks> {
  const warn = (message: string) => console.warn(`[saia] ${message}`)
  let configured
  try { configured = settingsFrom(options, process.env) } catch {
    warn("Invalid SAIA configuration; provider disabled.")
    return {}
  }
  const settings = configured
  const reporter = accountReporter(process.env, warn)
  let currentKey: string | undefined
  let inventory: SaiaModel[] = []
  let loadedAt = 0
  let generation = 0
  let managedModels: Record<string, unknown> = {}
  const wrappers = new WeakSet<typeof globalThis.fetch>()
  const credential = async () => ((await readV1ApiKey(process.env)) ?? settings.apiKey) || undefined
  const manualModels = (models: NonNullable<NonNullable<Config["provider"]>[string]["models"]>) =>
    Object.fromEntries(Object.entries(models).filter(([id, model]) =>
      !Object.hasOwn(managedModels, id) || JSON.stringify(model) !== JSON.stringify(managedModels[id])))

  function wrap(original: typeof globalThis.fetch): typeof globalThis.fetch {
    if (wrappers.has(original)) return original
    const wrapped: typeof globalThis.fetch = async (input, init) => {
      const response = await original(input, init)
      const observedAt = new Date().toISOString()
      if (currentKey && isInferenceRequest(input, settings.baseURL, init?.method) && hasConfiguredCredential(input, init, currentKey)) {
        reporter.observe(response.headers, observedAt, currentKey)
      }
      return response
    }
    wrappers.add(wrapped)
    return wrapped
  }

  return {
    auth: {
      provider: "saia",
      methods: [{ type: "api", label: "SAIA API key" }],
      async loader(getAuth, provider) {
        const apiKey = apiKeyFrom(await getAuth()) ?? settings.apiKey
        reporter.activate(apiKey || undefined)
        return apiKey ? { apiKey, baseURL: settings.baseURL, fetch: wrap((provider.options?.fetch as typeof globalThis.fetch | undefined) ?? globalThis.fetch) } : {}
      },
    },
    async config(config: Config) {
      let apiKey: string | undefined
      try { apiKey = await credential() } catch { warn("Unable to resolve the saved SAIA credential.") }
      if (apiKey !== currentKey) { generation++; currentKey = apiKey; inventory = []; loadedAt = 0 }
      reporter.activate(apiKey)
      const selectedGeneration = generation
      if (apiKey && (!loadedAt || Date.now() - loadedAt >= settings.refreshIntervalMs)) {
        try {
          const models = await fetchModels({ ...settings, apiKey })
          if (generation !== selectedGeneration) return
          if (await credential() !== apiKey) {
            generation++
            currentKey = undefined
            inventory = []
            loadedAt = 0
            reporter.activate(undefined)
            if (config.provider?.saia) config.provider.saia.models = manualModels(config.provider.saia.models ?? {})
            return
          }
          inventory = models
          loadedAt = Date.now()
        } catch {
          if (generation === selectedGeneration) warn("Model discovery failed; keeping only this account's last successful inventory.")
        }
      }
      if (generation !== selectedGeneration) return
      const models = Object.fromEntries(inventory.map((model) => {
        const properties = modelProperties(model, settings)
        return [model.id, {
          name: model.name, tool_call: properties.tools, reasoning: model.output.includes("thought"),
          attachment: model.input.some((media) => media !== "text"),
          modalities: { input: model.input, output: model.output.filter(isMedia) },
          interleaved: properties.compatibility ? { field: properties.compatibility.reasoningField } : undefined,
          limit: properties.limit,
        }]
      }))
      config.provider ??= {}
      const existing = config.provider.saia
      const retained = manualModels(existing?.models ?? {})
      managedModels = structuredClone(models)
      const { apiKey: _oldKey, ...existingOptions } = existing?.options ?? {}
      config.provider.saia = {
        ...existing, name: "SAIA", npm: "@ai-sdk/openai-compatible", env: ["SAIA_API_KEY"],
        options: {
          ...existingOptions, baseURL: settings.baseURL,
          ...(apiKey ? { fetch: wrap((existingOptions.fetch as typeof globalThis.fetch | undefined) ?? globalThis.fetch) } : {}),
        },
        models: { ...models, ...retained },
      }
    },
    async dispose() { reporter.dispose() },
  }
}
