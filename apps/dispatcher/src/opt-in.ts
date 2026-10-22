// FlareDispatch Dispatcher — receiver-side opt-in.
//
// A run may declare `optIn: ({ input }) => keys` (packages/core define-run.ts):
// the CONFIG_KV keys whose presence means the repo opted in. The webhook
// receiver reads them before it creates a Workflow, so a repo that never
// configured the run costs no Workflow, check-run, admission slot or container
// (specs/adr/0007-cost-efficient-execution.md § Dispatch only work).
//
// The read fails open. A KV error, or a deploy without CONFIG_KV, dispatches
// exactly as the receiver did before the check existed: the run body still
// resolves its own command and no-ops when there is none, so a failed read
// costs one wasted run, never a configured repo's verdict.

/** The receiver's decision for one triggered run. */
export type OptInVerdict = "dispatch" | "not-configured";

/**
 * Decide whether to dispatch a run whose `optIn` named `keys`.
 *
 * `keys` empty (the inputs carry their own command) or no `configKv` →
 * `dispatch` with no read. Otherwise any present key → `dispatch`; none →
 * `not-configured`. A rejected read logs and answers `dispatch`.
 */
export const resolveOptIn = async (args: {
  readonly configKv: KVNamespace | undefined;
  readonly runName: string;
  readonly keys: readonly string[];
}): Promise<OptInVerdict> => {
  const { configKv, runName, keys } = args;
  if (keys.length === 0 || configKv === undefined) return "dispatch";
  try {
    const values = await Promise.all(keys.map((key) => configKv.get(key)));
    return values.some((value) => value !== null) ? "dispatch" : "not-configured";
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(
      `[webhook] opt-in read failed run="${runName}" keys=${JSON.stringify(keys)}: ${message} — dispatching`,
    );
    return "dispatch";
  }
};
