# ADR-0011 — Execution result reuse: a green verdict is reused when its declared inputs are unchanged

**Status:** proposed 2026-11-08
**Related:** `packages/core/src/define-run.ts` · `apps/dispatcher/src/workflow.ts` · `apps/dispatcher/src/routes/webhook.ts` · `runs/contextful-gate.ts` · ADR-0007 · ADR-0009 · ADR-0010

## Context

A gate part runs again whenever its commit changes, even when nothing it reads
changed:

- a pull request that edits only documentation re-runs every compile and test
  part;
- a rebase that leaves a crate's tree identical re-runs that crate's tests;
- a fix to one failing part re-runs every green part on the new head.

Each re-run pays for:

- an admission slot;
- a container start;
- a checkout;
- the dependency restore or install;
- the command itself.

ADR-0007 makes the restore and the compile cheaper, but it does not skip
them. Workflows step memoization covers replay inside one instance only. A new
commit is a new instance.

## Decision

### Declaring reuse

- A run may declare `reuse: (input) => ReuseSpec | undefined`, where
  `ReuseSpec` is:
  - `paths: readonly string[]`: repository-relative files and directories
    whose content determines the verdict;
  - `key: unknown`: the input fields that change the command, such as the
    command line and the part label, as canonical JSON;
  - `env?: readonly string[]`: `CONFIG_KV` keys whose values change the
    command.
- `undefined` turns reuse off for that input.
- Only runs whose verdict is a function of files and command declare reuse:
  `check` and contextful gate parts.
- A run that calls a model never declares reuse, because the same input can
  produce a different verdict.
- `paths` must include every lockfile and toolchain file the command reads,
  such as `Cargo.lock`, `rust-toolchain.toml` and `pnpm-lock.yaml`.

### Reuse key

The reuse key is the SHA-256 of these values, in order:

1. the run's `name` and `version`;
2. the sandbox image tag the run resolves to;
3. the repository slug;
4. `key`;
5. the values of the `env` keys;
6. for each declared path, the git object id at the head commit, or `absent`.

The dispatcher reads the object ids in one GitHub GraphQL request, one aliased
`repository.object(expression: "<sha>:<path>") { oid }` field per path. A
directory's id is its tree id, so it changes when any file below it changes.

### Lookup

- Lookup happens in the Workflow's first step, before admission. A hit takes
  no admission slot and starts no container.
- Entries live in R2 under `reuse/<owner>/<name>/@<lane>/<key>.json`. The
  lanes follow ADR-0007's compile-cache lanes:
  - a default-branch execution reads and writes `@base`;
  - a pull-request execution reads `@pr-<n>`, then `@base`, and writes only
    `@pr-<n>`;
  - a fork pull request reads `@base` and writes nothing.
- An entry is written only for a `success` conclusion. A failure, an error, or
  a `neutral` skip always re-executes on the next dispatch, so a flaky red
  never sticks.
- An entry holds the conclusion, the rendered summary (ADR-0012), and the id,
  head commit and log link of the execution that produced it. It is at most
  64 KiB.

### On a hit

- The execution concludes its check-run with the stored conclusion.
- The summary opens with `Reused from <execution id> at <short sha>`, linking
  that execution's log.
- The execution row records `reused_from`, and the run cost is the GraphQL
  request and the R2 read.

### Forcing execution

- A GitHub re-run request always executes.
- The `CONFIG_KV` key `reuse.disabled:<repo>` turns reuse off for a
  repository.
- An entry expires after `REUSE_TTL_DAYS`, 14 by default, through an R2
  lifecycle rule.

## Options considered

- **Per-step or per-action result cache.** This is the granularity of
  Bazel's action cache, Turborepo and Nx task hashes, and Dagger's function
  cache. It is finer-grained. But the costs that dominate here (admission,
  container start, checkout) come before the first step that could hit, so
  it saves little per hit.
- **Path filters on triggers (run a part only when its paths changed).**
  - Cheaper still: no dispatch at all.
  - Costs:
    - a skipped required check stays pending under branch protection;
    - "changed since what" is ambiguous on a rebase or a force-push;
    - a check that was red on the base stays unreported.
  - Reuse reports a real green, tied to the execution that proved it.
- **Execution-level reuse (chosen).** The hit happens before any paid work.
  It costs an input declaration per run, and that declaration can be wrong.

## Criteria

1. Cost per verdict on a pull-request push.
2. A reused verdict is a real green, traceable to the execution that proved
   it.
3. No path from a pull request to a verdict that another branch reads.

Criterion 1 decided against the per-step cache. Criterion 2 decided against
path filters.

## Consequences

- Documentation-only and rebase-only pushes conclude gate parts in seconds,
  with no container.
- **Accepted cost: an undeclared input produces a stale green.** A part that
  reads a file outside `paths` keeps its old verdict when that file changes.
  The run's unit test asserts its `paths` cover the command's inputs where
  the command names them. The re-run button is the escape hatch.
- Each dispatch of a reuse-declaring run makes one more GitHub GraphQL
  request. ADR-0009's per-installation reserve covers it.

## Revisit triggers

- A stale green traced to an undeclared path.
- The share of executions that hit falls below 10% over a month, so the
  lookup costs more than it saves.
