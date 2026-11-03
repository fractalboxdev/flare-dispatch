// The profile's admission bindings: `resolveClass`, the three dedup recipes and `supersessionKey` (specs/profile.md
// § Class resolution, § Dedup recipes and supersession). Each is a pure function of the request and its declared
// inputs, with no clock, store or service (FD-PROF-011); the protection-snapshot cache that feeds `resolveClass`
// holds the one clock read.
import type { BindingResult, DedupRecipe, Unavailable } from "@fractalboxdev/mameko-coordinator";
import { Schema } from "effect";

/** FlareDispatch's classes in rank order; index is rank. */
export const CLASS_ORDER = ["release", "required", "interactive", "batch"] as const;
export type ClassName = (typeof CLASS_ORDER)[number];

const rank = (c: ClassName): number => CLASS_ORDER.indexOf(c);
/** The lower-ranked (less urgent) of two classes. */
const lower = (a: ClassName, b: ClassName): ClassName => (rank(a) >= rank(b) ? a : b);
/** `c` capped so it ranks no higher than `ceiling`. */
const capAt = (c: ClassName, ceiling: ClassName): ClassName => lower(c, ceiling);

/** The gating runs whose class step 2 decides from the target branch's required set. */
export const GATING_RUNS: readonly string[] = ["check", "oxlint", "offload-test"];

/** The recipes that declare `supersede` (FD-PROF-028). */
export const SUPERSEDING_RUNS: readonly string[] = ["check", "oxlint", "offload-test", "pr-review"];

/** The in-code `release` allowlist of step 1; `sandbox-image` publishes on its release trigger (FD-GATE-080). */
export const RELEASE_ALLOWLIST: readonly string[] = [
  "release",
  "worker-deploy",
  "publish",
  "sandbox-image",
];

/** How a request reached the control plane. */
export type Trigger =
  | { readonly kind: "tag-push"; readonly protectedTag: boolean }
  | {
      readonly kind: "push";
      readonly branch: string;
      readonly protectedBranch: boolean;
      readonly defaultBranch: boolean;
    }
  | { readonly kind: "pull_request" | "fork-pr" }
  | { readonly kind: "merge_group" }
  | { readonly kind: "check_suite" | "deployment_status"; readonly defaultBranch: boolean }
  | {
      readonly kind: "actions-dispatch";
      /** The OIDC token's `ref`, `refs/heads/<branch>`. */
      readonly oidcRef: string;
      readonly protectedBranch: boolean;
    }
  | { readonly kind: "follow-on"; readonly parentClass: ClassName }
  | { readonly kind: "cron" | "local-submit" | "mcp" };

/** The caller of a dispatch, for step 6: its OIDC identity scoped to (repository, workflow ref). */
export interface Caller {
  readonly identity: string;
  readonly repository: string;
  readonly workflowRef: string;
  readonly protectedBranch: boolean;
}

/** The request `resolveClass` and the recipes read. */
export interface ClassRequest {
  readonly run: string;
  /** `<owner>/<repo>`. */
  readonly repository: string;
  readonly sha: string;
  readonly trigger: Trigger;
  /** The check name of a gating run. */
  readonly checkName?: string;
  /** The run definition's `limits.qosClass` and `limits.qosCeiling`; absent when the run declares none. */
  readonly qosClass?: ClassName;
  readonly qosCeiling?: ClassName;
  /** The parent execution's class, for a child. */
  readonly parentClass?: ClassName;
  /** A dispatch's `class` input. */
  readonly classInput?: ClassName;
  readonly caller?: Caller;
  /** Pull-request labels. */
  readonly labels?: readonly string[];
  /** The run makes hosted model calls. */
  readonly hostedModelCalls?: boolean;
  /** A check re-run: the class of its family's first attempt. */
  readonly rerun?: { readonly firstAttemptClass: ClassName };
  /** The workflow's deploy branch, `workerDeploy.branch`. */
  readonly deployBranch?: string;
  /** The pull request number of a pull-request request. */
  readonly pullRequest?: number;
  /** A matrix or variant label of the run, `[:<label>]` in the keys. */
  readonly label?: string;
  /** The dispatch's `Idempotency-Key` header. */
  readonly idempotencyKey?: string;
  /** The `dispatch.followOn` intent that raised this request. */
  readonly followOn?: { readonly executionId: string; readonly intentKey: string };
}

/** The `protection-snapshot` input: the target branch's required check names. */
export const ProtectionSnapshot = Schema.Struct({
  requiredChecks: Schema.Array(Schema.String),
});
export type ProtectionSnapshot = typeof ProtectionSnapshot.Type;

const ClassLiteral = Schema.Literals(CLASS_ORDER);

/** One policy rule from the repository's policy rules, the `policy-rules` input. */
export const PolicyRule = Schema.Struct({
  /** Matches when every present field matches. */
  match: Schema.Struct({
    run: Schema.optional(Schema.String),
    /** A pull-request label the request carries. */
    label: Schema.optional(Schema.String),
  }),
  class: ClassLiteral,
  /** The rule lifts the run's `limits.qosCeiling`. */
  liftsCeiling: Schema.optional(Schema.Boolean),
  /** The callers whose `class` input may raise up to `class` (step 6). */
  callers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        identity: Schema.String,
        repository: Schema.String,
        workflowRef: Schema.String,
      }),
    ),
  ),
});
export type PolicyRule = typeof PolicyRule.Type;

const isUnavailable = (v: unknown): v is Unavailable =>
  typeof v === "object" && v !== null && (v as { _tag?: unknown })._tag === "Unavailable";

const isProtection = Schema.is(ProtectionSnapshot);
const isRules = Schema.is(Schema.Array(PolicyRule));

/** `resolveClass`'s answer with the clamp step 6 logs (FD-PROF-020). */
export interface Resolved {
  readonly class: ClassName;
  readonly labels: readonly string[];
  readonly alarm: string | null;
  /** Present when the class input asked for more than step 6 allows. */
  readonly clamped?: { readonly requested: ClassName; readonly assigned: ClassName };
}

const isPullRequestTrigger = (r: ClassRequest): boolean =>
  r.trigger.kind === "pull_request" ||
  r.trigger.kind === "fork-pr" ||
  r.trigger.kind === "merge_group" ||
  (r.trigger.kind === "push" && r.trigger.branch.startsWith("gh-readonly-queue/"));

/** Step 1's release triggers. */
const isReleaseTrigger = (r: ClassRequest): boolean => {
  const t = r.trigger;
  switch (t.kind) {
    case "tag-push":
      return t.protectedTag;
    case "check_suite":
    case "deployment_status":
      return t.defaultBranch;
    case "push":
      return t.protectedBranch && r.deployBranch !== undefined && t.branch === r.deployBranch;
    case "actions-dispatch":
      return r.deployBranch !== undefined && t.oidcRef === `refs/heads/${r.deployBranch}`;
    case "follow-on":
      return t.parentClass === "release";
    default:
      return false;
  }
};

const ruleMatches = (rule: PolicyRule, r: ClassRequest): boolean =>
  (rule.match.run === undefined || rule.match.run === r.run) &&
  (rule.match.label === undefined || (r.labels ?? []).includes(rule.match.label));

/**
 * The six steps of § Class resolution, in order (FD-PROF-011 to FD-PROF-024). A re-run takes its family's first
 * class before any step (FD-PROF-022).
 */
export const resolveClassDetailed = (
  r: ClassRequest,
  inputs: Readonly<Record<string, unknown>>,
): Resolved => {
  const labels = r.trigger.kind === "fork-pr" ? ["untrusted-input"] : [];
  if (r.rerun !== undefined) return { class: r.rerun.firstAttemptClass, labels, alarm: null };

  // Step 1: the only path to `release` (FD-PROF-012).
  if (RELEASE_ALLOWLIST.includes(r.run) && isReleaseTrigger(r))
    return { class: "release", labels, alarm: null };

  let alarm: string | null = null;
  const ceiling: ClassName = r.qosCeiling ?? "required";
  // Step 4's value, which every later step starts from when step 2 does not decide; never `release`.
  const runDefault: { class: ClassName; labels: readonly string[] } =
    r.qosClass === undefined
      ? { class: "batch", labels: ["local-only"] }
      : { class: capAt(capAt(r.qosClass, ceiling), "required"), labels: [] };

  // Step 2: a gating run on a pull-request trigger takes its class from the required set (FD-PROF-013).
  let verifiedRequired = false;
  let current: ClassName | undefined;
  if (GATING_RUNS.includes(r.run) && isPullRequestTrigger(r)) {
    const snapshot = inputs["protection-snapshot"];
    if (isUnavailable(snapshot)) {
      if (snapshot.reason === "forbidden")
        alarm = "ruleset-permission"; // FD-PROF-016
      else verifiedRequired = true; // FD-PROF-015: timeout or server-error fails toward required.
    } else if (isProtection(snapshot)) {
      verifiedRequired = r.checkName !== undefined && snapshot.requiredChecks.includes(r.checkName);
    }
    if (alarm === null) current = verifiedRequired ? "required" : "interactive";
  }

  // Step 3: the first matching policy rule lowers freely; it raises only to a step-2 `required`, up to the ceiling
  // unless it lifts it, and a label-matched rule never above `interactive` (FD-PROF-017, FD-PROF-021).
  const rules = inputs["policy-rules"];
  const base = current ?? runDefault.class;
  let resolved = base;
  const rule = isRules(rules) ? rules.find((x) => ruleMatches(x, r)) : undefined;
  const raisesToRequired = rule !== undefined && rule.class === "required" && verifiedRequired;
  if (rule !== undefined) {
    if (rank(rule.class) >= rank(base)) resolved = rule.class;
    else if (raisesToRequired)
      resolved = rule.match.label === undefined ? "required" : capAt("required", "interactive");
  }
  const ruleLiftsCeiling =
    raisesToRequired && rule.liftsCeiling === true && rule.match.label === undefined;

  // Step 4: the run's ceiling caps the class; a required check clamped while it makes hosted model calls raises
  // `required-check-clamped` (FD-PROF-018, FD-PROF-023).
  let out = resolved;
  if (!ruleLiftsCeiling) {
    out = capAt(resolved, ceiling);
    if (verifiedRequired && resolved === "required" && out !== "required" && r.hostedModelCalls)
      alarm = "required-check-clamped";
  }
  const outLabels =
    current === undefined && rule === undefined ? [...labels, ...runDefault.labels] : labels;

  // Step 5: a child takes the lower of its parent's class and its own result (FD-PROF-019).
  if (r.parentClass !== undefined) out = lower(out, r.parentClass);

  // Step 6: the class input lowers freely and raises only as a policy rule allows for the caller (FD-PROF-020).
  let clamped: Resolved["clamped"];
  if (r.classInput !== undefined) {
    if (rank(r.classInput) >= rank(out)) out = r.classInput;
    else {
      const allowed = isRules(rules) ? callerAllowance(rules, r) : undefined;
      const assigned = allowed === undefined ? out : lower(r.classInput, allowed);
      const next = rank(assigned) < rank(out) ? assigned : out;
      if (next !== r.classInput) clamped = { requested: r.classInput, assigned: next };
      out = next;
    }
  }
  return { class: out, labels: outLabels, alarm, ...(clamped === undefined ? {} : { clamped }) };
};

/** The highest class a policy rule lets this caller's class input reach, on a protected branch only; never `release`. */
const callerAllowance = (rules: readonly PolicyRule[], r: ClassRequest): ClassName | undefined => {
  const c = r.caller;
  if (c === undefined || !c.protectedBranch) return undefined;
  let best: ClassName | undefined;
  for (const rule of rules) {
    if (!ruleMatches(rule, r)) continue;
    const ok = (rule.callers ?? []).some(
      (x) =>
        x.identity === c.identity &&
        x.repository === c.repository &&
        x.workflowRef === c.workflowRef,
    );
    if (!ok) continue;
    const cls = capAt(rule.class, "required");
    best = best === undefined || rank(cls) < rank(best) ? cls : best;
  }
  return best;
};

/** The `resolveClass` binding in mameko's binding shape (MAMEKO-ADM-005); it never refuses. */
export const resolveClass = (
  r: ClassRequest,
  inputs: Readonly<Record<string, unknown>>,
): Extract<BindingResult, { readonly class: string }> & { readonly class: ClassName } => {
  const { class: cls, labels, alarm } = resolveClassDetailed(r, inputs);
  return { class: cls, labels, alarm };
};

/** An `Idempotency-Key` header of 1 to 128 characters from `[A-Za-z0-9._:-]`. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

/** `idem:<owner>/<repo>:<Idempotency-Key>`, or none. */
export const idempotencyKeyRecipe = (r: ClassRequest): string | null =>
  r.idempotencyKey !== undefined && IDEMPOTENCY_KEY.test(r.idempotencyKey)
    ? `idem:${r.repository}:${r.idempotencyKey}`
    : null;

/** `<execution_id>/<intent_key>` for a request a `dispatch.followOn` intent raised, or none. */
export const followOnRecipe = (r: ClassRequest): string | null =>
  r.followOn === undefined ? null : `${r.followOn.executionId}/${r.followOn.intentKey}`;

/** `<run>[:<label>]:<owner>/<repo>:<sha>`, total and without the trigger kind. */
export const commitRecipe = (r: ClassRequest): string =>
  `${r.run}${r.label === undefined ? "" : `:${r.label}`}:${r.repository}:${r.sha}`;

/** The three recipes in the order the profile declares them (FD-PROF-026). */
export const dedupRecipes: readonly DedupRecipe<ClassRequest>[] = [
  { name: "idempotency-key", run: idempotencyKeyRecipe },
  { name: "follow-on", run: followOnRecipe },
  { name: "commit", run: commitRecipe },
];

/**
 * `<owner>/<repo>:<pull request number>:<run>[:<label>]` for a pull-request request of a superseding run, and none for
 * every other request, a check re-run included (FD-PROF-027, FD-PROF-029).
 */
export const supersessionKey = (r: ClassRequest): string | null =>
  r.rerun === undefined &&
  r.pullRequest !== undefined &&
  SUPERSEDING_RUNS.includes(r.run) &&
  isPullRequestTrigger(r)
    ? `${r.repository}:${r.pullRequest}:${r.run}${r.label === undefined ? "" : `:${r.label}`}`
    : null;

/** How long a branch's required set stays cached (FD-PROF-014). */
export const PROTECTION_TTL_MS = 600_000;

/**
 * Each branch's required set, cached for at most 10 min and dropped for a repository on every `repository_ruleset`
 * and `branch_protection_rule` webhook (FD-PROF-014). The caller supplies the clock reading.
 */
export class ProtectionSnapshotCache {
  readonly #entries = new Map<
    string,
    { readonly at: number; readonly value: ProtectionSnapshot }
  >();

  get(repository: string, branch: string, now: number): ProtectionSnapshot | undefined {
    const key = `${repository}#${branch}`;
    const hit = this.#entries.get(key);
    if (hit === undefined || now - hit.at >= PROTECTION_TTL_MS) {
      this.#entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  put(repository: string, branch: string, value: ProtectionSnapshot, now: number): void {
    this.#entries.set(`${repository}#${branch}`, { at: now, value });
  }

  /** Drops every branch of `repository` when one of the two protection webhooks arrives. */
  onWebhook(event: string, repository: string): boolean {
    if (event !== "repository_ruleset" && event !== "branch_protection_rule") return false;
    for (const key of this.#entries.keys())
      if (key.startsWith(`${repository}#`)) this.#entries.delete(key);
    return true;
  }
}
