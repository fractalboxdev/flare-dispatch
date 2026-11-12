// The `Execution` workflow's GitHub and side outputs run twice over one journal (github.replay.ts): the second run makes
// no GitHub call, D1 write, intent or delivery the first did not.
import { describe, expect, it } from "vitest";
import { runReplays } from "../../../ops/src/verification/harness.ts";
import {
  checkName,
  CONCLUDED_FIRST,
  lifecycle,
  OPENED,
  SCOPE,
  workflows,
  type Plane,
} from "./github.replay.ts";

/**
 * Runs the workflow twice over one journal and answers the extra effects, every effect of the second run, and the
 * journal, left open.
 */
const replayed = async () => {
  const runs: Awaited<ReturnType<typeof lifecycle>>[] = [];
  const extras = await runReplays([
    {
      ...workflows[0]!,
      run: async (journal) => {
        const out = await lifecycle(journal as Plane | null);
        runs.push(out);
        return out;
      },
    },
  ]);
  return { extras, second: runs[1]!.effects, p: runs[0]!.journal };
};

describe("an execution's GitHub and side outputs under a replayed workflow", () => {
  it("[FD-GH-009] the check runs check.open and an outcome-first check.conclude create carry their execution id as external_id, and the replay creates none", async () => {
    const { extras, second, p } = await replayed();
    try {
      expect(extras).toEqual([]);
      expect(second).toEqual([]);
      expect(p.gh.calls.filter((c) => c === "create")).toHaveLength(2);
      expect(
        p.gh.runs.map((r) => ({ name: r.name, external_id: r.external_id, status: r.status })),
      ).toEqual([
        { name: checkName(OPENED), external_id: OPENED, status: "completed" },
        { name: checkName(CONCLUDED_FIRST), external_id: CONCLUDED_FIRST, status: "completed" },
      ]);
      // The outcome-first execution's check.open adopts the run its conclusion created.
      expect(
        p.rows(
          "select execution_id, intent_key, state, external_ref from outbox where kind like 'check.%' order by execution_id, intent_key",
        ),
      ).toEqual([
        {
          execution_id: OPENED,
          intent_key: "cp:check:open",
          state: "applied",
          external_ref: "1000",
        },
        { execution_id: OPENED, intent_key: "outcome", state: "applied", external_ref: "1000" },
        {
          execution_id: CONCLUDED_FIRST,
          intent_key: "cp:check:open",
          state: "applied",
          external_ref: "1001",
        },
        {
          execution_id: CONCLUDED_FIRST,
          intent_key: "outcome",
          state: "applied",
          external_ref: "1001",
        },
      ]);
    } finally {
      await p.dispose();
    }
  });

  it("[FD-GH-078] the email, Slack post and notice each go out once, only while the drainer applies their outbox row, and the replay sends none", async () => {
    const { extras, second, p } = await replayed();
    try {
      expect(extras).toEqual([]);
      expect(second).toEqual([]);
      // Staging the run's batch and the terminal write send nothing; each delivery happens in a drain, once, under the
      // identity of its row.
      expect(p.sent).toEqual([
        {
          step: "drain",
          to: "email",
          ref: `<${OPENED}.run.notify.0@flare-dispatch>`,
        },
        { step: "drain", to: "slack", ref: `${OPENED}/run:notify:1` },
        { step: "drain", to: "notice", ref: `run-0:verdict:${"b".repeat(40)}` },
      ]);
      expect(
        p.rows(
          "select intent_key, kind, scope_id, state, sends, external_ref from outbox where kind not like 'check.%' order by intent_key",
        ),
      ).toEqual([
        {
          intent_key: "run:notify:0",
          kind: "notify.email",
          scope_id: SCOPE,
          state: "applied",
          sends: 1,
          external_ref: `<${OPENED}.run.notify.0@flare-dispatch>`,
        },
        {
          intent_key: "run:notify:1",
          kind: "notify.slack",
          scope_id: SCOPE,
          state: "applied",
          sends: 1,
          external_ref: expect.stringMatching(/^slack:\d+$/),
        },
        {
          intent_key: "run:notify:2",
          kind: "notice.publish",
          scope_id: SCOPE,
          state: "applied",
          sends: 1,
          external_ref: `run-0:verdict:${"b".repeat(40)}`,
        },
      ]);
    } finally {
      await p.dispose();
    }
  });
});
