export const DEFAULT_BASE_URL = "https://chat-ai.academiccloud.de/v1"
export const DEFAULT_REFRESH_MS = 15 * 60_000
// Operating budgets, not verified deployment limits. See README for provenance.
const MODEL_LIMITS = new Map<string, { context: number; output: number }>([
  ["deepseek-v4-flash-0731", { context: 1_000_000, output: 32_768 }],
  ["deepseek-v4.1-flash-1017", { context: 1_000_000, output: 32_768 }],
  ["eurollm-22b-instruct-2512", { context: 32_768, output: 4_096 }],
  ["gemma-4-31b-it", { context: 256_000, output: 16_384 }],
  ["glm-5.3", { context: 1_000_000, output: 32_768 }],
  ["glm-5.3-flash", { context: 1_000_000, output: 32_768 }],
  ["meta-llama-3.1-8b-instruct", { context: 128_000, output: 8_192 }],
  ["mistral-large-4-1t-a52b", { context: 1_000_000, output: 32_768 }],
  ["qwen3-30b-a3b-instruct-2507", { context: 256_000, output: 16_384 }],
  ["qwen3-coder-next", { context: 256_000, output: 16_384 }],
  ["qwen3-omni-30b-a3b-instruct", { context: 256_000, output: 16_384 }],
  ["qwen3.5-397b-a17b", { context: 256_000, output: 32_768 }],
  ["qwen3.6-35b-a3b", { context: 262_000, output: 16_384 }],
  ["qwen3.8-27b", { context: 262_000, output: 32_768 }],
])
// Successful streamed tool-call/result/continuation on the default SAIA endpoint, 2026-11-11.
const VERIFIED_TOOLS = new Set([
  "deepseek-v4-flash-0731", "deepseek-v4.1-flash-1017", "gemma-4-31b-it",
  "glm-5.3", "glm-5.3-flash", "meta-llama-3.1-8b-instruct",
  "qwen3-30b-a3b-instruct-2507", "qwen3-coder-next", "qwen3.5-397b-a17b",
  "qwen3.6-35b-a3b", "qwen3.8-27b",
])
const MEDIA = ["text", "image", "audio", "video", "pdf"] as const
export type Media = typeof MEDIA[number]
export function isMedia(value: string): value is Media { return (MEDIA as readonly string[]).includes(value) }

export interface SaiaModel {
  id: string
  name: string
  input: Media[]
  output: string[]
}

export interface ModelOverride {
  tools?: boolean
  context?: number
  output?: number
  reasoningField?: string
}

export interface Settings {
  apiKey: string
  baseURL: string
  refreshIntervalMs: number
  models: Record<string, ModelOverride>
}

export function settingsFrom(options: Record<string, unknown>, env: NodeJS.ProcessEnv): Settings {
  const apiKey = env.SAIA_API_KEY?.trim() ?? ""
  if (apiKey) new Headers({ Authorization: `Bearer ${apiKey}` })
  const url = new URL(String(options.baseURL ?? env.SAIA_BASE_URL ?? DEFAULT_BASE_URL))
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("SAIA endpoint must use HTTPS (HTTP is allowed only on literal loopback)")
  }
  const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS
  if (!Number.isSafeInteger(refreshIntervalMs) || Number(refreshIntervalMs) < 1_000 || Number(refreshIntervalMs) > 2_147_483_647) {
    throw new Error("Invalid SAIA refresh interval")
  }
  const models: Record<string, ModelOverride> = Object.create(null)
  if (options.models !== undefined) {
    if (!options.models || typeof options.models !== "object" || Array.isArray(options.models)) throw new Error("Invalid model overrides")
    for (const [id, value] of Object.entries(options.models)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model override")
      const override = value as ModelOverride
      if (override.tools !== undefined && typeof override.tools !== "boolean") throw new Error("Invalid tool override")
      for (const limit of [override.context, override.output]) {
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error("Invalid model limit")
      }
      if (override.reasoningField !== undefined &&
          (typeof override.reasoningField !== "string" || !override.reasoningField ||
           ["role", "content", "refusal", "tool_calls"].includes(override.reasoningField))) throw new Error("Invalid reasoning field")
      models[id] = { ...override }
    }
  }
  return { apiKey, baseURL: url.href.replace(/\/$/, ""), refreshIntervalMs: Number(refreshIntervalMs), models }
}

export function parseModels(body: unknown): SaiaModel[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
    throw new Error("Invalid SAIA model inventory")
  }
  const result = new Map<string, SaiaModel>()
  for (const item of (body as { data: unknown[] }).data) {
    if (!item || typeof item !== "object") throw new Error("Invalid SAIA model entry")
    const model = item as Record<string, unknown>
    if (model.status !== "ready") continue
    if (typeof model.id !== "string" || !model.id || model.id.includes("#") ||
        !Array.isArray(model.input) || !Array.isArray(model.output) ||
        !model.input.every((value) => typeof value === "string") ||
        !model.output.every((value) => typeof value === "string")) throw new Error("Invalid SAIA model entry")
    if (!model.input.includes("text") || !model.output.includes("text")) continue
    if (result.has(model.id)) throw new Error("Duplicate SAIA model ID")
    result.set(model.id, {
      id: model.id,
      name: typeof model.name === "string" && model.name ? model.name : model.id,
      input: [...new Set(model.input.filter(isMedia))],
      output: [...new Set(model.output)],
    })
  }
  return [...result.values()]
}

export async function fetchModels(settings: Settings, fetchImpl = globalThis.fetch, signal?: AbortSignal): Promise<SaiaModel[]> {
  if (!settings.apiKey) throw new Error("Connect a SAIA API key first")
  const response = await fetchImpl(`${settings.baseURL}/models`, {
    method: "POST",
    headers: { Accept: "application/json", Authorization: `Bearer ${settings.apiKey}` },
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
  })
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new Error(`SAIA model discovery returned HTTP ${response.status}`)
  }
  return parseModels(await response.json())
}

export function isInferenceRequest(input: RequestInfo | URL, baseURL: string, method?: string): boolean {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const base = new URL(`${baseURL}/`)
    const verb = method ?? (input instanceof Request ? input.method : "GET")
    return verb.toUpperCase() === "POST" && url.origin === base.origin &&
      ["chat/completions", "completions", "responses", "messages"].some((path) => url.pathname === `${base.pathname}${path}`)
  } catch {
    return false
  }
}

export function hasConfiguredCredential(input: RequestInfo | URL, init: RequestInit | undefined, apiKey: string): boolean {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  return headers.get("authorization") === `Bearer ${apiKey}`
}

export function modelProperties(model: SaiaModel, settings: Settings) {
  const override = settings.models[model.id] ?? {}
  const defaults = MODEL_LIMITS.get(model.id)
  return {
    tools: override.tools ?? (settings.baseURL === DEFAULT_BASE_URL && VERIFIED_TOOLS.has(model.id)),
    limit: { context: override.context ?? defaults?.context ?? 32_768, output: override.output ?? defaults?.output ?? 4_096 },
    compatibility: override.reasoningField ? { reasoningField: override.reasoningField } : undefined,
  }
}
