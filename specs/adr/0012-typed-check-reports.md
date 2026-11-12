# ADR-0012 — Typed check reports: runs return findings and test cases, the dispatcher renders them into the check-run

**Status:** proposed 2026-11-08
**Related:** `packages/core/src/services/checks.ts` · `packages/runtime-cf/src/checks-github.ts` · `apps/dispatcher/src/workflow.ts` · `runs/pr-review.ts` · `runs/vitest-shard.ts` · `runs/playwright-e2e.ts` · `packages/review-agent/src/schemas.ts` · ADR-0009 · ADR-0010 · ADR-0011

## Context

- An execution's check-run concludes from the run's exit only:
  - success is `success`;
  - a typed failure is `failure`;
  - `RunSkipped` is `neutral`.
- A run has no structured way to tell the check-run what it found.
- `pr-review` posts its findings as a pull-request review comment and renders
  the first 25. The rest end with "see check annotations"
  (`runs/pr-review.ts:1157`, `:1213`), but no code writes a check annotation.
  Its check concludes `success` even when the verdict is `request-changes`.
- Test runs (`vitest-shard`, `playwright-e2e`, `offload-test`) report an exit
  code and a log. A failing test's name exists only inside the log.
  - `vitest-shard` cannot merge reports across shards: each shard runs in its
    own container.

## Decision

### The report

- A run's output may carry `report: CheckReport`, a Schema-typed value with
  two lists.
- `findings: Finding[]`, each with:
  - `path`, `startLine` and `endLine`;
  - `severity` (`critical`, `high`, `medium`, `low` or `info`);
  - `title` and `message`;
  - optional `ruleId`.
- `tests: TestCase[]`, each with:
  - `suite`, `file` and `name`;
  - `status` (`passed`, `failed`, `skipped`, `errored` or `flaky`);
  - `durationMs`, `retries`, and an optional `failureMessage`.
- A test case that failed and then passed on a retry, within one execution,
  is `flaky`.

### Rendering

The dispatcher, not the run, renders the report. The run supplies data, and
the dispatcher owns the title, the counts, the links and the layout.

- The title states the counts, for example `2 high · 5 medium · 412 passed ·
  3 failed · 1 flaky`.
- The summary lists failed and flaky test cases by file, then the findings by
  severity. GitHub's 65,535-character summary limit truncates it, and the
  overflow line links the execution's log page.
- Every finding and every failed, errored or flaky test case becomes a
  check-run annotation:

  | Report entry | Annotation level |
  | --- | --- |
  | `critical` or `high` finding; `failed` or `errored` test case | `failure` |
  | `medium` finding; `flaky` test case | `warning` |
  | `low` or `info` finding | `notice` |

  Annotations are sent in batches of 50, the Checks API's per-request
  maximum. The batches go through ADR-0009's budgeted delivery, so a large
  report spends from the same reserve.

### Conclusion

- A `failed` or `errored` test case concludes `failure`.
- A finding concludes `failure` only when its severity is at or above the
  run's `failOn`. `failOn` comes from `CONFIG_KV`
  `checks.failOn:<run>:<repo>`. Unset, it is `none`: findings annotate and
  never fail the check. This keeps `pr-review` advisory until a repository
  opts in.
- A typed run failure still concludes `failure`. `RunSkipped` still concludes
  `neutral`.

### Test results

- Test runs invoke their framework's JUnit XML reporter:
  - Vitest `--reporter=junit --outputFile`;
  - Playwright `--reporter=junit`;
  - pytest `--junitxml`;
  - cargo-nextest's JUnit profile.
- The core primitive `parseJunit` reads the file from the sandbox and returns
  `TestCase[]`.
- `vitest-shard`'s parent concatenates its children's `TestCase[]` into one
  report.
- D1 table `test_cases` stores one row per non-passed test case: execution
  id, file, name, status, duration, retries. Passed cases are counted, not
  stored, so a 5,000-test suite writes rows only for what failed. The
  dashboard lists them per execution.
- A check-run carries a `Re-run failed files` action when any test case
  failed. GitHub delivers it as a `check_run` `requested_action` event, which
  the App already subscribes to. The dispatcher re-dispatches the run with a
  `files` input that lists the failed files. A test run passes `files` to its
  framework's file filter.
- When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the dispatcher exports one span
  per test case with the OpenTelemetry test attributes `test.suite.name`,
  `test.case.name` and `test.case.result.status`. Unset, nothing is exported.

### `pr-review`

- `pr-review` returns its findings as a `CheckReport`.
- The pull-request comment keeps the first 25 findings, and its overflow line
  points at annotations that exist.

## Options considered

- **The run renders its own check-run text.** This is today's
  `AcceptanceFailed.summaryMd` path. It suits a narrative, but it leaves
  every run to build counts and links. It also lets model-written text decide
  the layout, as in `pr-review`.
- **Per-test spans only, exported to an operator-run tracing backend.** This
  sends the data where nobody reviewing the pull request looks, and it needs
  a backend in every deploy.
- **Typed report rendered by the dispatcher (chosen).** One renderer, one
  annotation path, one conclusion rule. It costs a Schema every run's output
  must meet, plus D1 rows for failures.

## Criteria

1. The reviewer sees which test or line failed on the pull request, without
   opening a log.
2. Model output never controls counts, links or the conclusion.
3. Write volume to GitHub and D1 stays bounded per execution.

Criterion 2 decided against run-rendered text. Criterion 1 decided against
spans only.

## Consequences

- A failing test shows on the changed line's annotation and in the check
  title.
- `pr-review` findings can gate a merge once a repository sets `failOn`.
- **Accepted cost:** a report with thousands of findings spends thousands of
  annotation writes. The dispatcher caps annotations at
  `CHECK_ANNOTATIONS_MAX`, 500 by default, and the summary states how many
  were omitted.

## Revisit triggers

- Annotation writes take more than a quarter of an installation's hourly
  quota in any hour.
- A framework without a JUnit reporter becomes a common test target.
