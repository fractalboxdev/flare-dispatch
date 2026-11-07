// `fd deploy` and `fd doctor`, the only deploy and drift-check paths (FD-IFC-070), behave as specs/operability.md
// specifies: overlay decode, render, drift check, D1 migrations, Worker deploys and post-deploy probes, stopping at the
// first stage that fails (FD-OPS-009). The operability area implements this service; the commands only parse their
// flags, call it and turn its report into output and an exit code.
import { Context, Effect, Layer, Schema } from "effect";

export interface DeployRequest {
  /** The operator overlay, as JSON text. */
  readonly overlay: string;
  /** Stop after the drift check, changing no Cloudflare state. */
  readonly dryRun: boolean;
}

/** One stage of a deploy or a drift check, in the order it ran. */
export interface StageReport {
  readonly stage: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface OperabilityReport {
  readonly ok: boolean;
  readonly stages: readonly StageReport[];
}

export class OperabilityFailed extends Schema.TaggedError<OperabilityFailed>()(
  "OperabilityFailed",
  {
    message: Schema.String,
  },
) {}

export class Operability extends Context.Service<
  Operability,
  {
    readonly deploy: (
      request: DeployRequest,
    ) => Effect.Effect<OperabilityReport, OperabilityFailed>;
    /** The drift check alone: the rendered configuration against the template, the live Worker and the App. */
    readonly doctor: (overlay: string) => Effect.Effect<OperabilityReport, OperabilityFailed>;
  }
>()("@fractalboxdev/flare-dispatch-fd/Operability") {}

/**
 * The Layer the `fd-deploy` and `fd-doctor` executables run with until the operability area provides its own: a
 * deferred Layer, so each command says it is not installed rather than doing anything.
 */
export const OperabilityNotInstalled = Layer.succeed(Operability)({
  deploy: () =>
    Effect.fail(new OperabilityFailed({ message: "fd deploy is not installed in this bundle" })),
  doctor: () =>
    Effect.fail(new OperabilityFailed({ message: "fd doctor is not installed in this bundle" })),
});
