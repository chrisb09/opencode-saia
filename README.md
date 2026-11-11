# opencode-saia

Live [GWDG SAIA](https://docs.hpc.gwdg.de/services/ai-services/saia/index.html) models
for OpenCode **V1 1.18.29+** and **V2**, with optional passive request-quota
reporting to an ai_usage server.

One package, two small adapters, no runtime dependencies. No installer scripts,
global fetch patching, config-file rewriting, telemetry by default, or hardcoded
model catalog. This package is local source, **not published to npm**.

## Build

Use a current Node 22 LTS (22.22.2+ recommended for SDK development dependencies)
and npm:

```sh
npm ci --ignore-scripts
npm run build
npm test
```

Development SDK dependencies have upstream npm audit advisories; they are not
imported by the compiled plugin or installed as production dependencies.
`npm audit --omit=dev` checks the shipped dependency surface.

## Configure

Obtain a SAIA key from <https://saia.gwdg.de/keys>, load the plugin using the
appropriate configuration below, then run:

```text
/connect
# Choose SAIA, then SAIA API key, and enter your key in OpenCode's secret prompt.
/models
```

On V2, SAIA appears in `/connect` before any key is configured. Newer V1
releases can omit providers that currently expose no models, so `/connect` may
not list SAIA until a key has been saved. For a first V1 connection, either use
the CLI, which recognises SAIA without a model catalog:

```sh
opencode providers login -p saia
```

or add a temporary placeholder model to `provider.saia.models` (see
[First V1 connection](#first-v1-connection)). Once a key is saved, discovery
populates the catalog and SAIA appears in `/connect` and `/models`.

OpenCode stores the key in its own credential store; the plugin never writes it
to project/plugin configuration. Saved API keys take precedence over the `SAIA_API_KEY`
environment fallback. Never paste your key into an assistant conversation.
V2 resolves credentials through OpenCode's connection API. V1 reads the SAIA
entry from its native `auth.json` (or `OPENCODE_AUTH_CONTENT`) for config-time
discovery, because its provider-discovery hook skips new custom providers.
The V1 plugin never writes or modifies that credential file.

Alternatively, make `SAIA_API_KEY` available to the process running OpenCode.
For V2's shared background service, exporting a variable in a client terminal
alone may not supply it to the service. A saved account still wins over that
environment connection. Use OpenCode's account picker to switch or disconnect.

### OpenCode V2

Add to your existing `opencode.json(c)`, preserving unrelated settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/opencode-saia",
      "options": {
        "models": {
          // Example: disable tools even for a model that passed the live test.
          "qwen3-coder-next": { "tools": false }
        }
      }
    }
  ]
}
```

V2 reloads configuration automatically; `/reload` forces a reload. The plugin
uses the native OpenAI-compatible HTTP runtime so response hooks see inference
traffic, including titles, compaction, and tool-driven continuations.

### OpenCode V1 (1.18.29 or newer)

Build the package first (see [Build](#build)), then use the compiled entrypoint
with the V1 configuration shape:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///absolute/path/opencode-saia/dist/index.js",
      { "models": { "qwen3-coder-next": { "tools": true } } }
    ]
  ]
}
```

`file://` must point at the absolute path to `dist/index.js`. Older V1 releases
are not supported. Do not load this and another SAIA provider plugin together.
This plugin owns the `saia` provider; use its options for the endpoint,
credentials, and shared model settings.

#### First V1 connection

Some V1 releases omit providers that expose no models from the provider list,
so `/connect` can be empty on the very first run. Connect once with the CLI:

```sh
opencode providers login -p saia
```

Alternatively, add a temporary model so the provider survives the filter:

```jsonc
{
  "provider": {
    "saia": {
      "models": {
        "connect": { "name": "SAIA (connect to load models)" }
      }
    }
  }
}
```

After a key is saved (via `/connect`, the CLI, or `SAIA_API_KEY`), restart
OpenCode so discovery runs at config load and adds the live catalog. The
placeholder then remains as a manual model; remove it and restart OpenCode once
real models appear.

Select a discovered model using `/models`, for example
`saia/qwen3-coder-next`. Your configured default model is not changed.

## Discovery and model settings

Discovery uses authenticated `POST /v1/models` and includes ready chat models
with text input/output. Names and supported media come from the API; `thought`
output identifies reasoning models. No reasoning-effort levels or control
parameters are invented. V1 maps reasoning to its legacy model fields; V2
preserves the reported output capabilities. Unsupported input media are omitted.

V2 refreshes every 15 minutes and reacts to saved-account changes. V1 discovers
models during configuration loading, at most once per 15 minutes per account and
plugin instance; it does not restart OpenCode to force a catalog refresh.
Both retain only the current account's in-memory last successful inventory on
failure. Switching credentials discards the previous inventory immediately;
V2 also binds discovered models to their source connection and rejects stale
in-flight discovery results. There is no disk cache; an initial failure leaves
no discovered models until a later successful refresh/reload. Discovery has a
five-second timeout.

The API does **not** report tool support or token limits:

- Tools default on only for the eleven models that passed a streamed tool-call,
  result, and continuation test on the default SAIA endpoint on 2026-11-11:
  both DeepSeek models, Gemma 4, both GLM models, Llama 3.1 8B, Qwen3 30B,
  Qwen3 Coder Next, Qwen3.5 397B, Qwen3.6 35B, and Qwen3.8 27B. One simple
  test does not guarantee reliability in other tasks. EuroLLM 22B and Qwen3
  Omni rejected automatic tool choice; Mistral Large 4 called the tool but its
  continuation failed. Those, unknown models, and custom endpoints default off.
  Explicit per-model options can override either setting.
- Known models use the operating budgets below; unknown models fall back to
  32,768 context / 4,096 output. Explicit per-model options take precedence.
  These are not measured deployment limits or guarantees.
- Pricing is unknown, not inferred from model names. V2 supplies no price tiers;
  do not interpret a host's zero/empty cost display as confirmed free usage.

| Model ID | Context | Output budget |
| --- | ---: | ---: |
| deepseek-v4-flash-0731 | 1,000,000 | 32,768 |
| deepseek-v4.1-flash-1017 | 1,000,000 | 32,768 |
| eurollm-22b-instruct-2512 | 32,768 | 4,096 |
| gemma-4-31b-it | 256,000 | 16,384 |
| glm-5.3 | 1,000,000 | 32,768 |
| glm-5.3-flash | 1,000,000 | 32,768 |
| meta-llama-3.1-8b-instruct | 128,000 | 8,192 |
| mistral-large-4-1t-a52b | 1,000,000 | 32,768 |
| qwen3-30b-a3b-instruct-2507 | 256,000 | 16,384 |
| qwen3-coder-next | 256,000 | 16,384 |
| qwen3-omni-30b-a3b-instruct | 256,000 | 16,384 |
| qwen3.5-397b-a17b | 256,000 | 32,768 |
| qwen3.6-35b-a3b | 262,000 | 16,384 |
| qwen3.8-27b | 262,000 | 32,768 |

Context budgets use rounded values from the [GWDG model table](https://docs.hpc.gwdg.de/services/ai-services/chat-ai/models/index.html)
where available. DeepSeek V4.1 Flash 1017, EuroLLM 22B, GLM 5.3, and Mistral
Large 4 are absent there; their context budgets are based on upstream model or
provider documentation and are not verified on SAIA. All output budgets are
proposed starting values, not verified SAIA output ceilings. Deployments may
accept less; configure verified limits through options.

Shared options (both adapters):

```jsonc
{
  "baseURL": "https://chat-ai.academiccloud.de/v1",
  "refreshIntervalMs": 900000,
  "models": {
    "your-model-id": {
      "tools": true,
      "context": 131072,
      "output": 8192,
      "reasoningField": "reasoning_content"
    }
  }
}
```

Limits above are illustrative, not SAIA deployment specifications. Omit
`reasoningField` unless the deployed API needs an explicit field override.
`SAIA_BASE_URL` supplies the endpoint when the option is absent. HTTPS is
required except for literal loopback HTTP (`127.0.0.1` or `[::1]`) used in tests.
Discovery redirects are rejected. No dummy inference requests are made.

## Optional ai_usage reporting

Configure these environment variables on the OpenCode server process:

| Variable | Purpose |
| --- | --- |
| `SAIA_AI_USAGE_URL` | ai_usage base URL, optionally including a reverse-proxy path prefix |
| `SAIA_AI_USAGE_UPLOAD_TOKEN` | Dedicated upload secret, **not** the SAIA API key |
| `SAIA_AI_USAGE_PROXY_AUTHORIZATION` | Optional separate `Basic …` proxy Authorization header |

On ai_usage, the matching server-side secret is `SAIA_INGEST_TOKEN` (at least
32 characters). Leave both client URL/token variables unset to disable
reporting. Partial or invalid configuration disables reporting with a sanitized
warning; it does not disable SAIA inference.
Proxy authorization must use `Basic` with canonical base64 credentials. Reusing
`SAIA_API_KEY` as the upload token is explicitly rejected.

If the ai_usage deployment sits behind a reverse proxy that enforces HTTP Basic
auth (for example nginx returning `401` with `WWW-Authenticate: Basic`), the
upload token alone is not enough: set `SAIA_AI_USAGE_PROXY_AUTHORIZATION` to the
complete `Basic <base64>` header. An HTML `401` from the proxy means the proxy
credentials are missing or wrong; it does not by itself indicate a bad upload
token.

On V1, these variables must be present in the environment of the process that
starts OpenCode. V1 has no `opencode service` command (that is V2); export them
from the shell or a launcher, and re-source after changing them.

The plugin sends `POST <base-url>/api/saia/observations` with
`Content-Type: application/json` and `X-AI-Usage-Token`. Only the separately
configured proxy Basic header is added. Remote URLs must use HTTPS; literal
loopback HTTP is allowed. URL credentials, query strings, fragments, and
redirects are rejected.

Each ordinary inference response, including errors such as 429, can produce:

```json
{
  "observedAt": "2026-11-11T12:33:08.000Z",
  "windows": [{ "window": "hour", "limit": 400, "remaining": 399 }]
}
```

- Supported windows: `10s`, `minute`, `hour`, `day`, `month`.
- Per window, prefer a complete valid pair of
  `x-ratelimit-limit-requests-<window>` /
  `x-ratelimit-remaining-requests-<window>`. Fall back to a complete valid legacy
  `x-ratelimit-limit-<window>` / `x-ratelimit-remaining-<window>` pair. Pairs are
  never mixed across formats. Generic/token-limit headers are not interpreted.
- Both counts must be safe integers, `limit > 0`, and
  `0 <= remaining <= limit`. Malformed/partial windows are omitted. No complete
  windows means no upload. Proxy-rewritten/prefixed headers are not inferred.
- `observedAt` is the local UTC time response headers are observed. It is not
  synthesized from server dates or bumped for duplicate milliseconds. Keep
  machine clocks synchronized; ai_usage rejects timestamps over 30 seconds
  ahead and may reject equal/older observations.
- ai_usage replaces its latest snapshot: missing windows disappear. The plugin
  does not merge old windows, guess resets, or report token/cost usage.
- Only the configured SAIA inference endpoint and Bearer credential are
  observed. Discovery, unrelated accounts/providers, and upload responses are
  excluded. Prompts, answers, the SAIA key, arbitrary headers, project paths,
  and session IDs are never uploaded.
- **All observations map to `saia:default`.** Point only clients using the same
  SAIA account and quota scope at one server. Proxy pools or different SAIA
  credentials must not be combined. The plugin cannot enforce this across
  independent installations. Within one plugin instance, changing to a
  different key disables reporting until reload rather than combining scopes.
  Before reloading, confirm the selected account matches the ai_usage server's
  quota scope (or configure a separate destination). This also guards saved
  keys against accidental reuse as the upload token.

Uploads never await in the inference path or consume the inference stream.
The background sender has a three-second timeout, one in-flight request and
one newest pending snapshot. Intermediate snapshots can be dropped under load.
There is no persistent queue, retry loop, or shutdown flush that delays exit.
`202 {"accepted":false}` is normal stale/duplicate handling. Unavailability,
invalid credentials (401), disabled ingestion (404), and other failures only
produce throttled, sanitized diagnostics. The next real inference response
provides the next opportunity to report.

This is a best-effort quota snapshot, **not an accounting ledger**. Concurrent
SAIA responses can arrive out of provider processing order. Nothing is appended
to assistant answers; use the ai_usage dashboard for display.

## Tests

```sh
npm run typecheck
npm test
npm run test:compat
npm audit --omit=dev
```

The suite uses Node's built-in `node --test` runner, so run it with Node 22.
Tests create temporary fixtures under `/tmp/opencode`; create that directory
first if it does not exist. Bun 1.3+ can drive the build
(`bun install --ignore-scripts`, `bun --bun run build`), but keep test runs on
Node.

Unit tests use fetch mocks. The compatibility script packs and installs the
production package, runs OpenCode V1 1.18.29 (downloaded with npm exec) and the
installed V2 CLI in isolated temporary homes, and exercises both environment and
saved-key authentication, discovery, streamed reasoning, a harmless tool
round-trip, and quota uploads against **local mock servers only**. The V2 saved
key is connected through the same integration API used by `/connect`, with no
`SAIA_API_KEY` set; V1 uses a mock credential-store fixture. Tests never use your
real configuration, SAIA credentials, or
ai_usage server. Fixtures are left under `/tmp/opencode/saia-compat-*` for
diagnostics. `OPENCODE_V2_BIN` can select a V2 binary; `--v2-only` skips V1 when
running `node test/compatibility.mjs` directly after a build.

The dated SAIA tool checks described above were separate user-authorized live
tests, not part of this automated suite. Deployed token ceilings, broader tool
reliability, and a live ai_usage deployment require separate verification.
