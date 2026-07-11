# FlareDispatch — New-Repo Build Plan

**Decision (made): incremental refactor over rewrite.** We keep the proven substrate and build the combinator tier its architecture already implies, porting into this new repo across **5 PRs**. We do *not* redesign the DSL from scratch.

> This is a greenfield build in a fresh repo, so there is no live production branch to protect — the in-place-refactor risk apparatus (regression-via-existing-tests, main-branch drift, staged safety) does not apply. What survives is a small set of design decisions the build must get right, folded into the relevant PRs below.

---

## 1. What we keep, what we add

The DSL **core** is good and load-bearing — we port it as-is in spirit:

- `capability → primitive → recipe` layering, enforced by the two entry points.
- A `Run` is a portable value bound to no runtime; `defineRun` is a passive constructor (a total function of its spec), so anything that assembles a spec and calls it produces a `Run` **indistinguishable to the dispatcher** — it registers unchanged and executes against the same Layer graph.
- The `StepRunner` Tag keeps `step()`'s durable-checkpoint mechanism swappable across CF / Dev / Test.
- Every failure is a `Schema.TaggedError` in a closed `RunError` union.

The **problem in the source** was duplication at the *authoring seam* — copy-paste-and-tweak exactly where the DSL should own a shared abstraction. In a new repo we never port that duplication; we build the abstraction once and author the real runs on it.

**One improvement we bake in because we're greenfield:** make `defineRun` **generic over `R`** (`defineRun<O, E, R>`) so each run carries its *precise* typed dependencies and a narrowed error channel, while the run **registry stores the erased upper bound** `Run<unknown, RunError, RunContext>`. This is the standard variance pattern (the same way Effects and Layers are stored erased) — a localized type design, not a rewrite. The old codebase's monomorphic `Effect<O, RunError, RunContext>` field was its one genuine typing limitation; we simply don't reproduce it.

**And we make one shape universal:** every run is `Trigger → Gate → Gather → Act → Sink`, with the trigger and the sink as the only variable poles — so a verify run and a gather-signals-then-draft-PR run (self-healing) are the same core with different poles, not two subsystems (§3).

---

## 2. The duplication the combinator tier owns

Named clusters the source copy-pasted, each of which becomes **one shared abstraction** here (so it is written once, not N times):

| Cluster | Owned by |
| --- | --- |
| command-run skeleton (checkout → loadSecrets → exec → upload-log → fail-on-nonzero) | `commandRun` builder |
| fan-out skeleton + shard schemas | `fanoutRun` builder |
| report-PR skeleton (resolveBackend → structured → openDraftPullRequest) | `reportPrRun` builder |
| detached-exec + DONE-sentinel poll | `sandbox.runToCompletion` primitive (a `Schedule` + `Effect.timeout`) |
| capability accessors (pure delegation) | `Effect.serviceFunctions(Tag)` |
| D1 retry/wrapper shells | **`@effect/sql-d1`** `SqlClient` (adopted) |
| R2 get-or-null/throw, container-tar | thin `runtime-cf/src/cf/*` helpers |
| model transport + structured-output | **`@effect/ai`** (+ `-openai` / `-anthropic`); `completeStructured` = thin wrapper over its native structured output |
| trigger idempotency key `{run}:{repo_}:{sha12}` + skip-drafts/bots | trigger helpers in `-core/recipes` |
| dispatch create + `already_exists` dedup | one `instantiateRun`, one dedup predicate |

The recipe "clones" the source carried (verbatim `*.run.ts` copies of their `runs/` twins) simply do not exist here — there is nothing to delete because we never author them.

---

## 3. Target architecture — one `run()`, two pluggable poles

Every run — verify *or* draft-PR — is the same pipeline:

```
Trigger(Source) → Gate → Gather → Act → Sink(emit)
```

Only the **Trigger** (what starts me) and the **Sink** (what I emit) differ; the middle is Effect composition — trivial for a verify run (checkout, exec), substantive for a draft-PR run (read logs/diff, `completeStructured`). `defineRun` + the dispatcher already unify *execution*; these two poles unify *authoring and causality*.

```mermaid
flowchart LR
  GH["GitHub event"] --> BUS
  CRON["Cron"] --> BUS
  WH["Webhook"] --> BUS
  BUS["event bus (Queue + coordinator DO)"] --> RT["router: match subscriptions → gate → instantiateRun"]
  RT --> RUN["Run: Gather → Act → Sink<br/>over defineRun&lt;O,E,R&gt; · RUN_REGISTRY (erased)"]
  RUN -->|publish typed RunOutcome| BUS
```

**The two poles.** A trigger is an event *subscription*; a sink is a typed *capability*. Run outcomes are themselves typed events on the same bus, so the dispatcher is a **signal router** and the feedback loop closes:

```ts
type DispatchEvent =
  | { _tag: "GitHubEvent"; kind: "pull_request" | "push" | "check_suite" | "webhook"; /* … */ }
  | { _tag: "Schedule";    cron: string }
  | { _tag: "RunOutcome";  run: RunName; status: "passed" | "failed"; outcome: Json; cause: RunRef; depth: number }

type Trigger<I> = { match: (e: DispatchEvent) => Option<I> }   // subscription + decode to input
type Sink<O>    = StatusSink | PrSink | ArtifactSink            // composable — a run may use several
```

**Self-heal is a preset, not a special case** — a run whose Source is another run's failure and whose Sink is a draft PR:

```ts
export const selfHeal = (target: RunName) => reportPrRun({
  trigger: onRunOutcome({ run: target, status: "failed", maxDepth: 2 }),
  gather:  (o)   => collect({ logs: r2.get(o.outcome.logRef), diff: gh.diff(o.cause) }),
  act:     (sig) => completeStructured(HealPlan, prompt(sig)),
  sink:    PrSink.draft,
});
```

`commandRun` = `run` with `sink = StatusSink`; `reportPrRun` = `run` with `sink = PrSink`; `selfHeal` = `reportPrRun` + `onRunOutcome`. The three builders survive as presets over one `run()`.

**Combinator hook contracts** (get these right at authoring time):

- Hooks are **effectful** and pin `E ⊆ RunError` — the core `gather`/`act` (and preset aliases like `commandRun`'s `resolveCommand`/`onResult`) all return `Effect<…, RunError, R>`. Effectful hooks are what let `offload-test` run an inline retry (distinct from the cross-run draft-PR heal above).
- The `skip` path has its own output type and is a green no-op before checkout.
- `Effect.serviceFunctions(Tag)` covers **pure-delegation** accessors only. Accessors that default/reshape opts, or that are generic over a method's type parameter (e.g. `completeStructured<A>`), stay hand-written — those are exactly the double-edit hazards, and `serviceFunctions` structurally can't host them.
- Raw `defineRun` stays the escape hatch for genuinely bespoke runs (`deploy-smoke`, `product-demo`, `pr-review`); combinators cover the ~80% case only.

---

## 4. A run authored on `commandRun`

`commandRun` lives in `@fractalbox/flare-dispatch-core/recipes` and **returns `defineRun(spec)`** — same portable `Run`, same Layer graph, same `StepRunner` seam. A run drops from the ~260-line hand-written skeleton to ~45 lines:

```ts
export const workerDeploy = commandRun({
  name: "worker-deploy",
  version: "1.0.0",
  limits: { maxDurationSec: 1800 },
  logName: "step.log",
  timeoutSecDefault: 900,

  // Owns the {run}:{repo_}:{sha12} key, the default-branch gate, and the
  // decoded-default restatement (install:false, secrets:[]) every trigger copies.
  trigger: checkSuiteTrigger({ defaultBranchOnly: true, failOnNonZeroExit: true }),

  // The one bespoke stage — effectful, E ⊆ RunError; skip no-ops green pre-checkout.
  resolveCommand: (input) => Effect.gen(function* () {
    const command = input.command ?? (yield* config.get(key.command(input.repo)));
    if (!command?.trim()) {
      yield* io.log("warn", `worker-deploy: ${input.repo} not opted in`);
      return commandRun.skip({ skippedReason: "not-configured" });
    }
    const secretNames = input.secrets.length ? [...input.secrets]
      : splitCsv(yield* config.get(key.secrets(input.repo)));
    return { command, secretNames, secretPrefix: input.secretPrefix ?? (yield* config.get(key.prefix(input.repo))) };
  }),

  failLabel: "deploy",
  onResult: (r) => Effect.succeed({ deployed: r.exitCode === 0 }), // effectful — self-heal rides here
});
```

The builder emits the identical checkout → `loadSecrets` → exec → upload-log → `AcceptanceFailed` body. Every builder-body failure (`AcceptanceFailed`, `StepFailed`, `SecretsMissing`, `ExecFailed`) is a `RunError` member, so `catchTag` exhaustiveness holds — provided the builder signature pins hook `E ⊆ RunError` (above). `offload-test` collapses the same way; `oxlint` drops to ~15 lines.

---

## 5. The 5 PRs

Each builder ships with a **builder-level test** (fakes + one live smoke) — the run-level fakes alone can pass while a combinator diverges against live CF, so the shared abstraction gets its own coverage.

| PR | Scope |
| --- | --- |
| **PR1 — Foundations & typed core** | Port `defineRun` as `defineRun<O,E,R>` with the erased `RUN_REGISTRY`. Stand up `@fractalbox/flare-dispatch-protocol` (DispatchPayload + one key/fingerprint fn, single `:` separator). Route **all** dispatch create-sites through one `instantiateRun` + one dedup predicate covering every `already_exists` form. `serviceFunctions` accessors for pure passthrough; hand-write the defaulting/generic ones. **Land a thin `completeStructured` in core over `@effect/ai`'s native structured output** (drops the forced-tool-call + `json-extract` + hand-rolled `classifyProviderError`) so PR3 and PR5 both consume one implementation. Add the `DispatchEvent` union (incl. `RunOutcome`) to the protocol and a publish-outcome `step()` on run completion — the dispatcher becomes the event router, and the outcome→trigger edge funnels through the same `instantiateRun`. |
| **PR2 — command + fanout builders** | `commandRun`, `fanoutRun` with effectful hooks (`E ⊆ RunError` pinned, typed `skip`), trigger helpers (`checkSuiteTrigger` / `prPushTrigger` / `onRunOutcome`, all the same `Trigger<I>` shape), render helpers (`acceptanceFailure`, `draftPrBody`). Author `oxlint` / `worker-deploy` / `offload-test` and `matrix-fanout` / `vitest-shard` / `playwright-e2e` on them. |
| **PR3 — reportPr + runToCompletion** | `reportPrRun` (consumes core `completeStructured`) → `ci-triage-pr` / `spec-drift-pr` / `finops-audit`. `sandbox.runToCompletion` — a `Schedule` (detach → `Effect.timeout` kill → poll-until-sentinel → bounded-read) — plus best-effort upload via `Effect.option` → `cdp-acceptance` / `product-demo`. Formalize `StatusSink` / `PrSink` as the Sink capability (so a verify run can also emit a draft PR) and author `selfHeal` as `reportPrRun` + `onRunOutcome`. |
| **PR4 — runtime-cf CF adapters** | Adopt **`@effect/sql-d1`** for the D1 `SqlClient` — retires the `tryPromise` shells + `d1Retry`; failure posture is `Effect.retry` + combinators (`orDie` / propagate / `catchAll`), not a `FailurePolicy` enum. `r2` get-or-null/throw and `container-tar` pack/restore stay as thin `runtime-cf/src/cf/*` helpers. Pure cores and atomic SQL stay as-is. |
| **PR5 — adopt `@effect/ai`** | Make **`@effect/ai`** (+ `@effect/ai-openai` / `@effect/ai-anthropic`) the single model stack — retires the bespoke `modelGateway` transport and the parallel `demo-agent/model.ts`. `demo-agent` and the review/heal agents share one `@effect/ai` provider `Layer` over the in-container HTTP proxy; `completeStructured` (PR1) is the thin wrapper over its native structured output. Already proven on our CF Workers, so this is `Layer` wiring, not net-new transport. |

---

## 6. Effect-TS leverage — built-ins over hand-rolled

The core is already idiomatic Effect (`Schema.TaggedError` union, `defineRun`, the `StepRunner` Tag). Rule for the port: **reach for an Effect built-in before writing a control-flow primitive, and adopt a maintained ecosystem package before hand-rolling a subsystem.**

**Built-ins (in-core, no new deps):**

| Hand-rolled | Effect built-in |
| --- | --- |
| `runToCompletion` poll dance (`maxConsecutiveExecFailures`) | `Effect.repeat` + `Schedule` (`spaced`/`exponential` ∘ `recurUntil` ∘ `upTo`); `Effect.timeout` for the kill |
| `d1Retry` / model-retry loops | `Effect.retry(Schedule…)` with `Schedule.whileInput` on a tagged error |
| `FailurePolicy` enum | `Effect.orDie` / propagate / `Effect.catchAll(fallback)` combinators |
| `uploadBestEffort` | `Effect.option` / `Effect.ignore` |
| `sharded` fan-out | `Effect.all` / `forEach(_, { concurrency })` |
| `json-extract` + ad-hoc validation | `Schema.parseJson(Schema)` / `Schema.decode` |
| `Trigger.match` / event + error dispatch | `Match` + `Match.exhaustive`; `catchTags` (never `._tag`/`switch`) |

**Ecosystem packages (already proven on our CF Workers):**

- **`@effect/ai`** (+ `@effect/ai-openai` / `@effect/ai-anthropic`) subsumes `modelGateway` + `completeStructured` and collapses the two-model-stack problem — its native structured output replaces the forced-tool-call emulation. → **PR5**.
- **`@effect/sql-d1`** replaces the D1 `tryPromise` shells + `d1Retry`. → **PR4**.
- **`Config` + `Redacted`** back `loadSecrets` (redaction stops secrets leaking to logs); **`@effect/platform` `HttpClient`** for model / `gh` transport.

**Kept bespoke — no Effect equivalent:** the CF-durable event bus (Queue + coordinator DO) and `instantiateRun` dedup (Effect's `PubSub`/`Queue` are in-memory; durability is CF's job — Effect `Stream`/`Match` handle only the *routing* on top); `step()` / `StepRunner` (CF Workflows is the durable engine); `defineRun` generic-over-`R` variance; the combinator tier itself.

---

## 7. Design decisions locked

- **One `run()`, two pluggable poles** — a `Trigger` (event subscription) and a `Sink` (typed capability); `commandRun` / `fanoutRun` / `reportPrRun` are presets, and the dispatcher is a signal router over one event bus. Self-heal is `reportPrRun` + `onRunOutcome`, not a subsystem.
- **Feedback loops stay finite** — `RunOutcome.depth` increments each causal hop and `onRunOutcome({ maxDepth })` refuses beyond N; the skip-drafts-and-bots gate and the `{run}:{repo_}:{sha12}` dedup key are the other two guards.
- **Generic-over-`R` `defineRun` + erased registry** — precise typed deps and narrowed error unions from day one; not a conceded limitation.
- **`serviceFunctions` for pure delegation only** — defaulting/reshaping and method-generic accessors stay hand-written.
- **Combinator hooks are effectful with `E ⊆ RunError`**; raw `defineRun` remains the escape hatch for bespoke runs.
- **Effect built-ins over hand-rolled control flow** — `Schedule` / `retry` / `timeout`, `Effect.all({ concurrency })`, `Schema.parseJson`, `Match` / `catchTags`; adopt `@effect/ai` (PR5) and `@effect/sql-d1` (PR4) over bespoke stacks (§6).
- **PR5 adopts `@effect/ai`** — one provider `Layer` over the in-container HTTP proxy (proven on our CF Workers), not a bespoke transport; nothing in PR1–PR4 depends on it (the shared `completeStructured` lands in PR1, so PR3 does not).
