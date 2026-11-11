import type { Plugin, Model, Provider, Integration } from "@opencode/plugin"
import { apiKeyFrom, accountReporter } from "./auth.js"
import { fetchModels, hasConfiguredCredential, isInferenceRequest, modelProperties, settingsFrom, type SaiaModel } from "./models.js"

const providerID = "saia" as Provider.ID
const integrationID = "saia" as Integration.ID
type ConnectionInfo = NonNullable<Awaited<ReturnType<Plugin.Context["integration"]["connection"]["active"]>>>

export async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup | void> {
  const warn = (message: string) => console.warn(`[saia] ${message}`)
  let configured
  try { configured = settingsFrom(ctx.options, process.env) } catch {
    warn("Invalid SAIA configuration; provider disabled.")
    return
  }
  const settings = configured
  const reporter = accountReporter(process.env, warn)
  const controller = new AbortController()
  let inventory: SaiaModel[] = []
  let connection: ConnectionInfo | undefined
  let currentKey: string | undefined
  let loadedAt = 0
  let stopped = false
  let revision = 0
  let pending = false
  let refreshing: Promise<void> | undefined

  await ctx.integration.transform((editor) => {
    editor.update("saia", (integration) => { integration.name = "SAIA" })
    editor.method.update({ integrationID: "saia", method: { type: "key", label: "SAIA API key" } })
    editor.method.update({ integrationID: "saia", method: { type: "env", names: ["SAIA_API_KEY"] } })
  })

  await ctx.provider.transform((editor) => {
    const models: Model.Info[] = inventory.map((model) => {
      const properties = modelProperties(model, settings)
      return {
        id: model.id as Model.ID, modelID: model.id as Model.ID, providerID, name: model.name,
        capabilities: { tools: properties.tools, input: model.input, output: model.output },
        compatibility: properties.compatibility, limit: properties.limit,
        variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true,
      }
    })
    editor.add({
      info: {
        id: providerID, name: "SAIA", integrationID, activation: "auto",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: settings.baseURL, transport: "http" },
      },
      models,
      sourceConnection: connection,
    })
  })

  const resolve = async () => {
    const active = await ctx.integration.connection.active("saia")
    const credential = active ? await ctx.integration.connection.resolve(active) : undefined
    return { connection: active, key: apiKeyFrom(credential) ?? (!active ? settings.apiKey || undefined : undefined) }
  }
  const sameConnection = (left: ConnectionInfo | undefined, right: ConnectionInfo | undefined) => JSON.stringify(left) === JSON.stringify(right)

  const refresh = (): Promise<void> => {
    revision++
    pending = true
    refreshing ??= (async () => {
      while (pending && !stopped) {
        pending = false
        const generation = revision
        try {
          const selected = await resolve()
          if (stopped || generation !== revision) continue
          const changed = selected.key !== currentKey || !sameConnection(selected.connection, connection)
          if (changed) {
            inventory = []
            loadedAt = 0
            currentKey = selected.key
            connection = selected.connection
            reporter.activate(currentKey)
            await ctx.provider.reload()
          }
          if (!currentKey || (loadedAt && Date.now() - loadedAt < settings.refreshIntervalMs)) continue
          const key = currentKey
          const models = await fetchModels({ ...settings, apiKey: key }, globalThis.fetch, controller.signal)
          const latest = await resolve()
          if (stopped || generation !== revision) continue
          if (latest.key !== key || !sameConnection(latest.connection, selected.connection)) { pending = true; continue }
          inventory = models
          loadedAt = Date.now()
          await ctx.provider.reload()
        } catch {
          if (!stopped) warn("SAIA connection/model discovery failed; keeping only this account's last successful inventory.")
        }
      }
    })().finally(() => { refreshing = undefined })
    return refreshing
  }

  await ctx.session.hook("http.response", (event) => {
    const observedAt = new Date().toISOString()
    if (currentKey && isInferenceRequest(event.request, settings.baseURL) && hasConfiguredCredential(event.request, undefined, currentKey)) {
      reporter.observe(event.response.headers, observedAt, currentKey)
    }
  }, { providerID })
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ types: ["credential.switched", "credential.updated"], signal: controller.signal })) {
        if (event.type === "credential.switched" && event.data.integrationID !== integrationID) continue
        await refresh()
      }
    } catch {
      if (!stopped) warn("SAIA credential notifications unavailable; reload after changing accounts.")
    }
  })()
  await refresh()
  const timer = setInterval(() => { void refresh() }, settings.refreshIntervalMs)
  timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
    controller.abort()
    reporter.dispose()
  }
}
