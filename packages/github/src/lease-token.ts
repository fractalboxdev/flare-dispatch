// The per-lease GitHub token: an installation token scoped to the one
// repository the execution targets and to read permissions only (FD-GH-002,
// MAMEKO-HOST-048). It expires no later than the lease's `deadline_at`. The
// credential minter port serves it for the source grant only, and revokes the
// tokens it minted for a lease through `DELETE /installation/token`.
import { CredentialMinter, type LeaseRef } from "@fractalboxdev/mameko-ports";
import { Clock, Effect, Layer, Match, Ref } from "effect";
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
 * The grants whose host is the GitHub source remote: mameko's `source-read` and the profile's `git-remote`
 * (specs/profile.md § Approval floor, egress profiles and signing purposes). The per-lease read token is the credential
 * for these grants and for no other.
 */
export const SOURCE_GRANTS = ["source-read", "git-remote"] as const;

interface HeldTokens {
  readonly deadlineAt: number;
  readonly tokens: readonly string[];
}

/**
 * mameko's credential minter port over the App. `mint` answers the per-lease read token of `leaseReadToken` for a
 * source grant (`SOURCE_GRANTS`); this deploy issues no other application credential, so a mint for any other grant is
 * a defect naming the grant, and no GitHub credential reaches a host that has no use for it. The port has no error
 * channel, so a mint GitHub refuses is a defect too: the lease grant fails rather than hand the executor no credential.
 *
 * `revoke` covers only the tokens this isolate minted for the lease, held in memory. A revoke served by another
 * isolate, or after this one is evicted, finds none and logs a warning; such a token stays valid until GitHub's
 * `expires_at`. A revoke GitHub refuses is logged for the same reason. Each mint drops the held tokens of leases whose
 * `deadline_at` has passed, so the map holds only live leases.
 */
export const credentialMinterLayer = (app: Pick<AppOptions, "fetch" | "baseUrl">) =>
  Layer.effect(
    CredentialMinter,
    Effect.gen(function* () {
      const services = yield* Effect.context<GithubApp | GithubRead>();
      const minted = yield* Ref.make<ReadonlyMap<string, HeldTokens>>(new Map());
      const mintSource = (lease: LeaseRef) =>
        Effect.gen(function* () {
          const token = yield* leaseReadToken(lease).pipe(Effect.provideContext(services));
          const now = yield* Clock.currentTimeMillis;
          yield* Ref.update(minted, (m) => {
            const live = new Map([...m].filter(([, held]) => held.deadlineAt > now));
            const key = leaseKey(lease);
            return live.set(key, {
              deadlineAt: lease.deadlineAt,
              tokens: [...(live.get(key)?.tokens ?? []), token.credential],
            });
          });
          return token;
        }).pipe(Effect.orDie);
      return {
        mint: (grant, lease) =>
          Match.value(grant).pipe(
            Match.when(Match.is(...SOURCE_GRANTS), () => mintSource(lease)),
            Match.orElse((g) =>
              Effect.die(
                new Error(`no application credential for grant ${g}: this deploy issues none`),
              ),
            ),
          ),
        revoke: (lease) =>
          Effect.gen(function* () {
            const held = yield* Ref.modify(minted, (m) => {
              const rest = new Map(m);
              rest.delete(leaseKey(lease));
              return [m.get(leaseKey(lease)), rest] as const;
            });
            if (held === undefined) {
              return yield* Effect.logWarning(
                "per-lease token not held by this isolate; valid until GitHub expires_at",
                { executionId: lease.executionId, epoch: lease.epoch },
              );
            }
            yield* Effect.forEach(
              held.tokens,
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
