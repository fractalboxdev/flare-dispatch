// The executor values of an agentic or scan lease (specs/runs/agentic.md § Model, specs/runs/gate.md § Security gate):
// what the Container pool's runner builds the run's per-lease Layers from. The control plane writes them into the
// lease's input under `cloudLease`, the one lease field the run payload carries to the run, and drops any value a
// request recorded there, as it does a `worker-deploy` deploy claim.
//
// - An agentic lease carries the model route and the origin of the dispatcher's public origin, and none on a deploy
//   that names no `PUBLIC_ORIGIN`.
// - A scan lease carries `scan.bundleDigest` with a presigned read of `cas/<digest>`, `scan.advisoryMaxAgeHours`, and
//   each recorded advisory snapshot of `scan.advisoryEcosystems` with a presigned read of its archive, each read valid
//   for the presigner's URL lifetime and never past the lease's `deadline_at`. The job reaches them through the Container's object-store pass, never through a
//   grant (FD-GATE-110). A deploy without the presigner signs none, so the scan records its bundle or snapshot missing.
import type { AgentLease } from "@fractalboxdev/flare-dispatch-agentic";
import { MAX_URL_LIFETIME_MS } from "@fractalboxdev/flare-dispatch-cache";
import { contentObjectKey } from "@fractalboxdev/flare-dispatch-cache/namespaces";
import {
  MODEL_GATEWAY_PATH,
  type CatalogEntry,
  type LeasedAdvisory,
  type ScanLease,
} from "@fractalboxdev/flare-dispatch-catalog";
import { readSnapshotRecord } from "@fractalboxdev/flare-dispatch-ops";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { ConfigInvalid } from "@fractalboxdev/flare-dispatch-api/config";
import { advisoryEcosystemsOf, advisoryMaxAgeHoursOf, type ControlPlaneEnv } from "./config.ts";

/** The lease input key the executor values travel under. */
export const CLOUD_LEASE_KEY = "cloudLease";

/** The model route a job's model client posts to (specs/interfaces.md § Surfaces and their identity gates). */
export const MODEL_COMPLETIONS_PATH = `${MODEL_GATEWAY_PATH}completions`;

/** A presigned `GET` of one object, valid until `expiresAt`; null where the deploy signs none. */
export type PresignRead = (
  key: string,
  expiresAt: number,
) => Promise<{ readonly url: string } | null>;

/** The bindings the executor values read. */
export type CloudLeaseEnv = Pick<
  ControlPlaneEnv,
  "PUBLIC_ORIGIN" | "SCAN_BUNDLE_DIGEST" | "ADVISORY_ECOSYSTEMS" | "ADVISORY_MAX_AGE_HOURS"
> & { readonly DB: D1Like };

const isScanEntry = (entry: Pick<CatalogEntry, "manifestKey">) =>
  entry.manifestKey === "securityGate";

const originOf = (env: Pick<ControlPlaneEnv, "PUBLIC_ORIGIN">): string | undefined => {
  const origin = env.PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  return origin === undefined || origin === "" ? undefined : origin;
};

/** An agentic lease's values: the dispatcher's model route and origin, or none without a public origin. */
export const agentLeaseOf = (env: Pick<ControlPlaneEnv, "PUBLIC_ORIGIN">): AgentLease | null => {
  const origin = originOf(env);
  return origin === undefined
    ? null
    : { modelGatewayUrl: `${origin}${MODEL_COMPLETIONS_PATH}`, controlPlaneUrl: origin };
};

/**
 * A scan lease's values, or none where `scan.advisoryMaxAgeHours` or `scan.advisoryEcosystems` is malformed, so a
 * malformed setting widens no window. An ecosystem with no readable recorded snapshot, or whose archive the deploy
 * cannot sign a read for, is left out, so the scan records it missing where the range changes its lockfile
 * (FD-GATE-106).
 */
export const scanLeaseOf = async (
  env: CloudLeaseEnv,
  lease: { readonly deadlineAt: number; readonly now: number },
  presign: PresignRead,
): Promise<ScanLease | null> => {
  const expiresAt = Math.min(lease.now + MAX_URL_LIFETIME_MS, lease.deadlineAt);
  const maxAge = advisoryMaxAgeHoursOf(env);
  const ecosystems = advisoryEcosystemsOf(env);
  if (maxAge instanceof ConfigInvalid || ecosystems instanceof ConfigInvalid) return null;
  const digest = env.SCAN_BUNDLE_DIGEST?.trim();
  const pinned = digest === undefined || digest === "" ? undefined : digest;
  const bundle = pinned === undefined ? null : await presign(contentObjectKey(pinned), expiresAt);
  const advisories: LeasedAdvisory[] = [];
  for (const ecosystem of ecosystems) {
    // An unreadable record leaves the ecosystem out, which the scan records as missing, never as covered.
    const record = await readSnapshotRecord(env.DB, ecosystem).catch(() => null);
    if (record === null) continue;
    const read = await presign(contentObjectKey(record.digest), expiresAt);
    if (read === null) continue;
    advisories.push({
      ecosystem,
      digest: record.digest,
      lastModified: record.lastModified,
      url: read.url,
    });
  }
  return {
    ...(pinned === undefined ? {} : { bundleDigest: pinned }),
    ...(bundle === null ? {} : { bundleUrl: bundle.url }),
    advisoryMaxAgeHours: maxAge,
    advisories,
  };
};

/** A lease's executor values: an agentic recipe's or a scan run's, built at `now`; null for any other run. */
export const leaseCloudValues = (
  env: CloudLeaseEnv,
  entry: Pick<CatalogEntry, "agentic" | "manifestKey"> | null,
  lease: { readonly deadlineAt: number; readonly now: number },
  presign: PresignRead,
): Promise<AgentLease | ScanLease | null> =>
  entry === null
    ? Promise.resolve(null)
    : entry.agentic !== undefined
      ? Promise.resolve(agentLeaseOf(env))
      : isScanEntry(entry)
        ? scanLeaseOf(env, lease, presign)
        : Promise.resolve(null);

/**
 * An agentic or scan lease's input: the recorded input without any `cloudLease` it carries, with the control plane's
 * own where it writes one. Any other run's input is unchanged.
 */
export const withCloudLease = (
  entry: Pick<CatalogEntry, "agentic" | "manifestKey"> | null,
  inputs: unknown,
  values: AgentLease | ScanLease | null,
): unknown => {
  if (entry === null || (entry.agentic === undefined && !isScanEntry(entry))) return inputs;
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) return inputs;
  const { [CLOUD_LEASE_KEY]: _recorded, ...rest } = inputs as Readonly<Record<string, unknown>>;
  return values === null ? rest : { ...rest, [CLOUD_LEASE_KEY]: values };
};
