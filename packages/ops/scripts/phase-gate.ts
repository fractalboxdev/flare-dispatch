// The `phase-gate` job (specs/verification.md FD-VER-026 to FD-VER-031):
//
//   node --experimental-strip-types packages/ops/scripts/phase-gate.ts --base <ref> --fetch --records <file.json>
//   node --experimental-strip-types packages/ops/scripts/phase-gate.ts --base <ref> [--records <file.json>]
//
// Both exit 0 at once when `.github/phase` does not move. With `--fetch`, it reads the records of gate n from the
// control plane the deploy workflow targets — `GET /v1/ops/phase-gate?gate=<n>` on the dispatcher hostname of the
// `FD_OPERATOR_OVERLAY` overlay, with the Access service token in `FD_ACCESS_CLIENT_ID` and `FD_ACCESS_CLIENT_SECRET`
// — writes them to the records file and exits non-zero when it cannot. Without it, the gate passes only when the
// phase moves from n to n + 1 and every condition holds. The records file holds `{ measures, pageAlarms, killLines,
// windowEnd }` from the control plane and, optionally, `nightly`; a condition with no record fails.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Exit, Schema } from "effect";
import { phaseGate, type PhaseGateInput } from "../src/verification/phase-gate.ts";
import {
  fetchPhaseGateRecords,
  pageAlarmRecords,
  type PageAlarmEpisode,
} from "../src/verification/records.ts";
import { allRequirements, harnessEntries } from "../src/verification/spec-tags.ts";
import { args, readAt, readSpecs, readTree, ROOT } from "./repo.ts";

const opts = args(process.argv.slice(2));
const base = opts.get("base");
if (base === undefined) {
  console.error("--base <ref> names the pull request's base commit");
  process.exit(2);
}
const from = Number((readAt(base, ".github/phase") ?? "").trim());
const to = Number(readFileSync(join(ROOT, ".github/phase"), "utf8").trim());
if (from === to) {
  console.log(`phase-gate: .github/phase stays at ${to}; nothing to gate`);
  process.exit(0);
}
const recordsPath = opts.get("records");

if (opts.has("fetch")) {
  if (recordsPath === undefined) {
    console.error("--fetch writes the records file --records names");
    process.exit(2);
  }
  const Overlay = Schema.Struct({ hostnames: Schema.Struct({ dispatcher: Schema.String }) });
  const overlay = Schema.decodeUnknownExit(Overlay)(
    (() => {
      try {
        return JSON.parse(process.env["FD_OPERATOR_OVERLAY"] ?? "") as unknown;
      } catch {
        return null;
      }
    })(),
  );
  const clientId = process.env["FD_ACCESS_CLIENT_ID"] ?? "";
  const clientSecret = process.env["FD_ACCESS_CLIENT_SECRET"] ?? "";
  if (!Exit.isSuccess(overlay) || clientId === "" || clientSecret === "") {
    console.error(
      "::error::the phase-gate records need FD_OPERATOR_OVERLAY with hostnames.dispatcher, FD_ACCESS_CLIENT_ID and FD_ACCESS_CLIENT_SECRET",
    );
    process.exit(1);
  }
  const fetched = await Effect.runPromise(
    fetchPhaseGateRecords(
      { origin: `https://${overlay.value.hostnames.dispatcher}`, clientId, clientSecret },
      from,
    ).pipe(
      Effect.match({
        onFailure: (e) => ({ ok: false as const, reason: e.reason }),
        onSuccess: (records) => ({ ok: true as const, records }),
      }),
    ),
  );
  if (!fetched.ok) {
    console.error(
      `::error::the phase-gate records of gate ${from} could not be read: ${fetched.reason}`,
    );
    process.exit(1);
  }
  mkdirSync(dirname(recordsPath), { recursive: true });
  writeFileSync(recordsPath, `${JSON.stringify(fetched.records, null, 2)}\n`);
  console.log(
    `phase-gate: wrote the records of gate ${from} (${fetched.records.measures.length} measure(s), ${fetched.records.pageAlarms.length} page alarm(s)) to ${recordsPath}`,
  );
  process.exit(0);
}

const records = (
  recordsPath !== undefined && existsSync(recordsPath)
    ? JSON.parse(readFileSync(recordsPath, "utf8"))
    : {}
) as Partial<
  Pick<PhaseGateInput, "nightly" | "measures" | "alarms" | "killLines" | "windowEnd">
> & {
  readonly pageAlarms?: readonly PageAlarmEpisode[];
};
const requirements = allRequirements(readSpecs());
const files = readTree(ROOT, (p) => p.endsWith(".test.ts") || p.startsWith("formal/"));
const findings = phaseGate({
  from,
  to,
  requirements,
  passing: [...files].flatMap(([path, text]) => harnessEntries(path, text)),
  nightly: records.nightly ?? {},
  measures: records.measures ?? null,
  alarms:
    records.pageAlarms !== undefined
      ? pageAlarmRecords(records.pageAlarms, requirements)
      : (records.alarms ?? null),
  killLines: records.killLines ?? null,
  windowEnd: records.windowEnd ?? Date.now(),
});
for (const f of findings) console.log(`${f.check} ${f.message}`);
console.log(`phase-gate ${from} → ${to}: ${findings.length} finding(s)`);
process.exit(findings.length === 0 ? 0 : 1);
