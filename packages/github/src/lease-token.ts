// The per-lease GitHub token: an installation token scoped to the one
// repository the execution targets and to read permissions only (FD-GH-002,
// MAMEKO-HOST-048). It expires no later than the lease's `deadline_at`.
import type { LeaseRef } from "@fractalboxdev/mameko-ports";
import { Effect } from "effect";
import { GithubApp, LEASE_READ_PERMISSIONS, type AppKeyInvalid } from "./app.ts";
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
