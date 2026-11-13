// A deploy holding the GitHub App over a test D1: the isolate's services as the composition builds them, a parent
// execution, and an `ExecutionEngine` binding that records each workflow start.
import { generateKeyPairSync } from "node:crypto";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import type { ExecutionPayload } from "@fractalboxdev/mameko-coordinator";
import type { ActuatorRateLimit, Actuators, IntentRow } from "@fractalboxdev/mameko-ports";
import type { Context } from "effect";
import { isolateServices, type IsolateServices } from "../src/composition.ts";
import { envOf, seedExecution, type TestD1 } from "./conclude.test-support.ts";

export const PARENT = "01PARENTEXECUTION0000000000";
export const INTENT_KEY = "deploy-smoke:0";
export const SMOKE_INPUTS = { scope: "acme/app", sha: "b".repeat(40), hosts: ["app.example.com"] };

/** The `dispatch.followOn` row a `worker-deploy` execution writes for `deploy-smoke` on its commit. */
export const followOnRow = (overrides: Partial<IntentRow> = {}): IntentRow => ({
  executionId: PARENT,
  scopeId: "acme/app",
  intentKey: INTENT_KEY,
  kind: "dispatch.followOn",
  payload: { run: "deploy-smoke", inputs: SMOKE_INPUTS },
  payloadDigest: "d",
  effectClass: "replay-safe",
  attempts: 0,
  ...overrides,
});

export interface AppDeploy {
  readonly db: TestD1;
  readonly starts: ExecutionPayload[];
  /** A deploy with the App serves the actuators and their rate limit beside the services every deploy has. */
  readonly services: Context.Context<IsolateServices | Actuators | ActuatorRateLimit>;
  /** Every execution intake recorded other than the parent. */
  readonly children: () => readonly { execution_id: string; run: string; sha: string }[];
}

export const appDeploy = async (): Promise<AppDeploy> => {
  const db = await migratedD1();
  await seedExecution(db, PARENT, "success");
  const starts: ExecutionPayload[] = [];
  const execution = {
    idFromName: (name: string) => name,
    get: () => ({
      start: async (payload: ExecutionPayload) => {
        starts.push(payload);
      },
      cancel: async () => {},
    }),
  };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = Object.assign(
    envOf(db, {
      GITHUB_APP_ID: "4242",
      GITHUB_APP_SLUG: "flare-dispatch-test",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }),
    { EXECUTION: execution },
  );
  return {
    db,
    starts,
    services: (await isolateServices(env)) as Context.Context<
      IsolateServices | Actuators | ActuatorRateLimit
    >,
    children: () =>
      db.sqlite
        .prepare(
          "select execution_id, run, sha from intake_records where execution_id <> ? order by execution_id",
        )
        .all(PARENT) as unknown as { execution_id: string; run: string; sha: string }[],
  };
};
