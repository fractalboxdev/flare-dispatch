// Deploy-probe verdicts, keyed by the Worker version that was probed.
//
// The key is the **deployment id**, not the semver in version.ts. A security
// release declares a minimum supported version against the semver (patch
// distribution, specs/platform.md), but the thing the canary attests to is a
// *build*: `pnpm update` inside the pinned range, a Dockerfile edit, or a
// re-deploy of unchanged source all produce a new Worker version with the same
// semver — and each of them can move the SDK internals ADR-0011 depends on.
// Keying by deployment id is what makes "verified" mean "verified for the code
// that is actually running".
//
// The record is also the rate limit. Running the canary costs a container, and
// the probe endpoints carry no credential (an operator running the BYOC health
// check must not need one), so a fresh verdict for the running deployment is
// returned from here instead of re-probing. That caps an anonymous caller at
// one container boot per deployment per re-verify window.
import type { CanaryStatus } from "./probe";

export type ProbeName = "canary" | "dogfood";

export type ProbeRecord = {
  deploymentId: string;
  probe: ProbeName;
  status: CanaryStatus;
  evidence: string;
  substrateVersion: string;
  checkedAt: number;
};

/**
 * How long a verdict stands before the probe runs again.
 *
 * `failed` is cached as long as `passed` deliberately: a failing canary means
 * the floor is broken, and the fix is a corrected deploy — which produces a new
 * deployment id and re-probes immediately. Re-running the probe against the
 * same broken build would only spend containers to learn the same fact.
 *
 * `inconclusive` is short because it is the only status that can be caused by
 * something transient (a cold image pull timing out, an artifacts mount
 * hiccup), and a stuck-inconclusive deployment is one nobody can verify.
 */
export const PROBE_REVERIFY_MS: Record<CanaryStatus, number> = {
  passed: 24 * 60 * 60_000,
  failed: 24 * 60 * 60_000,
  inconclusive: 10 * 60_000,
};

/** True while the recorded verdict still speaks for the running build. */
export function isProbeFresh(record: ProbeRecord | undefined, now: number): boolean {
  if (!record) return false;
  return now - record.checkedAt < PROBE_REVERIFY_MS[record.status];
}

export type ProbeStore = {
  read(deploymentId: string, probe: ProbeName): Promise<ProbeRecord | undefined>;
  record(entry: ProbeRecord): Promise<void>;
};

type Row = {
  deployment_id: string;
  probe: string;
  status: string;
  evidence: string;
  substrate_version: string;
  checked_at: number;
};

const STATUSES: readonly CanaryStatus[] = ["passed", "failed", "inconclusive"];

/**
 * A status the running code does not know is treated as no record at all — a
 * row written by a newer build must never be read as a pass by an older one.
 */
function toRecord(row: Row): ProbeRecord | undefined {
  const status = STATUSES.find((s) => s === row.status);
  if (!status) return undefined;
  return {
    deploymentId: row.deployment_id,
    probe: row.probe as ProbeName,
    status,
    evidence: row.evidence,
    substrateVersion: row.substrate_version,
    checkedAt: row.checked_at,
  };
}

export const makeProbeStoreD1 = (db: D1Database): ProbeStore => ({
  async read(deploymentId, probe) {
    const row = await db
      .prepare(
        `SELECT deployment_id, probe, status, evidence, substrate_version, checked_at
           FROM sub_deploy_probes WHERE deployment_id = ?1 AND probe = ?2`,
      )
      .bind(deploymentId, probe)
      .first<Row>();
    return row ? toRecord(row) : undefined;
  },

  async record(entry) {
    // Last writer wins on the (deployment, probe) pair: two concurrent probes
    // of one build agree by construction, and a re-probe after the re-verify
    // window must replace the verdict it superseded rather than accumulate.
    await db
      .prepare(
        `INSERT INTO sub_deploy_probes
           (deployment_id, probe, status, evidence, substrate_version, checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (deployment_id, probe) DO UPDATE SET
           status = excluded.status,
           evidence = excluded.evidence,
           substrate_version = excluded.substrate_version,
           checked_at = excluded.checked_at`,
      )
      .bind(
        entry.deploymentId,
        entry.probe,
        entry.status,
        entry.evidence,
        entry.substrateVersion,
        entry.checkedAt,
      )
      .run();
  },
});
