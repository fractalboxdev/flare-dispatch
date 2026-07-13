# @fractalboxdev/flare-dispatch-review-agent

A provider-agnostic, **Worker-side** code-review engine that calls a model
through the `modelGateway` capability (`@fractalboxdev/flare-dispatch-core`) — backed by the
**Cloudflare Workers AI binding** (`env.AI`) routed through an AI Gateway. Powers
the `pr-review` run (`runs/pr-review.ts`) — there is no `review-agent` container
CLI; every model call happens in the Worker against a configurable backend.

> **No model API key.** Routing model calls through the Workers AI *binding*
> (rather than POSTing to an OpenAI-compatible `/chat/completions` endpoint)
> makes the **binding the auth** — Workers AI is account-billed, so no API key
> travels with the request. The engine carries no base url and no secret; it
> just yields the `ModelGateway` Tag the way a run yields `config` / `sandbox`,
> and the runtime provides it (live: `makeModelGatewayLive(env.AI, gatewayId)`;
> tests: the core `ModelGatewayFake`).

## Engine surface

| Export | What it does |
|---|---|
| `riskTier({ diff })` | Pure heuristic → `"trivial" \| "lite" \| "full"` from diff size + sensitive paths. No model call. |
| `completeStructured({ backend, model, mode, system, userBody, jsonContract, schema, … })` | **The reusable structured-output core** — ask the configured backend for one answer decoded against a caller-supplied `Schema`. Owns the whole tools/json dance: per-mode user framing (tool-call line vs strict-JSON instruction + the compact `jsonContract`), the empty-tool-calls → `json` auto-fallback, `<think>`/fence stripping, and Schema validation. What the `spec-drift-pr` / `ci-triage-pr` runs call directly; `renderUser?` is the full-control escape hatch. |
| `reviewDomain({ agent, diff, systemPrompt, tier, model, backend, mode })` | One domain reviewer → `ReadonlyArray<Finding>` — a thin `completeStructured` over the `report` tool's `{ findings }` schema. |
| `coordinate({ findings })` / `coordinateReview(...)` | **PURE, no model call.** Dedup (by `path,startLine,title`) + counts-by-`level` + verdict-by-rule → `CoordinatedReview` (no `tier`). The current run is authoritative — no carry-over. Can never fail. |
| `stripDiffNoise(diff)` / `capDiff(diff)` | Drops lockfile / minified / generated / vendored file sections from a unified diff, then caps the size. |
| `extractJsonText(text)` | Strips `<think>…</think>` blocks + code fences and isolates the outermost JSON value — the `json`-mode parsing front-end. |
| `resolveBackend(getConfig, { namespace? })` | Resolves the active backend profile (model id + mode) from config under a **namespace** (default `pr-review`). **No API key.** |
| `namespacedKey(ns)` / `backendConfigKey(ns)` / `promptKey(ns)` / `guidelinesKey(ns)` | The `<ns>.<key>` CONFIG_KV convention in one place — how a recipe derives `spec-drift.repos`, `ci-triage.prompt`, `pr-review.guidelines`, etc. |

`Finding` / `ReviewOutput` are the wire contract shared with the run.

### Request shape (per model call)

`completeStructured` is the only model-calling surface (`reviewDomain` rides it;
`coordinate` is pure and makes no request). Each call is one
`modelGateway.complete(...)`:

```
modelGateway.complete({
  model: <model>,            // a bare Workers AI id, e.g. @cf/meta/llama-3.3-70b-instruct-fp8-fast
  system: <systemPrompt>,
  user: <diff + instruction>,
  maxTokens: 2048,
  tools: [ { name: "report", description: …, parameters: <jsonschema> } ],  // tools mode only
})
→ { toolCalls: [{ name, arguments }], text }
```

The runtime's live `ModelGateway` maps that onto the Workers AI binding:

```
env.AI.run(model, { messages: [{role:"system",…},{role:"user",…}], tools? },
           gatewayId ? { gateway: { id: gatewayId } } : undefined)
→ { response?: string, tool_calls?: [{ name, arguments }] }
```

- **tools mode** reads the first `report` tool call's `arguments` → Schema-decode. Workers AI returns `arguments` as a parsed **object** (the engine also tolerates an OpenAI-style JSON **string**). Empty `toolCalls` → auto-fallback to one `json`-mode retry.
- **json mode** reads `text` → strip `<think>`/fences → `JSON.parse` + Schema-decode.

### Output mode: `tools` vs `json`

Reasoning models (e.g. DeepSeek-R1 distills) return **no** tool calls and emit `<think>…</think>` prose, so tool-calling fails for them. Each backend resolves a `mode`:

- **`tools`** (the `workers-ai` default) — sends the `report` tool, Schema-validates its args. If it returns zero tool calls, the engine **auto-retries once in `json` mode**.
- **`json`** (pin this for reasoning models) — no tools; the model returns a strict JSON object that the engine strips/parses/Schema-decodes. A parse/decode failure raises `StructuredOutputInvalid`.

The mode applies to **`completeStructured`** (and so to `reviewDomain` and the recipes built on it). Coordination is deterministic code — `coordinate` makes no model call, so it has no mode and can never raise `StructuredOutputInvalid`.

## Configurable backend — operator contract (namespaced)

The config contract is **namespaced** so each consumer owns its keys: `pr-review`
is the default namespace; the `spec-drift-pr` / `ci-triage-pr` runs resolve the
same machinery under `spec-drift.*` / `ci-triage.*` via
`resolveBackend(get, { namespace })`. For a namespace `<ns>`, the active backend
is `config.get("<ns>.backend")` → `workers-ai` (default), `anthropic`, or
`bedrock`. Each names a model ROUTE (not an agentic tool) resolved from CONFIG_KV
— **no API key, the Workers AI binding is the auth** (shown here for `pr-review`):

| Backend | CONFIG_KV keys |
|---|---|
| `workers-ai` (the Workers AI binding / AI Gateway route) | `pr-review.workers-ai.model` (a bare `@cf/...` catalog id, **or** a `deepseek/`-prefixed hosted reasoner like `deepseek/deepseek-reasoner` — BYOK via AI Gateway), `pr-review.workers-ai.mode` (default `tools`; pin `json` for reasoning models) |

`pr-review.prompt` optionally REPLACES the per-domain reviewer system prompt;
otherwise the engine's generic default is used (no project-specific rubric is
shipped). `pr-review.guidelines` is ADDITIVE — `composeSystemPrompt` appends it
to the base prompt as authoritative house rules, so an operator can layer a
suppression rubric, conventions, or severity calibration on top of the
maintained default without forking it. Model ids are bare `@cf/...` (the Workers
AI binding's own naming) —
**not** the `workers-ai/@cf/...` compat-endpoint prefix the old HTTP path used.

The model name passes through verbatim — swapping models is a CONFIG_KV edit,
not a code change. An AI Gateway can be put in front of all calls by setting the
`AI_GATEWAY_ID` var on the Worker (the runtime threads it into the binding).
