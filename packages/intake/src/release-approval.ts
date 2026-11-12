// A merge, a close or a label on a release pull request that a `release-notes` execution opened, and whether it starts
// that release's publish execution (specs/intake.md § Release approval, specs/runs/agentic.md § `release-notes`).
import { canWrite, GithubRead } from "@fractalboxdev/flare-dispatch-github";
import {
  parseReleaseNotesMarker,
  ReleaseNotesInput,
  type ReleasePublishInput,
} from "@fractalboxdev/flare-dispatch-agentic";
import { Clock, Effect, Match, Result, Schema } from "effect";
import { IntakeConfig } from "./config.ts";
import { repositoryPublicOf, type WebhookFields } from "./event.ts";
import { IntakeStore } from "./store.ts";
import { submission } from "./submit.ts";
import { nothing, submitEach, type TriggerOutcome } from "./triggers.ts";

/** The run whose execution opens a release pull request and whose publish execution an approval starts. */
export const RELEASE_RUN = "release-notes";
export const RELEASE_APPROVE_LABEL = "release:approve";
export const RELEASE_REJECT_LABEL = "release:reject";
/** The approval window from the release pull request's creation (FD-AGT-085, FD-AGT-087). */
export const RELEASE_APPROVAL_WINDOW_MS = 72 * 60 * 60 * 1000;

type Marker = NonNullable<ReturnType<typeof parseReleaseNotesMarker>>;

/** What one `pull_request` event says about a release. */
export type ReleaseSignal =
  /** Not a release pull request's merge, close or label: the release path ignores it. */
  | { readonly _tag: "NotRelease" }
  /** A release pull request's event that neither approves nor rejects, such as another label. */
  | { readonly _tag: "Unrelated" }
  | {
      readonly _tag: "Approve";
      readonly via: "merge" | "label";
      readonly number: number;
      readonly marker: Marker;
      /** The commit the release's tag points at: the merge commit, or the head the marker names for a label. */
      readonly commit: string;
      /** The release pull request's head, whose notes file the release carries. */
      readonly notesCommit: string;
      /** When the approval happened, epoch ms; null when the payload does not say. */
      readonly at: number | null;
      /** When the release pull request was created, epoch ms; null when the payload does not say. */
      readonly createdAt: number | null;
      /** Who applied the label; null for a merge, which only a principal with write permission can make. */
      readonly principal: string | null;
    }
  | {
      readonly _tag: "Reject";
      readonly via: "close" | "label";
      readonly number: number;
      readonly principal: string | null;
    };

const SHA = /^[0-9a-f]{40}$/;

const timeOf = (value: string | null | undefined): number | null => {
  const parsed = value === null || value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The release signal of a `pull_request` event (FD-INT-066). Only a pull request the App's bot authored whose body
 * ends with the `release-notes` marker is a release pull request; every other event is `NotRelease`. A merge approves
 * at the merge commit; a close unmerged rejects; `release:approve` on an open pull request approves at the head the
 * marker names; `release:reject` rejects. A label on a closed pull request changes nothing: its close already decided.
 */
export const releaseSignalOf = (
  action: string | null,
  fields: WebhookFields,
  appLogin: string | undefined,
): ReleaseSignal => {
  const pr = fields.pull_request;
  if (appLogin === undefined || pr === undefined || (action !== "closed" && action !== "labeled"))
    return { _tag: "NotRelease" };
  if (pr.user?.login !== appLogin || pr.user.type !== "Bot") return { _tag: "NotRelease" };
  const marker = parseReleaseNotesMarker(pr.body ?? null);
  if (marker === null) return { _tag: "NotRelease" };
  const notesCommit = pr.head.sha;
  const sender = fields.sender?.login ?? null;
  const approve = (via: "merge" | "label", commit: string | null | undefined, at: number | null) =>
    commit === null || commit === undefined || !SHA.test(commit) || notesCommit === undefined
      ? ({ _tag: "Unrelated" } as const)
      : ({
          _tag: "Approve",
          via,
          number: pr.number,
          marker,
          commit,
          notesCommit,
          at,
          createdAt: timeOf(pr.created_at),
          principal: via === "merge" ? null : sender,
        } as const);
  if (action === "closed")
    return pr.merged === true
      ? approve("merge", pr.merge_commit_sha, timeOf(pr.merged_at))
      : { _tag: "Reject", via: "close", number: pr.number, principal: sender };
  if (pr.state === "closed") return { _tag: "Unrelated" };
  const label = fields.label?.name;
  if (label === RELEASE_APPROVE_LABEL) return approve("label", marker.head, timeOf(pr.updated_at));
  if (label === RELEASE_REJECT_LABEL)
    return { _tag: "Reject", via: "label", number: pr.number, principal: sender };
  return { _tag: "Unrelated" };
};

/** Whether the principal has write permission on the repository; an event without one has none. */
const writer = (repo: string, principal: string | null) =>
  Effect.gen(function* () {
    if (principal === null) return false;
    return canWrite(yield* (yield* GithubRead).permission(repo, principal));
  });

/** Whether an approval arrived within the window from the pull request's creation; an unknown creation time has none. */
export const withinApprovalWindow = (createdAt: number | null, at: number) =>
  createdAt !== null && at - createdAt <= RELEASE_APPROVAL_WINDOW_MS;

const skip = (reason: string, repo: string, number: number) =>
  Effect.as(
    Effect.logInfo("release approval starts no publish", { repo, number, reason }),
    nothing as TriggerOutcome,
  );

/**
 * A release pull request's event through FD-AGT-085 to FD-AGT-087 (FD-INT-066). A rejection by a principal with write
 * permission is recorded, so no later approval of that pull request publishes. An approval starts one `release-notes`
 * publish execution when a principal with write permission made it within the approval window and no rejection was
 * recorded; its dedup key names the pull request, so redeliveries, a label and a merge reach that one execution.
 */
export const releaseApproval = (action: string | null, fields: WebhookFields, repo: string) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const store = yield* IntakeStore;
    const signal = releaseSignalOf(action, fields, config.appLogin);
    return yield* Match.value(signal).pipe(
      Match.tag("NotRelease", "Unrelated", () => Effect.succeed(nothing)),
      Match.tag("Reject", (r) =>
        Effect.gen(function* () {
          if (!(yield* writer(repo, r.principal)))
            return yield* skip(`${r.via} by a principal without write permission`, repo, r.number);
          yield* store.rejectRelease(repo, r.number, yield* Clock.currentTimeMillis);
          return yield* skip(`rejected by ${r.via}`, repo, r.number);
        }),
      ),
      Match.tag("Approve", (a) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (!withinApprovalWindow(a.createdAt, a.at ?? now))
            return yield* skip(`${a.via} after the approval window`, repo, a.number);
          if (yield* store.releaseRejected(repo, a.number))
            return yield* skip("the pull request was rejected", repo, a.number);
          if (a.via === "label" && !(yield* writer(repo, a.principal)))
            return yield* skip("label by a principal without write permission", repo, a.number);
          return yield* startPublish(fields, repo, a);
        }),
      ),
      Match.exhaustive,
    );
  });

const startPublish = (
  fields: WebhookFields,
  repo: string,
  a: Extract<ReleaseSignal, { readonly _tag: "Approve" }>,
) =>
  Effect.gen(function* () {
    const config = yield* IntakeConfig;
    const run = config.catalog(RELEASE_RUN);
    if (run === undefined || !config.allows(repo, RELEASE_RUN))
      return yield* skip("the deployment serves no release-notes run here", repo, a.number);
    const [owner = "", name = ""] = repo.split("/");
    const baseBranch = fields.pull_request?.base.ref ?? "";
    const publish: ReleasePublishInput = {
      version: a.marker.version,
      commit: a.commit,
      notesCommit: a.notesCommit,
      pullRequest: a.number,
    };
    const inputs = Schema.decodeUnknownResult(ReleaseNotesInput)({
      repo: { owner, name },
      baseBranch,
      publish,
    });
    if (Result.isFailure(inputs))
      return yield* skip(`inputs: ${inputs.failure.message}`, repo, a.number);
    return yield* submitEach([
      submission({
        run,
        trigger: "webhook",
        event: "pull_request",
        repo,
        sha: a.commit,
        ref: `refs/heads/${baseBranch}`,
        inputs: inputs.success,
        installation: fields.installation?.id ?? null,
        defaultBranch: baseBranch,
        repositoryPublic: repositoryPublicOf(fields),
        // The publish reads the notes the proposing execution wrote, not the pull request author's text.
        inputAssociations: [],
        release: { pullRequest: a.number },
      }),
    ]);
  });
