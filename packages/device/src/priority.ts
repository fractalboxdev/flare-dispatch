// Each class's job-sandbox CPU priority on a device, from the class catalogue's device-eligible ranks
// (FD-EXEC-059, MAMEKO-EXEC-055).
import type { Profile } from "@fractalboxdev/flare-dispatch-profile";

export type AppleQos = "user-initiated" | "utility" | "background";

/** The CPU priorities of one job runtime: the Apple QoS classes, or the cgroup CPU weights under `oci-engine`. */
export interface RuntimePriority {
  readonly "apple-container": AppleQos;
  readonly "oci-engine": 1000 | 100 | 10;
}

const HIGH: RuntimePriority = { "apple-container": "user-initiated", "oci-engine": 1000 };
const MEDIUM: RuntimePriority = { "apple-container": "utility", "oci-engine": 100 };
const LOW: RuntimePriority = { "apple-container": "background", "oci-engine": 10 };

/** The marker of a capacity-lease sandbox, which always starts at low. */
export const CAPACITY_LEASE = "capacity-lease";

/**
 * The priority of a class's job sandbox: high for the highest device-eligible rank of the catalogue, low for the
 * lowest and medium between; a capacity-lease sandbox is low. A class whose claim deadline is `none` never runs on a
 * device and has no priority.
 */
export const cpuPriority = (
  profile: Pick<Profile, "classes">,
  className: string,
): RuntimePriority | null => {
  if (className === CAPACITY_LEASE) return LOW;
  const eligible = profile.classes.filter((c) => c.claim_deadline !== "none");
  const cls = eligible.find((c) => c.name === className);
  if (cls === undefined) return null;
  const ranks = eligible.map((c) => c.rank);
  if (cls.rank === Math.min(...ranks)) return HIGH;
  if (cls.rank === Math.max(...ranks)) return LOW;
  return MEDIUM;
};
