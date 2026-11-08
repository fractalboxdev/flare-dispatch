// An agentic recipe's declaration beside its run spec, the registry validator that reads it at deploy, the intent-kind
// check on a result and the trifecta rule at admission (specs/runs/agentic.md § Declaration and catalog, § Trifecta
// rule, § Credential boundary).
import { Exit, Schema } from "effect";
import { WritebackSpec } from "./staged-write/manifest.ts";

/** The model-call tiers of mameko's gateway. */
export const Tier = Schema.Literals(["transform", "judgment"]);
export type Tier = typeof Tier.Type;

/**
 * The repository-write kinds an agentic recipe may return, each applied through the outbox (FD-AGT-009). No merge kind
 * exists (FD-AGT-039).
 */
export const WRITE_KINDS = [
  "comment",
  "review",
  "issue",
  "label",
  "pr.propose",
  "pr.close",
  "release.draft",
  "release.publish",
] as const;

/** The kinds that decorate the execution's own check. */
export const CHECK_KINDS = ["check.summary", "check.annotations"] as const;

export const AgenticIntentKind = Schema.Literals([...WRITE_KINDS, ...CHECK_KINDS]);
export type AgenticIntentKind = typeof AgenticIntentKind.Type;

export const DataClasses = Schema.Struct({
  privateData: Schema.Boolean,
  untrustedInput: Schema.Boolean,
  outbound: Schema.Boolean,
});
export type DataClasses = typeof DataClasses.Type;

export const CallSite = Schema.Struct({ name: Schema.NonEmptyString, tier: Tier });

/** What an agentic recipe declares in its catalogue entry (specs/runs/agentic.md § Model). */
export const AgenticDeclaration = Schema.Struct({
  callSites: Schema.Array(CallSite),
  needsModel: Schema.Boolean,
  dataClasses: DataClasses,
  intentKinds: Schema.Array(AgenticIntentKind),
  writeback: Schema.optionalKey(WritebackSpec),
});
export type AgenticDeclaration = typeof AgenticDeclaration.Type;

export interface Rejection {
  readonly run: string;
  readonly reason: string;
}

const decodeDeclaration = Schema.decodeUnknownExit(AgenticDeclaration);

/**
 * The registry validator's agentic rules: a declaration that omits a call site's tier, its data classes or its intent
 * kinds fails to decode (FD-AGT-002); one naming a kind outside the write and check kinds, such as a merge, fails
 * (FD-AGT-009, FD-AGT-039); one setting all three data classes fails (FD-AGT-004); `pr.propose` needs a `writeback`
 * block.
 */
export const validateDeclaration = (run: string, declaration: unknown): readonly Rejection[] => {
  const decoded = decodeDeclaration(declaration);
  if (Exit.isFailure(decoded))
    return [{ run, reason: `declaration: ${String(decoded.cause).split("\n")[0]}` }];
  const d = decoded.value;
  const rejections: Rejection[] = [];
  if (d.dataClasses.privateData && d.dataClasses.untrustedInput && d.dataClasses.outbound)
    rejections.push({ run, reason: "policy: trifecta" });
  if (d.needsModel && d.callSites.length === 0)
    rejections.push({ run, reason: "declaration: needsModel without a call site" });
  if (d.intentKinds.includes("pr.propose") && d.writeback === undefined)
    rejections.push({ run, reason: "declaration: pr.propose without a writeback block" });
  return rejections;
};

/** An intent as a result returns it: its kind and its run-authored key. */
export interface ResultIntent {
  readonly kind: string;
  readonly key: string;
  readonly payload: unknown;
}

export type IntentCheck =
  | { readonly _tag: "apply" }
  | {
      readonly _tag: "refuse";
      readonly reason: "intent: undeclared kind";
      readonly kinds: readonly string[];
    };

/**
 * A result carrying any kind its spec does not declare applies none of its intents and concludes `failure` with
 * `intent: undeclared kind` (FD-AGT-003).
 */
export const checkResultIntents = (
  declared: readonly string[],
  intents: readonly ResultIntent[],
): IntentCheck => {
  const undeclared = [...new Set(intents.map((i) => i.kind).filter((k) => !declared.includes(k)))];
  return undeclared.length === 0
    ? { _tag: "apply" }
    : { _tag: "refuse", reason: "intent: undeclared kind", kinds: undeclared };
};

/** The `author_association` values whose text is trusted (specs/runs/agentic.md § Data classes). */
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

export interface AdmissionFacts {
  readonly repositoryPublic: boolean;
  readonly confidentiality: string;
  /** The `author_association` of every principal whose text the input holds. */
  readonly inputAssociations: readonly string[];
  readonly forkHead: boolean;
  /** Hosts the execution's egress profile admits. */
  readonly egressHosts: readonly string[];
  readonly modelGatewayHost: string;
  readonly gitRemoteHost: string;
  /** The repositories the run's intents target, as `owner/name`. */
  readonly intentRepositories: readonly string[];
  readonly repository: string;
}

/** The control plane's three data classes of an execution, computed at admission. */
export const computeDataClasses = (facts: AdmissionFacts): DataClasses => ({
  privateData: !facts.repositoryPublic || facts.confidentiality !== "non-confidential",
  untrustedInput:
    facts.forkHead || facts.inputAssociations.some((a) => !TRUSTED_ASSOCIATIONS.has(a)),
  outbound:
    facts.egressHosts.some((h) => h !== facts.modelGatewayHost && h !== facts.gitRemoteHost) ||
    facts.intentRepositories.some((r) => r !== facts.repository),
});

/** An execution whose three computed classes are all true concludes `failure` with `policy: trifecta` (FD-AGT-005). */
export const trifectaAdmission = (
  classes: DataClasses,
): { readonly _tag: "admit" } | { readonly _tag: "refuse"; readonly reason: "policy: trifecta" } =>
  classes.privateData && classes.untrustedInput && classes.outbound
    ? { _tag: "refuse", reason: "policy: trifecta" }
    : { _tag: "admit" };
