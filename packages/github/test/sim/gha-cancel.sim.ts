// The `gha` launcher's cancels as a V-SIM scenario (specs/executors.md FD-EXEC-092). A seed fixes a fleet of executions
// and a stream of batches on the launcher port, each batch's operations sent at once to several isolates' launchers on
// one SQLite D1: starts that re-dispatch an execution at its next epoch (some refused by GitHub), and cancels of the
// current epoch, of an earlier epoch after a re-dispatch, of an epoch that never launched, and of one already
// cancelled. The scenario checks that the cancels of a batch reach exactly the workflow runs GitHub answered for the
// (execution, epoch) each names, through the Actions API's cancel endpoint, and never another epoch's run.
// `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts): each seed fails on any violation.
// The control plane's coordinator does not call `cancel` yet (mameko MAMEKO-HOST-047), so the scenario drives the
// launcher port directly.
import type { Launcher } from "@fractalboxdev/mameko-ports";
import type { Layer } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import {
  fakeActionsApi,
  INSTALLATION_TOKEN,
  launcherHarness,
  RUNNER_CONFIG,
  type FakeActionsApi,
} from "../../src/gha.test-support.ts";

const ISOLATES = 3;
const MINUTE = 60_000;
const CANCEL_URL = new RegExp(
  `^https://api\\.github\\.com/repos/${RUNNER_CONFIG.runnerRepo}/actions/runs/(\\d+)/cancel$`,
);

export interface CancelOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

const keyOf = (executionId: string, epoch: number | string) => `${executionId}#${epoch}`;

/** One cancel request the Actions API received: the run its path names, and whether it came as the launcher must send it. */
interface CancelSeen {
  readonly runId: number | undefined;
  readonly url: string;
  readonly wellFormed: boolean;
}

/**
 * The Actions API with dispatches of chosen (execution, epoch) keys refused, recording the run GitHub answered for each
 * dispatched key and every cancel request it receives.
 */
const observedApi = (refused: ReadonlySet<string>) => {
  const base = fakeActionsApi();
  const dispatched = new Map<string, number>();
  const cancels: CancelSeen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/dispatches")) {
      const { inputs } = JSON.parse(String(init?.body)) as {
        readonly inputs: { readonly execution_id: string; readonly epoch: string };
      };
      const key = keyOf(inputs.execution_id, inputs.epoch);
      if (refused.has(key)) return Response.json({ message: "refused" }, { status: 422 });
      const answer = await base.fetch(input, init);
      const { workflow_run_id } = (await answer.clone().json()) as {
        readonly workflow_run_id: number;
      };
      dispatched.set(key, workflow_run_id);
      return answer;
    }
    if (url.endsWith("/cancel")) {
      const match = CANCEL_URL.exec(url);
      cancels.push({
        runId: match === null ? undefined : Number(match[1]),
        url,
        wellFormed:
          init?.method === "POST" &&
          new Headers(init.headers).get("authorization") === `Bearer ${INSTALLATION_TOKEN}`,
      });
    }
    return base.fetch(input, init);
  };
  const api: FakeActionsApi = { ...base, fetch };
  return { api, dispatched, cancels };
};

interface Op {
  readonly kind: "start" | "cancel";
  readonly executionId: string;
  readonly epoch: number;
  readonly isolate: number;
}

export const simulateCancels = async (seed: number): Promise<CancelOutcome> => {
  const random = seededRandom(seed);
  const below = (n: number) => Math.floor(random() * n);
  const refused = new Set<string>();
  const { api, dispatched, cancels } = observedApi(refused);
  const h = await launcherHarness({ api });
  const isolates: Layer.Layer<Launcher>[] = Array.from({ length: ISOLATES }, () => h.launcher());
  const violations: SimViolation[] = [];
  const reached: Record<string, number> = {};
  const trace: string[] = [];
  const reach = (k: string) => (reached[k] = (reached[k] ?? 0) + 1);

  const executions = Array.from({ length: 2 + below(4) }, (_, e) => `exec-${seed}-${e}`);
  // The highest epoch each execution was started at, the isolate that started each key, and every key cancelled.
  const epochOf = new Map<string, number>(executions.map((x) => [x, 0]));
  const startedOn = new Map<string, number>();
  const cancelled = new Set<string>();

  const batches = 10 + below(20);
  for (let b = 0; b < batches; b++) {
    const size = random() < 0.4 ? 2 + below(3) : 1;
    const ops: Op[] = [];
    // The executions a start of this batch re-dispatches, and those a cancel of it names at the next epoch: the two
    // never meet, as a cancel of a launch still being dispatched has no run to name.
    const startedInBatch = new Set<string>();
    const nextCancelled = new Set<string>();
    for (let i = 0; i < size; i++) {
      const executionId = executions[below(executions.length)]!;
      const current = epochOf.get(executionId)!;
      if (
        (current === 0 || random() < 0.4) &&
        !startedInBatch.has(executionId) &&
        !nextCancelled.has(executionId)
      ) {
        startedInBatch.add(executionId);
        const epoch = current + 1;
        if (random() < 0.15) refused.add(keyOf(executionId, epoch));
        ops.push({ kind: "start", executionId, epoch, isolate: below(ISOLATES) });
        continue;
      }
      // The current epoch most often, else an earlier one, else one past the current that never launched. A cancel
      // never names the key a start of the same batch launches.
      const draw = random();
      const epoch =
        draw < 0.5 || current < 2
          ? current
          : draw < 0.8
            ? 1 + below(current - 1)
            : current + 1 + below(2);
      const key = keyOf(executionId, epoch);
      if (epoch === 0 || (startedInBatch.has(executionId) && epoch === current + 1)) continue;
      if (epoch === current + 1) nextCancelled.add(executionId);
      ops.push({ kind: "cancel", executionId, epoch, isolate: below(ISOLATES) });
      if (startedInBatch.has(executionId)) reach("cancel-beside-redispatch");
      if (cancelled.has(key)) reach("cancel-repeated");
      if (startedOn.has(key) && startedOn.get(key) !== ops.at(-1)!.isolate)
        reach("cancel-other-isolate");
    }
    if (ops.length === 0) continue;

    const before = cancels.length;
    await Promise.all(
      ops.map((op) =>
        op.kind === "start"
          ? h.start(
              {
                executionId: op.executionId,
                epoch: op.epoch,
                scopeId: "scope",
                deadlineAt: Date.now() + 30 * MINUTE,
              },
              isolates[op.isolate],
            )
          : h.cancel(op.executionId, op.epoch, isolates[op.isolate]),
      ),
    );
    const seen = cancels.slice(before);

    // Every cancel of a launched key reaches that key's run once; a cancel of a key with no run sends nothing.
    const expected: number[] = [];
    for (const op of ops) {
      const key = keyOf(op.executionId, op.epoch);
      if (op.kind === "start") {
        startedOn.set(key, op.isolate);
        epochOf.set(op.executionId, op.epoch);
        continue;
      }
      cancelled.add(key);
      const runId = dispatched.get(key);
      if (runId !== undefined) {
        expected.push(runId);
        reach(op.epoch < epochOf.get(op.executionId)! ? "cancel-stale-epoch" : "cancel-current");
      } else reach(refused.has(key) ? "cancel-refused-launch" : "cancel-unlaunched");
    }
    const got = seen.map((c) => c.runId ?? -1);
    const sorted = (xs: readonly number[]) => [...xs].sort((x, y) => x - y).join(",");
    trace.push(
      `${b}: ${ops.map((o) => `${o.kind} ${keyOf(o.executionId, o.epoch)}@${o.isolate}`).join(" | ")} -> [${sorted(got)}]`,
    );
    if (sorted(got) !== sorted(expected))
      violations.push({
        id: "FD-EXEC-092",
        message: `batch ${b} cancelled runs [${sorted(got)}], the (execution, epoch) keys it cancelled recorded [${sorted(expected)}]`,
      });
    for (const c of seen)
      if (c.runId === undefined || !c.wellFormed)
        violations.push({
          id: "FD-EXEC-092",
          message: `batch ${b} sent a cancel that is not an authenticated POST to the runner repository's run: ${c.url}`,
        });
  }
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: "gha-cancel",
    ids: ["FD-EXEC-092"],
    run: async (seed) => throwOnViolations((await simulateCancels(seed)).violations),
  },
];
