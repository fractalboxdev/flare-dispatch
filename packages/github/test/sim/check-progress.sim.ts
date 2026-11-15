// The `check.progress` intent as a V-SIM scenario (specs/github-output.md FD-GH-012, FD-GH-019). A seed fixes a set of
// waiting executions, each with whether it owns a check run, its labels, its class and `deadline_at`, and a stream of
// queue positions it passes through, plus which repositories are `confidential-compute` at each delivery. Every
// position goes through the profile's `checkProgressPayload` binding and, where that answers a payload, through the
// check-run applier to a fake GitHub. The scenario checks that a payload exists exactly for an execution that owns a
// check run and has a class and a `deadline_at`, that it carries the execution's class, `deadline_at` and the bucket
// its position falls in, and that the check run's output states the class, the bucket and the deadline except while
// the repository is `confidential-compute`, where it states the class and neither the bucket nor the deadline.
// `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts): each seed fails on any violation.
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { type Actuator, Actuators, type IntentRow } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import { CheckRunApplierLive } from "../../src/applier.ts";
import { checkProgressPayload, type CheckProgressRequest } from "../../src/bindings.ts";
import { fakeGithub, fakeLayers, row, type FakeGithub } from "../../src/fake.test-support.ts";

export const SCENARIO = "check-progress";

const OPEN_REPO = "acme/app";
const SECRET_REPO = "acme/secret";
const INSTALLATIONS = { [OPEN_REPO]: 7, [SECRET_REPO]: 8 };
const CLASSES = buildProfile("production").classes.map((c) => c.name);

/** The buckets FD-GH-012 names, each with the 1-based queue positions it covers. */
const BUCKETS = [
  { bucket: "1", from: 1, to: 1 },
  { bucket: "2–5", from: 2, to: 5 },
  { bucket: "6–20", from: 6, to: 20 },
  { bucket: "more than 20", from: 21, to: Number.POSITIVE_INFINITY },
] as const;
const bucketOf = (position: number) =>
  BUCKETS.find((b) => position >= b.from && position <= b.to)!.bucket;

/** Positions at and beside every bucket edge, which a seed draws from as often as from the whole range. */
const EDGES = [1, 2, 5, 6, 20, 21];

export interface ProgressOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
  readonly trace: readonly string[];
}

const withApplier = <A>(gh: FakeGithub, f: (a: Required<Actuator>) => Effect.Effect<A>) =>
  Effect.runPromise(
    Actuators.use((registry) => f(registry.get("checkRun") as Required<Actuator>)).pipe(
      Effect.provide(CheckRunApplierLive.pipe(Layer.provide(fakeLayers(gh, INSTALLATIONS)))),
    ),
  );
const apply = (gh: FakeGithub, r: IntentRow) => withApplier(gh, (a) => a.apply(r));

export const simulateProgress = async (seed: number): Promise<ProgressOutcome> => {
  const random = seededRandom(seed);
  const int = (n: number) => Math.floor(random() * n);
  const pick = <A>(xs: readonly A[]): A => xs[int(xs.length)]!;
  const violations: SimViolation[] = [];
  const reached: Record<string, number> = {};
  const trace: string[] = [];
  const reach = (k: string) => (reached[k] = (reached[k] ?? 0) + 1);
  const v = (message: string) => violations.push({ id: "FD-GH-012", message });
  const gh = fakeGithub();

  // The waiting executions, each with the queue positions it passes through, highest first.
  const executions = Array.from({ length: 2 + int(5) }, (_, i) => {
    const request: CheckProgressRequest = {
      check:
        random() < 0.9
          ? {
              name: `flare-dispatch/check:job-${i}`,
              headSha: "c".repeat(40),
              ...(random() < 0.5 ? { detailsUrl: `https://logs.example/${seed}/${i}` } : {}),
            }
          : null,
      labels: random() < 0.1 ? ["local-only"] : [],
      execution: {
        class: random() < 0.05 ? null : pick(CLASSES),
        deadlineAt: random() < 0.05 ? null : Date.UTC(2026, 10, 15) + int(86_400_000),
      },
      queuePosition: 0,
    };
    const positions = Array.from({ length: 1 + int(5) }, () =>
      random() < 0.5 ? pick(EDGES) : 1 + int(200),
    ).sort((a, b) => b - a);
    return {
      id: `exec-${seed}-${i}`,
      repo: random() < 0.5 ? OPEN_REPO : SECRET_REPO,
      request,
      positions,
    };
  });

  // Every execution that owns a check run opens it, as `check.open` does before any progress.
  for (const e of executions)
    if (e.request.check !== null && !e.request.labels.includes("local-only"))
      await apply(
        gh,
        row(
          "check.open",
          { name: e.request.check.name, head_sha: e.request.check.headSha },
          { executionId: e.id, scopeId: e.repo },
        ),
      );

  // The deliveries interleave across executions; each keeps its own order.
  const queue = executions.flatMap((e) => e.positions.map((position) => ({ e, position })));
  const order: typeof queue = [];
  const cursors = new Map(executions.map((e) => [e.id, 0]));
  while (order.length < queue.length) {
    const open = executions.filter((e) => cursors.get(e.id)! < e.positions.length);
    const e = pick(open);
    const i = cursors.get(e.id)!;
    order.push({ e, position: e.positions[i]! });
    cursors.set(e.id, i + 1);
  }

  for (const { e, position } of order) {
    // The repository's confidentiality mode can change between deliveries; the applier reads it at each one.
    if (random() < 0.5) gh.confidential.add(SECRET_REPO);
    else gh.confidential.delete(SECRET_REPO);
    const confidential = gh.confidential.has(e.repo);
    const payload = checkProgressPayload({ ...e.request, queuePosition: position });
    const owed =
      e.request.check !== null &&
      !e.request.labels.includes("local-only") &&
      e.request.execution.class !== null &&
      e.request.execution.deadlineAt !== null;
    trace.push(`${e.id} @${position}${confidential ? " confidential" : ""}: ${payload?.bucket}`);
    if (payload === null) {
      if (owed) v(`${e.id} at position ${position} got no payload`);
      else reach("no-payload");
      continue;
    }
    if (!owed) {
      v(
        `${e.id} owns no check run or has no class or deadline_at, and got ${JSON.stringify(payload)}`,
      );
      continue;
    }
    const expected = bucketOf(position);
    if (payload.bucket !== expected)
      v(`${e.id} at position ${position} got bucket ${payload.bucket}, not ${expected}`);
    if (payload.class !== e.request.execution.class)
      v(`${e.id} payload class ${payload.class}, execution class ${e.request.execution.class}`);
    if (payload.deadline_at !== e.request.execution.deadlineAt)
      v(`${e.id} payload deadline_at ${payload.deadline_at}`);

    const answer = await apply(
      gh,
      row("check.progress", payload, { executionId: e.id, scopeId: e.repo }),
    );
    if (answer._tag !== "applied") {
      v(`${e.id} check.progress answered ${JSON.stringify(answer)}`);
      continue;
    }
    const run = gh.runs.find((r) => r.external_id === e.id);
    const title = run?.output.title ?? "";
    const summary = run?.output.summary ?? "";
    const deadline = new Date(e.request.execution.deadlineAt!).toISOString();
    if (!summary.includes(`Class \`${payload.class}\``))
      v(`${e.id} check run summary ${JSON.stringify(summary)} does not state the class`);
    if (confidential) {
      reach("confidential");
      if (`${title} ${summary}`.includes("position") || summary.includes(deadline))
        v(
          `${e.id} is confidential-compute and its check run states ${JSON.stringify({ title, summary })}`,
        );
    } else {
      reach(`bucket ${expected}`);
      if (title !== `Queued: position ${expected}`)
        v(`${e.id} at position ${position} titled ${JSON.stringify(title)}, bucket ${expected}`);
      if (!summary.includes(`queue position ${expected};`) || !summary.includes(deadline))
        v(`${e.id} summary ${JSON.stringify(summary)} lacks bucket ${expected} or ${deadline}`);
    }
  }
  return { violations, reached, trace };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: SCENARIO,
    ids: ["FD-GH-012"],
    run: async (seed) => throwOnViolations((await simulateProgress(seed)).violations),
  },
];
