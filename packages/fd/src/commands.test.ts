import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DISPATCHER,
  makeHarness,
  MEMBER,
  OPERATOR,
  ORIGIN,
  record,
  type Harness,
} from "@fractalboxdev/flare-dispatch-api/test-support";
import { apiError } from "@fractalboxdev/flare-dispatch-api/errors";
import { Effect, Layer } from "effect";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "./commands.ts";
import { runFd, signedIn } from "./fd.test-support.ts";
import { BrowserLogin } from "./login.ts";
import { Operability } from "./operability.ts";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
beforeEach(() => {
  h.doubles.intake = (s) =>
    Effect.succeed({ _tag: "Admitted", executionId: "01JFD", class: s.class ?? "batch" });
  h.doubles.executions.set(
    "01JOK",
    record({ execution_id: "01JOK", verdict: "success", conclusion: "success" }),
  );
  h.doubles.executions.set("01JBAD", record({ execution_id: "01JBAD" }));
  h.doubles.executions.set(
    "01JCAN",
    record({ execution_id: "01JCAN", verdict: "cancelled", conclusion: "cancelled" }),
  );
  h.doubles.executions.set(
    "01JSKIP",
    record({ execution_id: "01JSKIP", verdict: "skipped", conclusion: "neutral" }),
  );
  h.doubles.executions.set(
    "01JRUN",
    record({ execution_id: "01JRUN", status: "running", verdict: null }),
  );
});

const PACKAGE = join(import.meta.dirname, "..");

describe("fd-<subcommand> executables", () => {
  it("[FD-IFC-084]: every command mameko's <cli> leaves to fd is an executable fd-<subcommand> mapped to its command", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    const table = [
      "login",
      "dispatch",
      "status",
      "verdict",
      "failure",
      "logs",
      "cancel",
      "ls",
      "ops",
      "deploy",
      "doctor",
      "mcp",
      "verify",
    ];
    for (const name of table) {
      const file = pkg.bin[`fd-${name}`];
      expect(file, `fd-${name}`).toBe(`bin/fd-${name}.mjs`);
      const path = join(PACKAGE, file!);
      expect(statSync(path).mode & 0o111).not.toBe(0);
      expect(readFileSync(path, "utf8")).toContain(`main("${name}")`);
      expect(name in COMMANDS).toBe(true);
    }
    expect(Object.keys(pkg.bin).sort()).toEqual(
      Object.keys(COMMANDS)
        .map((n) => `fd-${n}`)
        .sort(),
    );
  });
});

describe("output and exit codes", () => {
  it("[FD-IFC-064]: --json writes exactly one JSON document matching the response, and diagnostics to stderr", async () => {
    const run = await runFd(h, "status", ["01JOK", "--json"], { store: await signedIn(h, MEMBER) });
    expect(run.exit).toBe(0);
    expect(run.stdout).toHaveLength(1);
    expect(JSON.parse(run.stdout[0]!)).toMatchObject({
      execution_id: "01JOK",
      status: "done",
      verdict: "success",
    });
    const failed = await runFd(h, "status", ["missing", "--json"], {
      store: await signedIn(h, MEMBER),
    });
    expect(failed.stdout).toHaveLength(1);
    expect(JSON.parse(failed.stdout[0]!)).toMatchObject({ error: "execution_not_found" });
  });

  it("[FD-IFC-065]: verdict exits 0 success, 1 failure, 3 cancelled, 4 skipped and 6 before a verdict", async () => {
    const store = await signedIn(h, MEMBER);
    const cases = [
      ["01JOK", 0],
      ["01JBAD", 1],
      ["01JCAN", 3],
      ["01JSKIP", 4],
      ["01JRUN", 6],
    ] as const;
    for (const [id, code] of cases)
      expect((await runFd(h, "verdict", [id], { store })).exit).toBe(code);
  });

  it("[FD-IFC-065]: verdict --wait exits 6 when the timeout passes first", async () => {
    const run = await runFd(h, "verdict", ["01JRUN", "--wait", "--timeout", "1"], {
      store: await signedIn(h, MEMBER),
    });
    expect(run.exit).toBe(6);
  });

  it("[FD-IFC-065]: a usage error exits 2, and a refused identity exits 5", async () => {
    expect((await runFd(h, "status", [], { store: await signedIn(h, MEMBER) })).exit).toBe(2);
    expect(
      (
        await runFd(h, "ops", ["drain", "e1", "--reason", "r"], {
          store: await signedIn(h, MEMBER),
        })
      ).exit,
    ).toBe(5);
  });
});

describe("credentials", () => {
  it("[FD-IFC-068]: with no token, or an expired one, a command exits 5 naming fd login", async () => {
    const none = await runFd(h, "status", ["01JOK"]);
    expect(none.exit).toBe(5);
    expect(none.stderr.join("\n")).toContain("fd login");
    const expired = await runFd(h, "status", ["01JOK"], {
      store: await signedIn(h, MEMBER, { exp: Math.floor(Date.now() / 1000) - 10 }),
    });
    expect(expired.exit).toBe(5);
    expect(expired.stderr.join("\n")).toContain("fd login");
  });

  it("[FD-IFC-067]: fd login keeps the token in the credential store only, and prints it nowhere", async () => {
    const store = new Map<string, string>();
    const token = "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.c2ln";
    const run = await runFd(h, "login", [], {
      store,
      login: Layer.succeed(BrowserLogin)({ token: () => Effect.succeed(token) }),
    });
    expect(run.exit).toBe(0);
    expect(store.get(ORIGIN)).toBe(token);
    expect([...run.stdout, ...run.stderr].join("\n")).not.toContain(token);
  });
});

describe("commands and routes", () => {
  it("[FD-IFC-084], [FD-IFC-002]: dispatch calls POST /v1/dispatch/:run through the derived client", async () => {
    const run = await runFd(
      h,
      "dispatch",
      ["check", "--repo", "acme/widgets", "--sha", "a".repeat(40), "--inputs", '{"x":1}', "--json"],
      { store: await signedIn(h, DISPATCHER) },
    );
    expect(run.exit).toBe(0);
    expect(JSON.parse(run.stdout[0]!)).toMatchObject({ execution_id: "01JFD", class: "batch" });
    expect(h.doubles.calls.submissions.at(-1)).toMatchObject({
      run: "check",
      repository: "acme/widgets",
      inputs: { x: 1 },
      idempotency: undefined,
    });
  });

  it("[FD-IFC-066]: dispatch treats every 4xx as final", async () => {
    const before = h.doubles.calls.submissions.length;
    h.doubles.intake = () => Effect.fail(apiError("run_not_found", "no run named nope"));
    const run = await runFd(h, "dispatch", ["nope", "--repo", "acme/widgets"], {
      store: await signedIn(h, DISPATCHER),
    });
    expect(run.exit).toBe(2);
    expect(h.doubles.calls.submissions.length).toBe(before + 1);
  });

  it("[FD-IFC-084]: ls, failure, cancel and ops each call their one route", async () => {
    const member = await signedIn(h, MEMBER);
    const page = await runFd(h, "ls", ["--status", "done", "--limit", "2", "--json"], {
      store: member,
    });
    expect(JSON.parse(page.stdout[0]!).executions).toHaveLength(2);
    const pack = await runFd(h, "failure", ["01JBAD", "--json"], { store: member });
    expect(JSON.parse(pack.stdout[0]!)).toMatchObject({
      contractVersion: "v1",
      incidentId: "01JBAD",
    });
    const cancel = await runFd(h, "cancel", ["01JRUN", "--json"], {
      store: await signedIn(h, OPERATOR),
    });
    expect(JSON.parse(cancel.stdout[0]!)).toMatchObject({ verdict: "cancelled" });
    const ops = await runFd(
      h,
      "ops",
      ["halt", "halt-cloud", "--reason", "runaway spend", "--json"],
      {
        store: await signedIn(h, OPERATOR),
      },
    );
    expect(ops.exit).toBe(0);
    expect(h.doubles.calls.operations.at(-1)?.operation).toEqual({
      _tag: "halt",
      state: "halt-cloud",
    });
    await runFd(h, "ops", ["quarantine", "acme/widgets", "--reason", "abuse"], {
      store: await signedIn(h, OPERATOR),
    });
    expect(h.doubles.calls.operations.at(-1)?.operation).toEqual({
      _tag: "quarantine",
      target: { _tag: "repository", id: "acme/widgets" },
    });
  });

  it("ops delivery-keys prints every installation's delivery key", async () => {
    h.doubles.deliveryKeys = { list: Effect.succeed(["11", "21"]) };
    const store = await signedIn(h, OPERATOR);
    const listed = await runFd(h, "ops", ["delivery-keys", "--json"], { store });
    expect(listed.exit).toBe(0);
    expect(JSON.parse(listed.stdout[0]!)).toEqual({ installations: ["11", "21"] });
    const text = await runFd(h, "ops", ["delivery-keys"], { store });
    expect(text.stdout.join("\n")).toBe("11\n21");
  });

  it("[FD-IFC-070]: deploy and doctor hand the overlay to the operability service and exit by its report", async () => {
    const seen: string[] = [];
    const operability = Layer.succeed(Operability)({
      deploy: ({ overlay, dryRun }) =>
        Effect.sync(() => {
          seen.push(`deploy ${overlay} ${dryRun}`);
          return { ok: true, stages: [{ stage: "decode", ok: true, detail: "ok" }] };
        }),
      doctor: (overlay) =>
        Effect.sync(() => {
          seen.push(`doctor ${overlay}`);
          return {
            ok: false,
            stages: [{ stage: "drift", ok: false, detail: "hostnames.dispatcher differs" }],
          };
        }),
    });
    expect((await runFd(h, "deploy", ["--overlay", "{}", "--dry-run"], { operability })).exit).toBe(
      0,
    );
    expect((await runFd(h, "doctor", ["--overlay", "{}"], { operability })).exit).toBe(1);
    expect(seen).toEqual(["deploy {} true", "doctor {}"]);
    expect((await runFd(h, "doctor", ["--overlay", "{}"])).exit).toBe(1);
  });

  it("[FD-IFC-069]: rehearse, queue and lease exit 5 scheduler_unreachable when the socket is absent", async () => {
    for (const name of ["rehearse", "queue", "lease"] as const) {
      const args = name === "rehearse" ? ["check"] : [];
      const none = await runFd(h, name, args);
      expect(none.exit).toBe(5);
      expect(none.stderr.join("\n")).toContain("scheduler_unreachable");
      const missing = await runFd(h, name, args, {
        schedulerSocket: join(PACKAGE, "no-such.sock"),
      });
      expect(missing.exit).toBe(5);
      expect(missing.stderr.join("\n")).toContain("scheduler_unreachable");
    }
  });
});
