import { AlarmPort, type Alarm } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditRequestFor, recordAuditVerdict, VERDICT_AUDIT_SCHEMA, type ConcludedExecution } from "./audit.ts";
import { startMiniflare } from "./support.test-support.ts";

let mf: Awaited<ReturnType<typeof startMiniflare>>;
beforeAll(async () => {
  mf = await startMiniflare();
  await mf.db.prepare(VERDICT_AUDIT_SCHEMA).run();
});
afterAll(async () => mf?.mf.dispose());

const device: ConcludedExecution = {
  executionId: "dev-exec",
  executorId: "dev-1",
  executorKind: "device",
  run: "check",
  commit: "a".repeat(40),
  inputs: { suite: "unit" },
  verdict: "success",
};
const audit: ConcludedExecution = { ...device, executionId: "audit-exec", executorId: "cf-1", executorKind: "cloudflare" };

describe("verdict audit", () => {
  it("[FD-PROV-069] a device execution of a gate recipe is audited with probability audit_rate as a cloud ops run", () => {
    expect(auditRequestFor(device, { random: () => 0.049 })).toEqual({
      run: "check",
      commit: device.commit,
      inputs: device.inputs,
      ops_run: true,
      constraints: ["cloud-only"],
      audits: "dev-exec",
    });
    expect(auditRequestFor(device, { random: () => 0.05 })).toBeNull();
    expect(auditRequestFor(device, { random: () => 0.2, auditRate: 0.25 })).not.toBeNull();
    expect(auditRequestFor({ ...device, executorKind: "cloudflare" }, { random: () => 0 })).toBeNull();
    expect(auditRequestFor({ ...device, run: "pr-review" }, { random: () => 0 })).toBeNull();
    let selected = 0;
    let seed = 7;
    const lcg = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 20_000; i++) if (auditRequestFor(device, { random: lcg }) !== null) selected++;
    expect(selected / 20_000).toBeGreaterThan(0.04);
    expect(selected / 20_000).toBeLessThan(0.06);
  });

  it("[FD-PROV-070] a disagreement writes a verdict_audits row naming both and raises a notify alarm; agreement writes nothing", async () => {
    const alarms: Alarm[] = [];
    const layer = Layer.succeed(AlarmPort, { deliver: (a: Alarm) => Effect.sync(() => void alarms.push(a)) });
    expect(await Effect.runPromise(recordAuditVerdict(mf.db, device, audit, 1).pipe(Effect.provide(layer)))).toBe("agree");
    expect(alarms).toHaveLength(0);
    const differs = { ...audit, verdict: "failure" };
    expect(await Effect.runPromise(recordAuditVerdict(mf.db, device, differs, 2).pipe(Effect.provide(layer)))).toBe("disagree");
    const rows = await mf.db.prepare("select * from verdict_audits").all();
    expect(rows.results).toEqual([
      {
        device_execution_id: "dev-exec",
        device_executor_id: "dev-1",
        audit_execution_id: "audit-exec",
        audit_executor_id: "cf-1",
        device_verdict: "success",
        audit_verdict: "failure",
        recorded_at: 2,
      },
    ]);
    expect(alarms).toMatchObject([{ severity: "notify", state: "raised", name: "verdict-audit-disagreement" }]);
  });
});
