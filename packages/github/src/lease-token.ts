// The per-lease GitHub token: an installation token scoped to the one
// repository the execution targets and to read permissions only (FD-GH-002,
// MAMEKO-HOST-048). It expires no later than the lease's `deadline_at`. The
// credential minter port serves it for every grant a lease names, and revokes
// the tokens it minted for a lease through `DELETE /installation/token`.
import { CredentialMinter, type LeaseRef } from "@fractalboxdev/mameko-ports";
import { Effect, Layer, Ref } from "effect";
import {
  appCall,
  GithubApp,
  LEASE_READ_PERMISSIONS,
  type AppKeyInvalid,
  type AppOptions,
} from "./app.ts";
import { GithubRead, type GithubReadError } from "./read.ts";

export interface LeaseCredential {
  readonly credential: string;
  /** Epoch ms: the earlier of GitHub's `expires_at` and the lease's `deadline_at`. */
  readonly expiresAt: number;
}

export const leaseReadToken = (
  lease: LeaseRef,
): Effect.Effect<LeaseCredential, GithubReadError | AppKeyInvalid, GithubApp | GithubRead> =>
  Effect.gen(function* () {
    const app = yield* GithubApp;
    const read = yield* GithubRead;
    const installation = yield* read.installation(lease.scopeId);
    const name = lease.scopeId.slice(lease.scopeId.indexOf("/") + 1);
    const minted = yield* app.token(installation, {
      scope: { repositories: [name], permissions: LEASE_READ_PERMISSIONS },
    });
    return { credential: minted.token, expiresAt: Math.min(minted.expiresAt, lease.deadlineAt) };
  });

const leaseKey = (lease: LeaseRef) => `${lease.executionId}:${lease.epoch}`;

/**
 * mameko's credential minter port over the App: `mint` answers the per-lease read token of `leaseReadToken` whatever
 * grant the lease names, since that token is the one application credential this deploy issues, and `revoke` revokes
 * every token the isolate minted for the lease. The port has no error channel, so a mint GitHub refuses is a defect and
 * the lease grant fails rather than hand the executor no credential; a revoke GitHub refuses is logged, since the token
 * still expires at GitHub's `expires_at`.
 */
export const credentialMinterLayer = (app: Pick<AppOptions, "fetch" | "baseUrl">) =>
  Layer.effect(
    CredentialMinter,
    Effect.gen(function* () {
      const services = yield* Effect.context<GithubApp | GithubRead>();
      const minted = yield* Ref.make<ReadonlyMap<string, readonly string[]>>(new Map());
      return {
        mint: (_grant, lease) =>
          Effect.gen(function* () {
            const token = yield* leaseReadToken(lease).pipe(Effect.provideContext(services));
            yield* Ref.update(minted, (m) =>
              new Map(m).set(leaseKey(lease), [
                ...(m.get(leaseKey(lease)) ?? []),
                token.credential,
              ]),
            );
            return token;
          }).pipe(Effect.orDie),
        revoke: (lease) =>
          Effect.gen(function* () {
            const tokens = yield* Ref.modify(minted, (m) => {
              const rest = new Map(m);
              rest.delete(leaseKey(lease));
              return [m.get(leaseKey(lease)) ?? [], rest] as const;
            });
            yield* Effect.forEach(
              tokens,
              (token) =>
                appCall(app, `Bearer ${token}`, "DELETE", "/installation/token").pipe(
                  Effect.flatMap(({ status }) =>
                    status === 204 || status === 401
                      ? Effect.void
                      : Effect.logWarning("per-lease token not revoked", {
                          executionId: lease.executionId,
                          status,
                        }),
                  ),
                  Effect.catch((e) =>
                    Effect.logWarning("per-lease token not revoked", {
                      executionId: lease.executionId,
                      reason: e.message,
                    }),
                  ),
                ),
              { discard: true },
            );
          }),
      };
    }),
  );
