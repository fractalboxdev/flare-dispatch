// `fd deploy` and `fd doctor` over the Operability service, for the deploy workflow:
//
//   node --experimental-strip-types packages/ops/scripts/fd-operability.ts deploy --overlay @file [--dry-run]
//   node --experimental-strip-types packages/ops/scripts/fd-operability.ts doctor --overlay @file [--alarm-on-drift]
//
// It reads `CLOUDFLARE_API_TOKEN`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_REPOSITORY` from the environment. With
// `--alarm-on-drift`, a failed drift check raises the notify alarm `drift` at the overlay's alert sink (FD-OPS-025).
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { alarmMessage } from "../src/alarms.ts";
import { makeOperability } from "../src/cli/operability.ts";
import { args } from "./repo.ts";

const [command] = process.argv.slice(2);
const opts = args(process.argv.slice(3));
const raw = opts.get("overlay") ?? "";
const overlay = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
const service = makeOperability({ fail: (message) => new Error(message) });

const program =
  command === "deploy"
    ? service.deploy({ overlay, dryRun: opts.has("dry-run") })
    : command === "doctor"
      ? service.doctor(overlay)
      : Effect.fail(new Error(`unknown command ${command ?? ""}; use deploy or doctor`));

const report = await Effect.runPromise(program);
for (const s of report.stages) {
  console.log(`${s.ok ? "ok  " : "FAIL"} ${s.stage}`);
  if (s.detail !== "") for (const line of s.detail.split("\n")) console.log(`     ${line}`);
}

if (!report.ok && command === "doctor" && opts.has("alarm-on-drift")) {
  const sink = (JSON.parse(overlay) as { alerts?: { sink?: string } }).alerts?.sink ?? "";
  const detail = report.stages.find((s) => !s.ok)?.detail ?? "";
  const alarm = {
    name: "drift",
    severity: "notify" as const,
    dedupeKey: "drift",
    state: "raised" as const,
    detail,
  };
  if (sink.startsWith("https://"))
    await fetch(sink, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alarm: "drift",
        severity: "notify",
        state: "raised",
        dedupe_key: "drift",
        runbook: null,
        detail,
        message: alarmMessage(alarm),
      }),
    });
  else console.error(alarmMessage(alarm));
}
process.exit(report.ok ? 0 : 1);
