// FlareDispatch Dispatcher — resolve a release-PR approval from a webhook.
//
// The `release-notes` run opens a PR carrying the rendered notes plus a hidden
// marker that pins the run's own Workflow instance id:
//
//   <!-- flare-dispatch:release-approval wf=<instanceId> tag=<tag> -->
//
// A human APPROVES by merging the PR (or adding the `release:approve` label) and
// REJECTS by closing it unmerged (or the `release:reject` label). The webhook
// HMAC proves GitHub sent the event; GitHub's own repo permissions govern who
// may merge/label — so this surface needs NO shared `ADMIN_TOKEN`, and the
// decider is a real GitHub identity, not a self-asserted field.
//
// Pure + total: given the event name + payload it returns the resolved decision
// or `undefined` (not a release-approval signal). webhook.ts does the I/O.

/** The hidden marker the run embeds in the release-PR body. */
export const RELEASE_APPROVAL_MARKER =
  /<!--\s*flare-dispatch:release-approval\s+wf=(\S+)\s+tag=(\S+)\s*-->/;

/** Opt-in labels for the label-driven approval path (alternative to merge). */
export const APPROVE_LABEL = "release:approve";
export const REJECT_LABEL = "release:reject";

export type ReleaseApproval = {
  readonly wfId: string;
  readonly tag: string;
  readonly decision: "approve" | "reject";
  /** The GitHub login that merged/closed/labeled — the audit identity. */
  readonly decider: string;
};

type PullRequestEvent = {
  readonly action?: unknown;
  readonly label?: { readonly name?: unknown };
  readonly sender?: { readonly login?: unknown };
  readonly pull_request?: {
    readonly body?: unknown;
    readonly merged?: unknown;
    readonly user?: { readonly type?: unknown };
  };
};

/**
 * Resolve a release-approval signal from a `pull_request` webhook, or
 * `undefined` when the event is not a bot-authored release PR being
 * merged/closed/labeled. Acting only on `pull_request.user.type === "Bot"` is
 * defense-in-depth: the marker pins the instance, but we still require the PR to
 * be one WE opened.
 */
export const resolveReleaseApproval = (
  event: string | null,
  payload: unknown,
): ReleaseApproval | undefined => {
  if (event !== "pull_request") return undefined;
  const p = payload as PullRequestEvent;
  const pr = p.pull_request;
  if (pr === undefined) return undefined;
  if (pr.user?.type !== "Bot") return undefined;

  const body = typeof pr.body === "string" ? pr.body : "";
  const m = RELEASE_APPROVAL_MARKER.exec(body);
  if (m === null) return undefined;
  const wfId = m[1]!;
  const tag = m[2]!;
  const decider = typeof p.sender?.login === "string" ? p.sender.login : "unknown";

  if (p.action === "closed") {
    return {
      wfId,
      tag,
      decision: pr.merged === true ? "approve" : "reject",
      decider,
    };
  }
  if (p.action === "labeled") {
    const label = typeof p.label?.name === "string" ? p.label.name : "";
    if (label === APPROVE_LABEL) return { wfId, tag, decision: "approve", decider };
    if (label === REJECT_LABEL) return { wfId, tag, decision: "reject", decider };
  }
  return undefined;
};
