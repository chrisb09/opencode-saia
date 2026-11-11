import type { Plugin } from "@opencode/plugin"
import { server } from "./v1.js"
import { setup } from "./v2.js"

// Plugin.define is an identity helper; type-only SDK imports keep both hosts dependency-free.
export default { id: "saia", setup, server } satisfies Plugin.Plugin & { server: typeof server }
