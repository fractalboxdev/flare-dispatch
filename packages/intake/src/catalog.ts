// The run catalogue as intake reads it, built from FlareDispatch's catalogue
// package. `check` answers `pull_request`, `push` and `merge_group` webhooks with
// the steps its manifest entry names, and dispatches with their own inputs.
import { CheckStep, lookupRun, requestPlacement } from "@fractalboxdev/flare-dispatch-catalog";
import type { Deployment } from "@fractalboxdev/flare-dispatch-profile";
import { Match, Option, Schema } from "effect";
import { commitOf, WebhookFields, type DispatchEvent } from "./event.ts";
import type { EntryView, IntakeRun, RunCatalog } from "./runs.ts";

export const CheckParams = Schema.Struct({
  steps: Schema.Array(CheckStep).check(Schema.isMinLength(1)),
});

const CHECK_EVENTS: ReadonlySet<string> = new Set(["pull_request", "push", "merge_group"]);
const PR_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

/** `check`'s request decoder: a commit-bearing webhook and the entry's steps make its input. */
export const checkTrigger = (event: DispatchEvent, entry: EntryView): Option.Option<unknown> =>
  Match.value(event).pipe(
    Match.tag("webhook", (w) => {
      if (!CHECK_EVENTS.has(w.event)) return Option.none();
      if (w.event === "pull_request" && (w.action === null || !PR_ACTIONS.has(w.action)))
        return Option.none();
      if (w.event === "merge_group" && w.action !== "checks_requested") return Option.none();
      const fields = Schema.decodeUnknownOption(WebhookFields)(w.payload);
      const params = Schema.decodeUnknownOption(CheckParams)(entry.params);
      return Option.flatMap(Option.all({ fields, params }), ({ fields: f, params: p }) =>
        Option.map(commitOf(f), (sha) => ({
          repo: `https://github.com/${f.repository?.full_name ?? ""}.git`,
          sha,
          ref:
            f.pull_request?.head.ref !== undefined
              ? `refs/heads/${f.pull_request.head.ref}`
              : (f.ref ?? f.merge_group?.base_ref ?? ""),
          steps: p.steps,
        })),
      );
    }),
    Match.orElse(() => Option.none()),
  );

/** The deployment's runs; a run the deployment refuses to execute is not in its catalogue. */
export const catalogRuns =
  (deployment: Deployment): RunCatalog =>
  (name) =>
    Match.value(lookupRun(deployment, name)).pipe(
      Match.tag("Available", ({ entry }): IntakeRun | undefined => ({
        name: entry.spec.name,
        params: CheckParams,
        input: entry.input,
        trigger: checkTrigger,
        defaultClass: entry.spec.limits.qosClass,
        qosCeiling: entry.spec.limits.qosCeiling,
        hostedModelCalls: entry.spec.needsModel,
        maxDurationSec: entry.spec.limits.maxDurationSec,
        ownsCheck: true,
        gating: true,
        retries: entry.spec.retries,
        grants: { setup: [...entry.spec.grants.setup], agent: [...entry.spec.grants.agent] },
        placement: (inputs) => requestPlacement(entry.spec, inputs),
      })),
      Match.orElse(() => undefined),
    );
