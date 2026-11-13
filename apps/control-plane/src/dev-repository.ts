// The repository a `development` deployment with no GitHub App reads: one commit of one repository, as the local
// command that starts the deployment captured it (`pnpm ci:local` writes it from the checkout). Only the facts it holds
// answer; every other read fails, so no caller decides on a read that never happened.
import {
  confidentialityOf,
  repositoryRules,
  type ConfidentialityMode,
} from "@fractalboxdev/flare-dispatch-profile";
import { Schema } from "effect";
import { deployment, type ControlPlaneEnv } from "./config.ts";
import { policyRulesOf } from "./policy.ts";

export const DevRepository = Schema.Struct({
  /** `<owner>/<name>`. */
  repository: Schema.NonEmptyString,
  installation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  default_branch: Schema.NonEmptyString,
  /** The default branch's head: the commit the files were read at. */
  head: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  /** Each captured path's UTF-8 text at `head`, base64-encoded, or null where the path does not exist there. */
  files: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  /**
   * The repository's GitHub visibility, `public`, `private` or `internal`; absent where the capture did not read it, and
   * then no read answers it.
   */
  visibility: Schema.optionalKey(Schema.NonEmptyString),
  /** The repository's confidentiality mode; absent is `unclassified`, mameko's fail-closed default. */
  confidentiality: Schema.optionalKey(
    Schema.Literals([
      "non-confidential",
      "unclassified",
      "confidential-model",
      "confidential-compute",
    ]),
  ),
});
export type DevRepository = typeof DevRepository.Type;

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(DevRepository));

/** The captured repository, read only by a `development` deployment; a value that does not decode throws. */
export const devRepositoryOf = (
  env: Pick<ControlPlaneEnv, "DEPLOYMENT" | "FD_DEV_REPOSITORY">,
): DevRepository | undefined => {
  const raw = env.FD_DEV_REPOSITORY;
  if (deployment(env) !== "development" || raw === undefined || raw === "") return undefined;
  return decode(raw);
};

/** The bindings a repository's confidentiality mode reads. */
export type ConfidentialityEnv = Pick<
  ControlPlaneEnv,
  "DEPLOYMENT" | "FD_DEV_REPOSITORY" | "POLICY_RULES"
>;

/**
 * A repository's confidentiality mode, the one source intake's admission, a lease's cache fields, the log route and
 * the check-run applier read: the mode the repository's synced policy rules set (FD-PROF-025), else the mode a
 * development deployment's captured repository carries, else `unclassified`. A repository name matches in any letter
 * case, as GitHub matches it, so the case a caller types never selects a weaker mode.
 */
export const repositoryConfidentiality = (
  env: ConfidentialityEnv,
): ((repo: string) => ConfidentialityMode) => {
  const rules = policyRulesOf(env);
  const dev = devRepositoryOf(env);
  return (repo) =>
    confidentialityOf(repositoryRules(rules, repo)) ??
    (dev !== undefined && dev.repository.toLowerCase() === repo.toLowerCase()
      ? dev.confidentiality
      : undefined) ??
    "unclassified";
};

/** True while a repository's mode is `confidential-compute`: no L2 read or write, and logs stay on the device. */
export const confidentialCompute = (env: ConfidentialityEnv, repo: string): boolean =>
  repositoryConfidentiality(env)(repo) === "confidential-compute";

/** A captured file's text: a string, null where the path is absent, undefined where it was not captured. */
export const devFile = (dev: DevRepository, path: string): string | null | undefined => {
  if (!Object.hasOwn(dev.files, path)) return undefined;
  const encoded = dev.files[path]!;
  if (encoded === null) return null;
  const binary = atob(encoded);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
};
