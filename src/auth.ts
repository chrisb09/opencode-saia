import { createReporter } from "./reporting.js"

// OpenCode owns credential storage; only keep the currently resolved key in memory.
export function apiKeyFrom(credential: unknown): string | undefined {
  if (!credential || typeof credential !== "object") return
  const auth = credential as { type?: string; key?: unknown }
  if ((auth.type !== "api" && auth.type !== "key") || typeof auth.key !== "string" || !auth.key.trim()) return
  const key = auth.key.trim()
  try { new Headers({ Authorization: `Bearer ${key}` }) } catch { throw new Error("Invalid SAIA API key") }
  return key
}

export function accountReporter(env: NodeJS.ProcessEnv, warn: (message: string) => void) {
  let key: string | undefined
  let blocked = false
  let reporter: ReturnType<typeof createReporter> | undefined
  return {
    activate(next: string | undefined) {
      if (!next) { reporter?.dispose(); reporter = undefined; return }
      if (blocked) return
      if (env.SAIA_API_KEY && env.SAIA_AI_USAGE_UPLOAD_TOKEN === env.SAIA_API_KEY) {
        blocked = true
        reporter?.dispose()
        warn("SAIA API key must not be used as the ai_usage upload token; reporting disabled.")
        return
      }
      if (key && next !== key) {
        blocked = true
        reporter?.dispose()
        if (env.SAIA_AI_USAGE_URL || env.SAIA_AI_USAGE_UPLOAD_TOKEN) warn("SAIA credential changed; ai_usage reporting disabled until reload to avoid mixing quota scopes.")
      } else {
        key ??= next
        reporter ??= createReporter({ ...env, SAIA_API_KEY: next }, { warn })
      }
    },
    observe(headers: Headers, observedAt: string, requestKey: string) {
      if (!blocked && requestKey === key) reporter?.observe(headers, observedAt)
    },
    dispose() { reporter?.dispose() },
  }
}
