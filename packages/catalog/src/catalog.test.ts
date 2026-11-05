import { readFileSync } from "node:fs";
import { CAPABILITIES } from "@fractalboxdev/mameko-run";
import { Effect, Exit, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DispatchEvent, TRIGGER_KINDS } from "./dispatch-event.ts";
import { PUBLISHED_SCHEMAS } from "./generate-schemas.ts";
import { ctx, SHA } from "./gate.test-support.ts";
import { GithubRead, githubReadLayer } from "./github-read.ts";
import { registry, runsFor } from "./runs.ts";
import { Signals, signalsJsonSchema } from "./signals.ts";
import { classRanks, lookupRun, RUN_NAMES } from "./spec.ts";
import { checkDecoder, offloadTestDecoder, oxlintDecoder } from "./triggers.ts";

const repository = { fullName: "o/r", cloneUrl: ctx.repo, defaultBranch: "main" };
const pullRequest = (action: string, draft = false): DispatchEvent => ({
  _tag: "webhook",
  deliveryId: "d1",
  delivery: {
    event: "pull_request",
    action,
    repository,
    pullRequest: {
      number: 3,
      draft,
      author: "dev",
      headSha: SHA,
      headRef: "f",
      baseRef: "main",
      baseSha: "c".repeat(40),
    },
  },
});

describe("DispatchEvent", () => {
  it("FD-RUN-008 has one member per trigger kind", () => {
    const tags = DispatchEvent.members.map(
      (m) => (m.fields._tag.ast as unknown as { literal: string }).literal,
    );
    expect(tags).toEqual([...TRIGGER_KINDS]);
  });

  it("FD-RUN-008 decodes each trigger kind and is what every request decoder takes", () => {
    const events: unknown[] = [
      pullRequest("opened"),
      {
        _tag: "dispatch",
        run: "check",
        repo: "o/r",
        ref: "main",
        sha: SHA,
        inputs: {},
        caller: "oidc",
      },
      { _tag: "cron", scheduledMinute: "2026-11-04T03:00:00Z", repo: "o/r", schedule: "0 3 * * *" },
      { _tag: "local", lease_id: "l1", epoch: 1, run: "check", treeHash: "t", inputsDigest: "i" },
      { _tag: "mcp", caller: "me", run: "check", repo: "o/r", ref: "main", sha: SHA, inputs: {} },
    ];
    for (const e of events)
      expect(Exit.isSuccess(Schema.decodeUnknownExit(DispatchEvent)(e))).toBe(true);
    expect(Exit.isSuccess(Schema.decodeUnknownExit(DispatchEvent)({ _tag: "email" }))).toBe(false);
  });

  it("FD-GATE-001 takes a gate's command only from the manifest entry or the dispatch inputs", () => {
    const entry = { label: "unit", command: "pnpm test" };
    const fromWebhook = Option.getOrUndefined(checkDecoder(entry)(pullRequest("synchronize")));
    expect(fromWebhook?.steps).toEqual([entry]);
    const steps = [{ label: "x", command: "make" }];
    const fromDispatch = checkDecoder(entry)({
      _tag: "dispatch",
      run: "check",
      repo: "o/r",
      ref: "main",
      sha: SHA,
      inputs: { ...ctx, steps },
      caller: "oidc",
    });
    expect(Option.getOrUndefined(fromDispatch)?.steps).toEqual(steps);
    expect(Option.isNone(checkDecoder(entry)(pullRequest("closed")))).toBe(true);
    expect(Option.isNone(offloadTestDecoder({})(pullRequest("labeled")))).toBe(true);
  });

  it("FD-GATE-017 passes the pull request's draft flag and author to the run", () => {
    const decoded = Option.getOrUndefined(oxlintDecoder({})(pullRequest("ready_for_review", true)));
    expect(decoded?.pullRequest).toEqual({ draft: true, author: "dev" });
  });
});

describe("GithubRead", () => {
  const read = (respond: () => Response | Promise<Response>) =>
    githubReadLayer({ apiBase: "https://api.github.com", fetch: async () => respond() });
  const head = (layer: ReturnType<typeof read>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GithubRead;
        return yield* github.branchHead("o/r", "main");
      }).pipe(Effect.provide(layer), Effect.exit),
    );

  it("FD-RUN-017 answers the value of a successful read", async () => {
    const exit = await head(read(() => Response.json({ object: { sha: SHA, type: "commit" } })));
    expect(exit).toEqual(Exit.succeed(SHA));
  });

  it("FD-RUN-017 fails with GithubUncredentialed or GithubReadFailed, never an empty answer", async () => {
    const tags = async (respond: () => Response | Promise<Response>) => {
      const exit = await head(read(respond));
      return Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "succeeded";
    };
    expect(await tags(() => new Response(null, { status: 401 }))).toContain("GithubUncredentialed");
    expect(await tags(() => new Response(null, { status: 404 }))).toContain("GithubReadFailed");
    expect(await tags(() => Response.json([]))).toContain("GithubReadFailed");
    expect(await tags(() => Promise.reject(new Error("offline")))).toContain("GithubReadFailed");
  });

  it("FD-RUN-017 peels an annotated tag and reads reachability from a comparison", async () => {
    const answers: Record<string, unknown> = {
      "/repos/o/r/git/ref/tags/v1.0.0": { object: { sha: "t".repeat(40), type: "tag" } },
      [`/repos/o/r/git/tags/${"t".repeat(40)}`]: { object: { sha: SHA, type: "commit" } },
      [`/repos/o/r/compare/main...${SHA}`]: { status: "behind" },
    };
    const layer = githubReadLayer({
      apiBase: "https://api.github.com",
      fetch: async (url) =>
        Response.json(answers[String(url).replace("https://api.github.com", "")]),
    });
    const [tag, reachable] = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GithubRead;
        return [
          yield* github.tagCommit("o/r", "v1.0.0"),
          yield* github.reachableFrom("o/r", SHA, "main"),
        ] as const;
      }).pipe(Effect.provide(layer)),
    );
    expect(tag).toBe(SHA);
    expect(reachable).toBe(true);
  });
});

describe("signals/v1", () => {
  it("FD-RUN-054 commits the JSON Schema generated from the Schema definition", () => {
    for (const schema of PUBLISHED_SCHEMAS)
      expect(readFileSync(schema.path, "utf8"), `regenerate with pnpm gen:schemas`).toBe(
        schema.text(),
      );
  });

  it("FD-RUN-054 carries the signals/v1 caps", () => {
    const doc = signalsJsonSchema() as {
      maxItems: number;
      items: { properties: Record<string, { maxLength?: number }> };
    };
    expect(doc.maxItems).toBe(50);
    expect(
      Object.fromEntries(Object.entries(doc.items.properties).map(([k, v]) => [k, v.maxLength])),
    ).toEqual({
      source: 120,
      title: 200,
      detail: 2000,
      url: 1000,
      count: undefined,
    });
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(Signals)([{ source: "x".repeat(121), title: "", detail: "" }]),
      ),
    ).toBe(true);
  });
});

describe("the run catalogue", () => {
  it("FD-RUN-061 passes defineRun the profile's class ranks", () => {
    expect(classRanks).toEqual({ release: 0, required: 1, interactive: 2, batch: 3 });
  });

  it("FD-RUN-062 lists only mameko's capability names in requires and keeps GithubRead beside them", () => {
    for (const name of RUN_NAMES) {
      const found = lookupRun("development", name);
      if (found._tag !== "Available") throw new Error(name);
      for (const cap of found.entry.spec.requires) expect(CAPABILITIES).toContain(cap);
      expect(found.entry.spec.requires).not.toContain("GithubRead");
    }
    const deploy = lookupRun("development", "worker-deploy");
    expect(deploy._tag === "Available" && deploy.entry.appCapabilities).toEqual(["GithubRead"]);
  });

  it("FD-RUN-063 has one registry, the only list of runs, matching the catalogue", () => {
    expect(registry.map((r) => r.spec.name)).toEqual([...RUN_NAMES]);
    const entry = readFileSync(new URL("./runner-entry.ts", import.meta.url), "utf8");
    expect(entry).toContain("runnerMain({ runs: runsFor(");
    expect(runsFor("development").map((r) => r.spec.name)).toEqual(["check", "oxlint", "gate-job"]);
    expect(runsFor("production")).toEqual([]);
  });

  it("FD-GATE-045 gives the matrix parent a container rate of 0 and no sandbox capability", () => {
    const found = lookupRun("production", "offload-test");
    if (found._tag !== "Available") throw new Error("offload-test");
    expect(found.entry.containerRateUsdPerHour).toBe(0);
    expect(found.entry.spec.requires).toEqual(["Children", "Intents"]);
  });

  it("declares each recipe's default class and run ceiling of specs/runs/gate.md § Recipes", () => {
    const table = {
      check: ["required", 4500],
      oxlint: ["required", 600],
      "offload-test": ["required", 3600],
      "worker-deploy": ["release", 1800],
      "deploy-smoke": ["release", 300],
      "sandbox-image": ["required", 3600],
    } as const;
    for (const [name, [cls, ceiling]] of Object.entries(table)) {
      const found = lookupRun("development", name);
      if (found._tag !== "Available") throw new Error(name);
      expect([found.entry.defaultClass, found.entry.spec.limits.maxDurationSec]).toEqual([
        cls,
        ceiling,
      ]);
    }
  });
});
