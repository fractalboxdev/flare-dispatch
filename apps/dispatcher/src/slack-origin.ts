// FlareDispatch Dispatcher — the slack-origin dispatch policy.
//
// A conversational Slack agent sits in front of this dispatcher. Its ingress
// classifies inbound Slack events by event class — never by message content —
// and re-dispatches the batch-shaped ones here over the HMAC dispatch route,
// carrying the Slack origin context. Conversational events (mentions, DMs,
// thread replies) never reach us; batch shapes never get answered there. This
// module is the DISPATCHER's half of that contract.
//
// --- Why the dispatcher enforces, not the caller -----------------------------
//
// The caller could hard-code `secrets: []`, keep to a run allowlist, and pin
// the repo — and the upstream spec says it does. That is a convention, and a
// convention is one refactor away from not being true. Everything below is
// re-decided HERE, on the dispatcher, against the deploy's own config, so the
// controls hold no matter what the caller sends:
//
//   1. `secrets: []` — a slack-origin dispatch naming ANY secret is refused,
//      and the inputs handed to the Workflow are normalized to `secrets: []`
//      for every run whose schema declares the field. Credential-SELECTING
//      inputs (`secretPrefix`, `roleArn`, `env`, …) are refused the same way:
//      a Slack message never chooses which credential a container gets.
//   2. Run allowlist — a small code-defined set (`SLACK_ORIGIN_RUNS`), which
//      CONFIG_KV may NARROW but never widen. Payload-command runs are excluded
//      structurally, not by memory: `payloadCommandInputs` reads the run's own
//      `inputs` schema, so a run that grows a `command` field tomorrow drops
//      out of the Slack path the moment it does.
//   3. Config-pinned repo — `github.repo` must equal the deploy's pinned
//      target. Unset pin ⇒ the whole slack path is refused; enabling it is an
//      explicit operator act, never a default.
//   4. Fail closed, loudly — a run that hibernates on a human decision
//      (`humanGate`) is refused BEFORE instantiation with a message pointing
//      back at the conversational path. The alternative is the failure this
//      rule exists to prevent: a Workflow parked in `waitForEvent` for 72h
//      while the Slack thread shows nothing at all.
//   5. `Idempotency-Key` required — the route's semantic fallback id is
//      `{run}:{repo}:{sha12}`, and the batch runs on the allowlist carry no
//      per-request input, so two "run the sweep" messages in a day would
//      collapse onto ONE execution and the second would answer 202 while
//      nothing ran. Requiring the key makes each Slack event its own
//      execution.
//
// --- The scoped signing key --------------------------------------------------
//
// `SLACK_ORIGIN_HMAC_SECRET`, when set, is a second dispatch key whose
// signature FORCES this policy regardless of what the body declares — the
// caller's Slack path can then hold a credential that is incapable of
// dispatching outside the envelope. Unset (the default), the body's declared
// `source` selects the policy and the HMAC is the authentication. The scoped
// key is ignored when it equals `HMAC_SECRET`: two names for one value is not
// a scope, and silently treating every GHA dispatch as slack-origin would
// break CI far from the mistake.
//
// Spec: apps/dispatcher/specs/slack-origin.md.

import { Schema, SchemaAST } from "effect";
import type { Run } from "@fractalboxdev/flare-dispatch-core";
import type { Env } from "./env";

/**
 * The Slack origin context a batch re-dispatch carries. `channel` +
 * `thread_ts` are what the verdict callback needs to land in the SAME thread
 * the request came from; `user_id` is audit only.
 *
 * Every field is pattern-bounded. These values are echoed back in the verdict
 * callback and into log lines, and they arrive from outside this deploy —
 * bounding them keeps a hostile value from smuggling newlines into a log or
 * absurd length into a payload. The charset is Slack's own id shape (`T…`,
 * `C…`, `D…`, `U…`) plus the `1712345678.123456` message timestamp.
 */
export const SlackOrigin = Schema.Struct({
  kind: Schema.Literal("slack"),
  team_id: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9._-]{1,64}$/)),
  channel: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9._-]{1,64}$/)),
  /** The thread the verdict must land in. Absent for a channel-level command. */
  thread_ts: Schema.optional(Schema.String.pipe(Schema.pattern(/^\d{1,12}\.\d{1,8}$/))),
  /** The Slack user who asked — carried for the audit trail, never authz. */
  user_id: Schema.optional(Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9._-]{1,64}$/))),
  /**
   * The event class the caller's ingress classified this as (e.g.
   * `slash_command`). Recorded, never trusted: the policy below does not vary
   * by it, because a misclassification is exactly what it must survive.
   */
  event_class: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-z0-9_]{1,32}$/))),
});
export type SlackOrigin = Schema.Schema.Type<typeof SlackOrigin>;

/**
 * The dispatch body's `source` block — which surface asked for this run. Only
 * the Slack origin exists today; a second origin becomes a union member here
 * and an unknown `kind` stays a 400, never an unpoliced dispatch.
 */
export const DispatchSource = SlackOrigin;
export type DispatchSource = SlackOrigin;

/**
 * The runs the Slack path may dispatch on this deploy. Deliberately small and
 * boring: each takes no caller-supplied command, reaches no caller-supplied
 * network target, and lands its result somewhere a human reviews (a check-run,
 * a PR). CONFIG_KV `slack-origin.runs` may narrow this; nothing widens it.
 *
 * Excluded on purpose, and why:
 *   - `offload-test` / `check` / `matrix-fanout` / `vitest-shard` / `oxlint` /
 *     `playwright-demo` / `cdp-acceptance` / `refresh-fixtures` /
 *     `worker-deploy` — payload-command runs. A Slack message would be
 *     choosing the shell line a container executes.
 *   - `deploy-smoke` / `playwright-e2e` / `email-otp-login` / `demo-reel` /
 *     `product-demo` — the caller picks the URL the container dials. Egress
 *     selection from a chat message is the same problem wearing a URL.
 *   - `release-notes` — hibernates on a human decision; refused with the
 *     conversational-path pointer instead (see `humanGate`).
 *   - `self-heal-pr` — escalation target of a diagnosis, not a thing to ask
 *     for directly.
 */
export const SLACK_ORIGIN_RUNS: readonly string[] = [
  "ci-triage-pr",
  "finops-audit",
  "pr-review",
  "spec-drift-pr",
];

/** CONFIG_KV keys the operator tunes this policy with. */
export const SLACK_ORIGIN_REPO_KEY = "slack-origin.repo";
export const SLACK_ORIGIN_RUNS_KEY = "slack-origin.runs";
export const SLACK_NOTIFY_URL_KEY = "slack-origin.notify-url";

/**
 * Input names that hand the caller a command line. Matched against the run's
 * own `inputs` schema, so the rule tracks the run catalog instead of a list
 * someone has to remember to update: `command`, `args`, and any
 * `…Command` / `…Args` / `…Script` field (`appBootCommand`, `testCommand`).
 */
const COMMAND_INPUT = /^(?:command|args|script|entrypoint)$|(?:Command|Args|Script|Entrypoint)$/;

/**
 * Input names that select a CREDENTIAL — which secret to load, which prefix to
 * resolve it under, which IAM role to assume, what to put in the container's
 * env. A slack-origin dispatch carrying any of these with a value is refused;
 * the deploy's own config decides credentials, never a chat message.
 */
const CREDENTIAL_INPUTS: readonly string[] = [
  "secrets",
  "secretPrefix",
  "roleArn",
  "bedrockRoleArn",
  "env",
];

/** The property names a run's `inputs` schema declares. */
const inputNames = (run: Run<unknown, unknown>): readonly string[] => {
  const ast = (run.inputs as unknown as { readonly ast: SchemaAST.AST }).ast;
  return SchemaAST.getPropertySignatures(ast).map((p) => String(p.name));
};

/**
 * The command-shaped inputs a run declares — empty for a run the Slack path
 * may carry. Exported because the registry-wide test asserts it is empty for
 * every allowlisted run, which is what keeps the allowlist honest as runs
 * evolve.
 */
export const payloadCommandInputs = (run: Run<unknown, unknown>): readonly string[] =>
  inputNames(run).filter((name) => COMMAND_INPUT.test(name));

/** True when the run parks on a human decision mid-flight (`waitForEvent`). */
const isApprovalGated = (run: Run<unknown, unknown>): boolean => run.humanGate !== undefined;

/** A policy refusal — 403, with a message the caller relays into the thread. */
export type SlackOriginRefusal = {
  readonly kind: "refused";
  /** Machine-readable refusal code — stable, safe to branch on. */
  readonly error: string;
  /** Human-readable, written to be posted verbatim into a Slack thread. */
  readonly message: string;
};

export type SlackOriginAdmission = { readonly kind: "admitted" };

export type SlackOriginVerdict = SlackOriginRefusal | SlackOriginAdmission;

const admitted: SlackOriginAdmission = { kind: "admitted" };

const refuse = (error: string, message: string): SlackOriginRefusal => ({
  kind: "refused",
  error,
  message,
});

/** The pointer every fail-closed refusal ends on. */
const CONVERSATIONAL_PATH =
  "Ask for it in the thread instead — the conversational path carries the approval and progress UX this one does not.";

/** Narrow a value to a plain record, or `undefined` when it is not one. */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** True when a decoded input field carries something the caller actually set. */
const isSet = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
};

/**
 * The credential-selecting fields an inputs object actually carries a value
 * for — empty when it names none. Exported so both halves of the policy (and
 * its tests) run the identical rule.
 */
export const credentialSelectingInputs = (inputs: unknown): readonly string[] => {
  const record = asRecord(inputs);
  if (record === undefined) return [];
  return CREDENTIAL_INPUTS.filter((key) => isSet(record[key]));
};

const refuseCredentialSelection = (
  runName: string,
  offending: readonly string[],
): SlackOriginRefusal =>
  refuse(
    "credential_selection_not_permitted",
    `A Slack-origin dispatch may not choose credentials. Drop ${offending
      .map((n) => `\`${n}\``)
      .join(
        ", ",
      )} from the \`${runName}\` inputs — this deploy's own configuration decides what the run can reach.`,
  );

/** The resolved per-deploy configuration of the slack path. */
export type SlackOriginConfig = {
  /** The one repo slack-origin dispatches may target. `undefined` ⇒ path off. */
  readonly pinnedRepo: string | undefined;
  /** The effective run allowlist — code set, optionally narrowed by CONFIG_KV. */
  readonly allowedRuns: ReadonlySet<string>;
};

/**
 * Intersect the code allowlist with an operator-supplied comma-separated list.
 * Narrowing only: a name in CONFIG_KV that is not in the code set is dropped,
 * so no KV write can widen what the Slack path reaches. An absent/blank value
 * leaves the code set intact.
 */
export const resolveAllowedRuns = (
  code: readonly string[],
  configured: string | null | undefined,
): ReadonlySet<string> => {
  if (typeof configured !== "string" || configured.trim().length === 0) {
    return new Set(code);
  }
  const narrowed = new Set(
    configured
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  return new Set(code.filter((name) => narrowed.has(name)));
};

/**
 * Read the slack-origin config for this deploy. CONFIG_KV wins over the
 * wrangler var for the repo pin — the same `<x>Default` / `<x>Key` precedence
 * the cooldown spec uses, so an operator can re-point the path without a
 * redeploy.
 */
export const readSlackOriginConfig = async (env: Env): Promise<SlackOriginConfig> => {
  const kv = env.CONFIG_KV;
  const configuredRepo = kv === undefined ? null : await kv.get(SLACK_ORIGIN_REPO_KEY);
  const configuredRuns = kv === undefined ? null : await kv.get(SLACK_ORIGIN_RUNS_KEY);
  const pinned =
    typeof configuredRepo === "string" && configuredRepo.trim().length > 0
      ? configuredRepo.trim()
      : typeof env.SLACK_ORIGIN_REPO === "string" && env.SLACK_ORIGIN_REPO.trim().length > 0
        ? env.SLACK_ORIGIN_REPO.trim()
        : undefined;
  return {
    pinnedRepo: pinned,
    allowedRuns: resolveAllowedRuns(SLACK_ORIGIN_RUNS, configuredRuns),
  };
};

/**
 * The scoped dispatch key, or `undefined` when the deploy has none. Ignored
 * (and reported to the caller of this function as absent) when it equals
 * `HMAC_SECRET` — see the file header.
 */
export const resolveSlackOriginKey = (env: Env): string | undefined => {
  const scoped = env.SLACK_ORIGIN_HMAC_SECRET;
  if (typeof scoped !== "string" || scoped.length === 0) return undefined;
  if (scoped === env.HMAC_SECRET) return undefined;
  return scoped;
};

/**
 * The run-level half of the policy — everything decidable before the inputs
 * are decoded, so a refusal reads as a policy message rather than a schema
 * tree. Order is deliberate: the most specific, most actionable refusal wins.
 */
export const decideSlackOriginRun = (opts: {
  readonly runName: string;
  readonly run: Run<unknown, unknown>;
  readonly repo: string;
  /** The `inputs` as the caller sent them, before schema decoding. */
  readonly rawInputs: unknown;
  readonly idempotencyKey: string | null | undefined;
  readonly config: SlackOriginConfig;
}): SlackOriginVerdict => {
  const { runName, run, repo, rawInputs, idempotencyKey, config } = opts;

  if (config.pinnedRepo === undefined) {
    return refuse(
      "slack_origin_unconfigured",
      `This dispatcher has no Slack target repository configured, so it refuses Slack-origin dispatches. An operator sets \`${SLACK_ORIGIN_REPO_KEY}\` in CONFIG_KV (or the \`SLACK_ORIGIN_REPO\` var) to turn the batch path on.`,
    );
  }

  // Checked first, and against the RAW payload: a slack-origin dispatch that
  // names a credential is an integration bug at the caller, true whichever run
  // it named — so it is worth saying before "and that run isn't allowed
  // either". Raw, because decoding drops fields a run's schema does not
  // declare and this must not answer 202 to a request that asked for a secret.
  const credentialInputs = credentialSelectingInputs(rawInputs);
  if (credentialInputs.length > 0) {
    return refuseCredentialSelection(runName, credentialInputs);
  }

  if (isApprovalGated(run)) {
    const reason = run.humanGate?.reason ?? "it pauses for a human decision partway through";
    return refuse(
      "approval_required",
      `\`${runName}\` needs a human decision partway through — ${reason}. The batch path is fire-and-forget and has nowhere to ask, so this run would sit waiting with nothing to show for it. ${CONVERSATIONAL_PATH}`,
    );
  }

  if (!config.allowedRuns.has(runName)) {
    const allowed = [...config.allowedRuns].sort();
    return refuse(
      "run_not_allowed_from_slack",
      `\`${runName}\` is not dispatchable from Slack on this deploy. Allowed: ${
        allowed.length === 0 ? "(none)" : allowed.map((r) => `\`${r}\``).join(", ")
      }. ${CONVERSATIONAL_PATH}`,
    );
  }

  // Defense in depth behind the allowlist: even a run someone allowlisted by
  // hand cannot reach the Slack path while it takes a command from its caller.
  const commandInputs = payloadCommandInputs(run);
  if (commandInputs.length > 0) {
    return refuse(
      "payload_command_run",
      `\`${runName}\` takes a command from its dispatch payload (${commandInputs
        .map((n) => `\`${n}\``)
        .join(", ")}), so it is never dispatchable from Slack. ${CONVERSATIONAL_PATH}`,
    );
  }

  if (repo !== config.pinnedRepo) {
    return refuse(
      "repo_not_pinned",
      `Slack-origin dispatches on this deploy may only target \`${config.pinnedRepo}\`; this one named \`${repo}\`.`,
    );
  }

  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return refuse(
      "idempotency_key_required",
      "A Slack-origin dispatch must carry an `Idempotency-Key` header (the Slack event id is the natural value). Without one the dispatcher would fold repeat requests onto a single execution and answer the second one with a run that never starts.",
    );
  }

  return admitted;
};

/**
 * The inputs half of the policy. Refuses any credential-selecting field
 * carrying a value, and returns the normalized inputs the Workflow is
 * instantiated with — `secrets: []` forced for every run that declares it, so
 * "no secrets on the Slack path" is a property of what executes and not of
 * what was asked for.
 *
 * It reads BOTH the raw body inputs and the decoded ones. Decoding drops
 * properties a run's schema does not declare, so a `secrets` array smuggled
 * onto a run that ignores the field would vanish before the policy could see
 * it — harmless in effect, but it would answer 202 to a request that asked for
 * something forbidden. Checking the raw side makes the refusal loud, which is
 * what an operator reading the response needs it to be.
 */
export type SlackOriginInputsVerdict =
  | SlackOriginRefusal
  | { readonly kind: "admitted"; readonly inputs: unknown };

export const decideSlackOriginInputs = (opts: {
  readonly runName: string;
  readonly run: Run<unknown, unknown>;
  /** The inputs after `run.inputs` decoding — schema defaults applied. */
  readonly decoded: unknown;
}): SlackOriginInputsVerdict => {
  const { runName, run, decoded } = opts;
  const decodedRecord = asRecord(decoded);

  // The raw payload was already checked in `decideSlackOriginRun`; this
  // re-check catches the case a schema DEFAULT introduces — a run whose
  // `secrets` field defaults to something non-empty would otherwise reach a
  // container with a credential nobody asked for.
  const offending = credentialSelectingInputs(decoded);
  if (offending.length > 0) {
    return refuseCredentialSelection(runName, offending);
  }

  // Force `secrets: []` for a run that declares the field. The refusal above
  // already rejects a populated one; this closes the remaining gap, where a
  // future schema default is something other than empty.
  const declaresSecrets = inputNames(run).includes("secrets");
  const normalized =
    declaresSecrets && decodedRecord !== undefined
      ? { ...decodedRecord, secrets: [] as readonly string[] }
      : decoded;

  return { kind: "admitted", inputs: normalized };
};
