// Per-execution egress denial events (specs/adr/0005-deny-all-egress-with-grant-profiles.md).
//
// Every denial is aggregated as `{host, method, path, reason, count}` keyed by
// container id, retrievable with the execution's artifacts (facade `denials()`)
// and never surfaced into the container (oracle resistance). Both halves land
// here: the egress handler's own 403s, and the platform's 520s for hosts that
// die at the container gate before any handler runs — those come from the
// outbound proxy (../outbound-proxy.ts), which is the only place they are
// observable. Recording is fire-and-forget on both paths: it must never delay
// or fail a denial.
import type { DenialEvent } from "@fractalboxdev/flare-dispatch-substrate-contract";

export const recordDenialD1 = async (
  db: D1Database,
  containerId: string,
  event: Omit<DenialEvent, "count">,
  now: number = Date.now(),
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO sub_denials (container_id, host, method, path, reason, count, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
       ON CONFLICT (container_id, host, method, path, reason)
       DO UPDATE SET count = count + 1, updated_at = ?6`,
    )
    .bind(containerId, event.host, event.method, event.path, event.reason, now)
    .run();
};

export const denialsFor = async (
  db: D1Database,
  containerId: string,
): Promise<DenialEvent[]> => {
  const rows = await db
    .prepare(
      `SELECT host, method, path, reason, count FROM sub_denials
        WHERE container_id = ? ORDER BY count DESC, host, path`,
    )
    .bind(containerId)
    .all<DenialEvent>();
  return rows.results;
};
