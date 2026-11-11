// What an executor holds on the cloud path with the GitHub App (specs/architecture.md § Credentials): the Worker holds
// an App key and the fixture server answers GitHub from the recorded state of `fixtures/intake-github.json`. A device
// claims a pull request execution's lease from the deployed Worker while the Worker reads and writes GitHub through
// installation tokens of its own; the test reads every frame the device received against every token GitHub minted.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, hello, newDevice, OPERATOR, registration, type Socket } from "../support.ts";
import type { GithubState, MintedToken } from "./fixtures/github-server.ts";
import { PLANE_ID, startStack, WEBHOOK_SECRET, type Stack } from "./stack.ts";

const RECORDED = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/intake-github.json"), "utf8"),
) as GithubState;

const WIDGETS = "acme/widgets";
/** Every credential shape GitHub issues: installation, user, OAuth, refresh and personal access tokens. */
const GITHUB_CREDENTIAL = /\b(?:gh[opsur]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g;

/** The 15-minute probes push a canary; a tick outside their minute drains and runs the units only. */
const PROBE_INTERVAL_MS = 15 * 60_000;

let stack: Stack;
let device: Socket;
let executionId: string;
let lease: Record<string, unknown>;

/** One minute tick through the Worker's `scheduled` handler, at a time no earlier than any row's insertion. */
const tick = async () => {
  let at = Date.now() + 1_000;
  if (at % PROBE_INTERVAL_MS < 60_000) at += 60_000;
  const worker = await stack.mf.getWorker();
  await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date(at) });
  const db = await stack.mf.getD1Database("DB");
  await expect
    .poll(
      async () => (await db.prepare("select at from fd_liveness where key = 'tick'").all()).results,
    )
    .toEqual([{ at }]);
};

/** A token that reads the execution's one repository and writes nothing: the per-lease token of FD-GH-002. */
const isPerLeaseReadToken = (minted: MintedToken) =>
  minted.repositories !== null &&
  minted.repositories.length === 1 &&
  minted.repositories[0] === WIDGETS.slice(WIDGETS.indexOf("/") + 1) &&
  minted.permissions !== null &&
  Object.values(minted.permissions).every((p) => p === "read");

beforeAll(async () => {
  stack = await startStack({ github: RECORDED });
  const { identity, keys } = await newDevice();
  const enrolled = await fetch(`${stack.url}/v1/executors/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await stack.access(OPERATOR)) },
    // A sandboxed device with enforced egress: the repository is not `non-confidential` and a pull request carries
    // `untrusted-input`, so a host-process device would get no lease (MAMEKO-LEASE-084, MAMEKO-LEASE-085).
    body: JSON.stringify(
      registration("credential-device", identity, ["isolation:vm", "egress:enforced"]),
    ),
  });
  expect(enrolled.status).toBe(201);
  device = await connect(stack.mf, "credential-device", keys, PLANE_ID);
  device.send(hello("credential-device", PLANE_ID));
  await device.next("session.welcome");

  const delivery = stack.github.delivery(
    "pull_request",
    "pull_request.opened.json",
    WEBHOOK_SECRET,
  );
  const delivered = await fetch(`${stack.url}/v1/webhooks/github`, {
    method: "POST",
    headers: delivery.headers,
    body: delivery.body,
  });
  expect(delivered.status).toBe(202);
  const { executions } = (await delivered.json()) as { executions: string[] };
  expect(executions).toHaveLength(1);
  executionId = executions[0]!;
});

afterAll(async () => {
  await stack?.close();
});

describe("the credentials an executor holds", () => {
  it("[FD-ARCH-004] holds no GitHub write credential: every installation token it receives is the read-only per-lease token", async () => {
    // The drainer opens the execution's check run with the Worker's own token before any executor claims it.
    await tick();
    device.send({
      type: "exec.claim",
      id: "c1",
      free: { release: 1, required: 1, interactive: 1, batch: 1 },
    });
    lease = await device.next("exec.lease");
    expect(lease["execution_id"]).toBe(executionId);
    // The Worker itself holds installation tokens with the installation's full permissions, and wrote with them.
    const full = stack.github.minted.filter((m) => m.permissions === null);
    expect(full.length).toBeGreaterThan(0);
    expect(stack.github.writes.length).toBeGreaterThan(0);

    const frames = device.received.join("\n");
    expect(frames).toContain(executionId);
    // No token the Worker holds with write access reaches the device, in the lease or in any later frame.
    for (const token of full) expect(frames).not.toContain(token.token);
    // Every GitHub credential the device received is a token GitHub minted for one lease: read-only, on the
    // execution's one repository.
    const held = [...new Set(frames.match(GITHUB_CREDENTIAL) ?? [])];
    for (const credential of held) {
      const minted = stack.github.minted.find((m) => m.token === credential);
      expect(minted, credential).toBeDefined();
      expect(isPerLeaseReadToken(minted!), credential).toBe(true);
    }
    // The lease's credentials are per-lease read tokens only, and no App key reaches the device.
    for (const credential of Object.values((lease["credentials"] ?? {}) as Record<string, unknown>))
      for (const token of JSON.stringify(credential).match(GITHUB_CREDENTIAL) ?? [])
        expect(
          stack.github.minted.some((m) => m.token === token && isPerLeaseReadToken(m)),
          token,
        ).toBe(true);
    expect(frames).not.toMatch(/PRIVATE KEY/);
  });
});
