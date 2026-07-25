// FlareDispatch Dispatcher — check-run naming.
//
// The name a run's GitHub check-run is posted under. Historically this was
// exactly `flare-dispatch/${run}`, one name per run definition, derived inline
// in `RunWorkflow`. That is still the default and still what every existing run
// gets — extracted here so the one case that needs more has somewhere to live.
//
// The exception is a run dispatched SEVERAL TIMES against the same commit with
// different work each time — `check` is the one in the catalog today: a repo
// with more than one deterministic gate (a source guard, `shellcheck`, a
// codegen-drift check) dispatches it once per gate. Under a single fixed name
// those become N check-runs all called `flare-dispatch/check`, and branch
// protection — which requires checks BY NAME — cannot tell them apart or
// require them individually. An optional `checkLabel` in the run's inputs
// suffixes the name (`flare-dispatch/check:codegen`), making each dispatch its
// own separately-requirable check.
//
// Read structurally off the decoded-but-untyped `inputs`, not off a per-run
// type: `RunWorkflow` names the check BEFORE it decodes inputs against the
// run's schema (the check-run must exist to report a decode failure), so the
// name cannot depend on a successful decode. That is also why the label is
// validated here rather than trusted from the run's schema — see below.

/**
 * Characters a `checkLabel` may contain. The label lands in a GitHub check-run
 * name, so this rejects rather than sanitises: whitespace, slashes, and control
 * characters could produce a name that silently doesn't match the string an
 * operator typed into branch protection — a check that appears to pass while
 * gating nothing. Bounded at 32 chars to keep the composed name readable.
 *
 * `check`'s input schema carries the same pattern, so a bad label is normally a
 * clean 400 at dispatch. This is the backstop for the paths that reach
 * `RunWorkflow` without that validation (a direct Workflow instantiation, a run
 * that adopts `checkLabel` without declaring the constraint), where the safe
 * outcome is the plain unlabelled name rather than a malformed one.
 */
const CHECK_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** Extract a valid `checkLabel` from arbitrary decoded inputs, else undefined. */
const readCheckLabel = (inputs: unknown): string | undefined => {
  if (typeof inputs !== "object" || inputs === null) return undefined;
  const label = (inputs as { readonly checkLabel?: unknown }).checkLabel;
  return typeof label === "string" && CHECK_LABEL_PATTERN.test(label)
    ? label
    : undefined;
};

/**
 * The check-run name for a dispatch: `flare-dispatch/<run>`, plus `:<label>`
 * when the inputs carry a valid `checkLabel`.
 *
 * Backward compatible by construction — inputs without a `checkLabel` (every
 * run in the catalog but `script-gate`) produce the byte-identical name they
 * produced before, so no existing required check changes.
 */
export const checkRunNameFor = (run: string, inputs: unknown): string => {
  const label = readCheckLabel(inputs);
  return label === undefined
    ? `flare-dispatch/${run}`
    : `flare-dispatch/${run}:${label}`;
};
