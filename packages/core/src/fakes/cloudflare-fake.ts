// @fractalboxdev/flare-dispatch-core — Cloudflare fake (read-only Cloudflare API).
//
// In-memory fake of the `cloudflare` capability. Tests seed `deployments` and
// the service applies the documented filters (projects allow-list, status,
// environment, created-age) and returns the surviving rows. Calls are recorded
// for assertions.
//
// A test that wants `cloudflare` to fail with `CloudflareApiError` constructs
// its own failing `Cloudflare` Layer — the fake is the green-path simulator.

import { Effect, Layer } from "effect";
import {
  Cloudflare,
  type CloudflareService,
  type CloudflareUsage,
  type DeploymentRef,
} from "../services/cloudflare";

export type CloudflareFakeState = {
  /** Seeded deployments — returned by `deployments` (after filtering). */
  deployments: DeploymentRef[];
  /** Seeded usage snapshot — returned by `usage`. */
  usage: CloudflareUsage;
  /** Every `deployments` call, in order. */
  readonly deploymentsCalls: Array<{
    projects?: readonly string[];
    environment?: string;
    status?: string;
    createdWithinHours?: number;
  }>;
  /** Every `usage` call's `windowHours`, in order. */
  readonly usageCalls: Array<{ windowHours?: number }>;
};

/** Default reference clock — fakes use this when callers don't override. */
const NOW_DEFAULT = 1_700_000_000_000;

const EMPTY_USAGE: CloudflareUsage = { windowHours: 168, workers: [], ai: [] };

export const makeCloudflareFake = (
  opts: {
    deployments?: readonly DeploymentRef[];
    /** Seeded usage snapshot — `usage` returns this verbatim. */
    usage?: CloudflareUsage;
    /** Clock used to evaluate `createdWithinHours`. */
    now?: number;
  } = {},
): { layer: Layer.Layer<Cloudflare>; state: CloudflareFakeState } => {
  const state: CloudflareFakeState = {
    deployments: [...(opts.deployments ?? [])],
    usage: opts.usage ?? EMPTY_USAGE,
    deploymentsCalls: [],
    usageCalls: [],
  };
  const now = opts.now ?? NOW_DEFAULT;

  const service: CloudflareService = {
    usage: ({ windowHours } = {}) =>
      Effect.sync(() => {
        state.usageCalls.push({ windowHours });
        return state.usage;
      }),
    deployments: ({ projects, environment, status, createdWithinHours } = {}) =>
      Effect.sync(() => {
        state.deploymentsCalls.push({
          projects,
          environment,
          status,
          createdWithinHours,
        });
        const allow = projects === undefined ? undefined : new Set(projects);
        return state.deployments.filter((d) => {
          if (allow !== undefined && !allow.has(d.project)) return false;
          if (environment !== undefined && d.environment !== environment)
            return false;
          if (status !== undefined && d.status !== status) return false;
          if (createdWithinHours !== undefined) {
            const cutoff = now - createdWithinHours * 3_600_000;
            if (d.createdAt < cutoff) return false;
          }
          return true;
        });
      }),
  };

  return { layer: Layer.succeed(Cloudflare, service), state };
};

/** A ready-to-use Cloudflare fake Layer — empty deployments. */
export const CloudflareFake: Layer.Layer<Cloudflare> = makeCloudflareFake().layer;
