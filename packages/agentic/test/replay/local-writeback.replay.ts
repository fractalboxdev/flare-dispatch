// A local execution's writeback as a `V-REPLAY` workflow (specs/local-scheduler.md FD-LOCAL-055). One run registers two
// local executions under one capacity lease, records their `success` verdicts, and runs the same steps in each: a
// `pr.propose`, two reviews and a check summary, every append through FlareDispatch's local run context. Each
// `local.writeback` request reaches the control plane's writeback receipt, gate and outbox over one D1 database
// (local-plane.test-support.ts). A second run reruns every step over the same control plane, as a device that lost its
// step results runs them again under the same execution ids.
import { Effect } from "effect";
import type { ReplayEffect, ReplayWorkflow } from "../../../ops/src/verification/harness.ts";
import { appendIntent, type LocalRunContext } from "../../src/local/run-context.ts";
import {
  localPlane,
  MANIFEST,
  registrationPayload,
  type LocalPlane,
} from "../local-plane.test-support.ts";

/** The steps each execution runs: every append's kind and payload, in order. */
export const STEPS: readonly {
  readonly step: string;
  readonly appends: readonly { readonly kind: string; readonly payload: unknown }[];
}[] = [
  { step: "propose", appends: [{ kind: "pr.propose", payload: { manifest: MANIFEST } }] },
  {
    step: "review",
    appends: [
      { kind: "review", payload: { body: "Spec drift in a.md." } },
      { kind: "review", payload: { body: "Spec drift in b.md." } },
    ],
  },
  { step: "report", appends: [{ kind: "check.summary", payload: { markdown: "2 files" } }] },
];

/** The control plane and the registered execution ids: what a rerun step finds in place. */
export interface Journal {
  readonly plane: LocalPlane;
  readonly executions: readonly string[];
}

export interface LocalRun {
  readonly journal: Journal;
  readonly effects: readonly ReplayEffect[];
  readonly acks: readonly string[];
}

/** Registers two executions and records their verdicts; the registration's result is the journal's. */
const start = async (): Promise<Journal> => {
  const plane = await localPlane();
  const executions: string[] = [];
  for (const key of ["rk-a", "rk-b"]) {
    const answer = await plane.register(
      true,
      registrationPayload(key, { reuse: false, writeback: true }),
    );
    if (!("execution_id" in answer)) throw new Error(`registration ${key} rejected`);
    executions.push(answer.execution_id);
    await plane.conclude(answer.execution_id, "success");
  }
  return { plane, executions };
};

/** Runs every step of both executions; from no journal it registers them first. */
export const lifecycle = async (journal: Journal | null): Promise<LocalRun> => {
  const j = journal ?? (await start());
  const { plane } = j;
  const fromEffect = plane.effects.length;
  const fromCall = plane.repo.calls.length;
  const acks: string[] = [];
  for (const executionId of j.executions) {
    const ctx: LocalRunContext = {
      executionId,
      registered: true,
      journal: () => {},
      send: (request) =>
        Effect.promise(() => plane.receive(request)).pipe(
          Effect.map((ack) => void acks.push(ack.status)),
        ),
      scheduler: { offline: () => false, grantRejected: () => false },
    };
    for (const { step, appends } of STEPS)
      for (const [index, a] of appends.entries())
        await Effect.runPromise(appendIntent(ctx, step, index, a.kind, a.payload));
  }
  return {
    journal: j,
    effects: [...plane.effects.slice(fromEffect), ...plane.githubFrom(fromCall)],
    acks,
  };
};

export const workflows: readonly ReplayWorkflow<Journal>[] = [
  {
    name: "local-writeback",
    ids: ["FD-LOCAL-055"],
    run: lifecycle,
  },
];
