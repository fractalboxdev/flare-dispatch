// The synthetic webhook canary's admission (specs/operability.md § Liveness, FD-OPS-039): the push the `canary.push`
// ops intent makes to the canary branch of the fixture repository admits the `canary` run as an ops run of class
// `required`, through mameko's admission like every other request. No repository manifest lists the run.
import { CANARY_BRANCH, CANARY_CLASS, CANARY_RUN } from "@fractalboxdev/flare-dispatch-catalog";
import { Effect } from "effect";
import { IntakeConfig } from "./config.ts";
import type { WebhookEvent, WebhookFields } from "./event.ts";
import { shed, submission } from "./submit.ts";
import { nothing, submitEach } from "./triggers.ts";

/** The canary branch's ref. */
export const CANARY_REF = `refs/heads/${CANARY_BRANCH}`;

/** Whether a delivery is the canary webhook: a push to the canary branch of the fixture repository. */
export const isCanaryPush = (
  canaryRepo: string | undefined,
  event: WebhookEvent,
  fields: WebhookFields,
  repo: string,
): boolean =>
  event.event === "push" &&
  canaryRepo !== undefined &&
  canaryRepo !== "" &&
  repo.toLowerCase() === canaryRepo.toLowerCase() &&
  fields.ref === CANARY_REF;

/**
 * Admits the canary for the pushed commit: run `canary`, class `required`, an ops run (MAMEKO-SPD-065), with its check
 * `flare-dispatch/canary` on the commit. A redelivery answers the same execution. A deployment whose catalogue lacks the
 * run sheds the push.
 */
export const admitCanary = (fields: WebhookFields, repo: string, sha: string) =>
  Effect.gen(function* () {
    const run = (yield* IntakeConfig).catalog(CANARY_RUN);
    if (run === undefined) {
      yield* shed(repo, CANARY_RUN, "canary: run not in catalogue");
      return nothing;
    }
    return yield* submitEach([
      submission({
        run,
        trigger: "webhook",
        event: "push",
        repo,
        sha,
        ref: CANARY_REF,
        inputs: { repo, sha, ref: CANARY_REF },
        installation: fields.installation?.id ?? null,
        forcedClass: CANARY_CLASS,
        applyCooldown: false,
        opsRun: true,
      }),
    ]);
  });
