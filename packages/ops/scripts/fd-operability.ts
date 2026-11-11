// `fd deploy` and `fd doctor` over the Operability service, for the deploy workflow:
//
//   node --experimental-strip-types packages/ops/scripts/fd-operability.ts deploy --overlay @file [--dry-run]
//   node --experimental-strip-types packages/ops/scripts/fd-operability.ts doctor --overlay @file [--alarm-on-drift]
//
// It reads `CLOUDFLARE_API_TOKEN`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_REPOSITORY` from the environment. With
// `--alarm-on-drift`, a failed drift check raises the notify alarm `drift` at the overlay's alert sink (FD-OPS-025).
import { Effect } from "effect";
import { makeOperability, operabilityCommand } from "../src/cli/operability.ts";

const service = makeOperability({ fail: (message) => new Error(message) });
const report = await Effect.runPromise(
  operabilityCommand(service, process.argv.slice(2), (message) => new Error(message)),
);
for (const s of report.stages) {
  console.log(`${s.ok ? "ok  " : "FAIL"} ${s.stage}`);
  if (s.detail !== "") for (const line of s.detail.split("\n")) console.log(`     ${line}`);
}
process.exit(report.ok ? 0 : 1);
