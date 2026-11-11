// `GET /v1/spend` over the deployed Worker: mameko's spend view of the current UTC month, read from the Worker's own
// D1 database and the deployment's profile at FlareDispatch's spend configuration (specs/spend.md § Spend view,
// specs/profile.md § Spend configuration).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATOR } from "../support.ts";
import { REPOSITORY, startStack, type Stack } from "./stack.ts";

/** A member of the Access team who is neither an operator nor a dispatcher. */
const VIEWER = "viewer@example.com";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.close();
});

const db = () => stack.mf.getD1Database("DB");

const spend = async (identity: string | null) =>
  fetch(`${stack.url}/v1/spend`, {
    headers: { accept: "application/json", ...(await stack.access(identity)) },
  });

const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7);

/** The first instant of the UTC month `offset` months from the one `at` falls in. */
const monthStart = (at: number, offset: number) => {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1);
};

describe("GET /v1/spend", () => {
  it("[FD-SPD-057] answers an Access identity with the spend view of the current UTC month", async () => {
    // The first request migrates the store; with no Access JWT it is refused.
    const refused = await spend(null);
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: string }).error).toBe("unauthenticated");

    // One open hold on an admitted execution, and settled spend in this month and the month before.
    const dispatched = await fetch(`${stack.url}/v1/dispatch/check`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await stack.access(OPERATOR)) },
      body: JSON.stringify({
        repository: REPOSITORY,
        sha: "9".repeat(40),
        inputs: {
          repo: `https://github.com/${REPOSITORY}`,
          sha: "9".repeat(40),
          ref: "refs/heads/main",
          steps: [{ label: "test", command: "pnpm test" }],
        },
      }),
    });
    expect(dispatched.status).toBe(202);
    const { execution_id: executionId } = (await dispatched.json()) as { execution_id: string };
    const [execution] = (
      await (
        await db()
      )
        .prepare("select class from executions where id = ?")
        .bind(executionId)
        .all()
    ).results as { class: string }[];
    const held = execution!.class;

    const now = Date.now();
    const month = monthOf(now);
    const store = await db();
    await store
      .prepare(
        `insert into reservations (execution_id, class, hold_micro_usd, state, updated_at)
         values (?, ?, 250000, 'held', ?)
         on conflict (execution_id) do update set hold_micro_usd = 250000, state = 'held'`,
      )
      .bind(executionId, held, now)
      .run();
    await store
      .prepare(
        "insert into spend_month (month, settled_micro_usd) values (?, 3000000), (?, 7000000)",
      )
      .bind(month, monthOf(monthStart(now, -1)))
      .run();

    const r = await spend(VIEWER);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    // B = 50, R(release) = 10 and R_m = R_m,min = 20 USD, so G = 20 USD: `batch` at 0.45 G with φ = 0.1 G.
    const lines: Record<string, { line: number; lane: number; reserve: number | null }> = {
      release: { line: 50_000_000, lane: 2_820_000, reserve: 10_000_000 },
      required: { line: 40_000_000, lane: 2_010_000, reserve: 20_000_000 },
      interactive: { line: 20_000_000, lane: 810_000, reserve: 0 },
      batch: { line: 9_000_000, lane: 410_000, reserve: null },
    };
    expect(body).toEqual({
      month,
      budget: 50_000_000,
      // This month's settled spend only; the month before's does not count.
      settled: 3_000_000,
      reserved: 250_000,
      committed: 3_250_000,
      classes: Object.entries(lines).map(([name, l]) => ({
        class: name,
        ...l,
        // Every executor of this deploy is a device, which counts at 0.
        admitted_list_rate: 0,
      })),
      floor: 2_000_000,
      measured_reserve_runway_days: null,
      control_state: "run",
      resets_at: monthStart(now, 1),
    });
    expect(held in lines).toBe(true);
  });
});
