# ADR-0013 — Local run execution: a developer runs a run definition against a working tree before pushing

**Status:** proposed 2026-11-08
**Related:** `packages/core/src/testing.ts` · `packages/core/src/fakes/step-runner-inline.ts` · `packages/core/src/services/sandbox.ts` · `infra/Dockerfile.sandbox*` · ADR-0010 · ADR-0011 · ADR-0012

## Context

- A developer learns a gate's verdict only after a push, an admission wait
  and a container start.
- `CFRuntimeTest` runs a run program in Vitest against in-memory fakes, with
  a scripted sandbox. It tests the program's logic, not the verdict on real
  code.
- No path executes a real run definition against a working tree.

## Decision

### The command

- A `flare-dispatch run <run> [--input <key>=<value>]... [--part <label>]`
  command executes a run definition locally, in Node.
- It assembles `RunContext` from local Layers:

| Capability | Local Layer |
| --- | --- |
| Steps | `StepRunnerInline`: runs each body inline and prints its start, end and duration |
| `sandbox` | `SandboxDocker`: one container per execution, from the image the run's `sandboxImage` names, built from the same `infra/Dockerfile.sandbox*` file |
| `cache` | A directory under the user's cache home, keyed as in `cache-r2.ts` |
| `artifact` | Files under `.flare-dispatch/artifacts/<execution id>/` in the working tree |
| `checks`, `github`, `notice`, `email` | Printing fakes. Nothing is written to GitHub or sent. |
| `secrets` | Refuses every read with `SecretUnavailable` |
| `modelGateway` | A provider key from the environment variable `--model-key-env` names, or refuses with `ModelUnavailable` |
| `config` | Values from `.flare-dispatch/config.json` in the working tree, in place of `CONFIG_KV` |
| `io` | The local process |
| `childRuns` | Runs each child inline, one after another |
| `browser`, `cloudflare`, `oidc`, `mailbox` | Refuse with `CapabilityUnavailable` |

### The container

- The working tree is copied into the container. It is never mounted, so a
  command cannot write into the developer's `.git/hooks`, editor
  configuration or shell files.
- The container runs with every capability dropped and with
  `no-new-privileges`.
- A run with a `writeback` returns its changes as a patch file the developer
  applies by choice.

### The result

- The command prints the rendered `CheckReport` (ADR-0012) and the reuse key
  (ADR-0011) the dispatcher would compute for the same head.
- A local result never writes the reuse store, a check-run, or any
  `executions` row. A verdict produced on a developer machine is advisory and
  never gates a merge.
- The verdict matches CI only when four things match: the run's `version`,
  the image digest, the input, and the files under the declared reuse paths.
  The command prints the local image digest so a mismatch is visible.

## Options considered

- **Run the dispatcher under `wrangler dev` and dispatch to it.** It exercises
  the real Worker. But it needs the full deploy configuration on a laptop
  (D1, KV, R2 and Workflows bindings, App credentials), and its writes go to
  whatever those bindings point at.
- **Extend `CFRuntimeTest` with a real sandbox.** It mixes unit-test fakes
  with real execution in one entry point that tests import.
- **A separate command with its own local Layers (chosen).** It costs a
  second `SandboxService` implementation over a local OCI engine, kept in
  step with `sandbox-cf.ts` through the shared service contract and its tests.

## Criteria

1. The developer gets the verdict CI would give, before pushing.
2. Local execution cannot change the developer's machine outside the
   container.
3. Nothing from a laptop reaches GitHub or a shared cache.

Criterion 2 decided the copy-in, patch-out rule. Criterion 3 decided that
local results are advisory and never stored.

## Consequences

- `check` runs and gate parts are runnable before a push, with the same
  report format as their check-runs.
- **Accepted cost:** browser runs, secret-reading runs, and runs that write to
  GitHub do not run locally, and fail with a typed error that names the
  missing capability.
- The command needs a local OCI engine, such as Docker or Podman.

## Revisit triggers

- Local and CI verdicts disagree on the same reuse key.
- A local browser capability becomes needed, for example a Playwright
  container standing in for Browser Rendering.
