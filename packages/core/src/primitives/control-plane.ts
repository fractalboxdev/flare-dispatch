// Primitive: resolving the control plane a scheduled run writes to.
//
// Three Schedule-mode runs — `org-spec-audit`, `triage-prs`, `triage-issues` —
// share one shape: sweep an estate, then file ONE proposal into a control repo
// at a path the operator chose. This resolves the two config values that shape
// governs, and fails the run by name when either is unusable.
//
// --- Why there is no default control repo ------------------------------------
//
// A default is a repository somebody else's deployment files pull requests
// against. The fallback for "the operator did not say where to file this" is
// not a different repo — it is stopping. So `resolveControlRepo` treats unset
// and malformed as the same answer, and both fail.
//
// Callers resolve BEFORE the sweep, not at the write. An estate's worth of
// model calls and API reads whose output has nowhere to land is an expensive
// way to learn a key is missing, and the failure reads as an audit problem
// rather than a config one.
//
// --- Why the path is validated ----------------------------------------------
//
// These strings become paths in a commit and in `contents` API reads. The
// failure guarded here is not primarily malice — config is written by an
// operator — but a leading `/` or a stray `../` produces a path that means
// something other than what that operator read back in the diff. An empty
// value takes the caller's fallback rather than erroring, so "unset" behaves
// like a fresh install.
//
// The pure rules live in `scheduling` (`parseRepo`, `parseRepoRelativePath`) so
// they are testable with plain data; this module is only the config read and
// the typed failure. Rides on the `config` capability. Layer: 03-dsl §
// Primitives.

import { Effect } from "effect";
import { config } from "../services/config";
import { StepFailed } from "../errors";
import { step } from "../step";
import { parseRepo, parseRepoRelativePath } from "./scheduling";

/** The `<ns>.<suffix>` tail, for naming the step after the key it reads. */
const stepName = (configKey: string): string => `resolve-${configKey.split(".").slice(1).join(".")}`;

/**
 * Read a control-repo key as `owner/name`, or fail the run naming the key.
 *
 * There is no default and there will not be one — see the module header.
 */
export const resolveControlRepo = (configKey: string) =>
  Effect.gen(function* () {
    const resolved = parseRepo(yield* step(stepName(configKey), () => config.get(configKey)));
    if (resolved === undefined) {
      return yield* Effect.fail(
        new StepFailed({
          step: stepName(configKey),
          cause: `${configKey} is unset or not \`owner/name\` — this run has no default control repo, and will not guess one`,
        }),
      );
    }
    return resolved;
  });

/**
 * Read a repo-relative path key, falling back when unset, failing when it
 * escapes the repo root.
 */
export const resolveRepoRelativePath = (configKey: string, fallback: string) =>
  Effect.gen(function* () {
    const resolved = parseRepoRelativePath(
      yield* step(stepName(configKey), () => config.get(configKey)),
      fallback,
    );
    if (resolved === undefined) {
      return yield* Effect.fail(
        new StepFailed({
          step: stepName(configKey),
          cause: `${configKey} is not a repo-relative path (no leading "/", no "..", no backslashes)`,
        }),
      );
    }
    return resolved;
  });
