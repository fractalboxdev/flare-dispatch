// Device enrollment through mameko's `registerDevice` under the profile's `registration` (FD-IFC-086). The slots are
// the profile's device defaults; a refusal answers `registration_refused` naming the reason and writes no executor row
// (FD-IFC-087).
import { deviceSlotDefaults, type Profile } from "@fractalboxdev/flare-dispatch-profile";
import { registerDevice } from "@fractalboxdev/mameko-coordinator";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare";
import { cloudflareRuntimeLayer } from "@fractalboxdev/mameko-host-cloudflare/runtime";
import { Effect, Layer, Match } from "effect";
import { apiError } from "../errors.ts";
import { DeviceRegistry } from "../ports.ts";

export interface D1RegistryOptions {
  readonly db: D1Like;
  /** The epoch anchor's stub, as `cloudflareRuntimeLayer` takes it. */
  readonly anchor: Parameters<typeof cloudflareRuntimeLayer>[0]["anchor"];
  readonly profile: Profile;
  /** FlareDispatch's posture source (specs/architecture.md § Application ports). */
  readonly posture: (
    executorId: string,
  ) => Effect.Effect<"attested-dedicated" | "managed-workstation" | "unmanaged" | "failing">;
  /** FlareDispatch's attestation verifier; a profile whose registration requires one refuses every key without it. */
  readonly verify: ((publicKey: string, evidence: unknown) => Effect.Effect<boolean>) | undefined;
}

export const d1DeviceRegistry = (options: D1RegistryOptions): Layer.Layer<DeviceRegistry> =>
  Layer.succeed(DeviceRegistry)({
    register: (body) =>
      Effect.gen(function* () {
        const { interactive, batch } = deviceSlotDefaults.claim_caps;
        const result = yield* registerDevice(
          {
            executorId: body.executor_id,
            identity: {
              publicKey: body.identity.public_key,
              keyStore: body.identity.key_store,
              certificateChain: body.identity.certificate_chain,
              evidence: body.identity.evidence,
            },
            labels: body.labels,
            slots: { interactive, batch },
            protocolVersion: body.protocol_version,
            codeHash: body.code_hash,
          },
          {
            registration: options.profile.registration,
            now: Date.now(),
            posture: options.posture,
            // With no verifier, a profile whose registration requires attestation refuses every key.
            verify: options.verify ?? (() => Effect.succeed(false)),
          },
        ).pipe(Effect.provide(cloudflareRuntimeLayer({ db: options.db, anchor: options.anchor })));
        return yield* Match.value(result).pipe(
          Match.tag("Registered", ({ executorId, postureTier }) =>
            Effect.succeed({ executorId, postureTier }),
          ),
          Match.tag("Refused", ({ reason }) =>
            Effect.fail(apiError("registration_refused", `registration refused: ${reason}`)),
          ),
          Match.exhaustive,
        );
      }),
  });
