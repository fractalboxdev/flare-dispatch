// The `profile-reference` job (specs/verification.md FD-VER-033, specs/profile.md FD-PROF-002): the production document
// of each phase against mameko's reference CI profile at the pinned commit, failing on any difference the profile's
// § Differences from the reference CI profile does not list.
//
//   node --experimental-strip-types packages/ops/scripts/profile-reference.ts
import {
  buildProfile,
  unlistedDifferences,
  type Phase,
} from "@fractalboxdev/flare-dispatch-profile";

let failures = 0;
for (const phase of [0, 1, 2, 3, 4] as const satisfies readonly Phase[]) {
  const differences = unlistedDifferences(buildProfile("production", phase), phase);
  for (const d of differences)
    console.log(
      `phase ${phase} ${d.path}: reference ${JSON.stringify(d.reference)}, FlareDispatch ${JSON.stringify(d.flareDispatch)}`,
    );
  failures += differences.length;
}
console.log(`profile-reference: ${failures} unlisted difference(s)`);
process.exit(failures === 0 ? 0 : 1);
