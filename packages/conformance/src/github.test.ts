// The installation quota's key on the composed control plane: the control plane Worker under workerd through
// Miniflare with the GitHub App and the recorded GitHub fixture server. A pull request's admission inserts its
// `check.open` row under the profile's `delivery.limit_key` binding, `installationOf`, so the row carries the id of the
// installation that serves its repository, and the minute tick's drain takes the row's permit under that key and opens
// the check run (specs/github-output.md § Installation quota).
//
// The side-output applier's lookup on the actuators the control plane composes under the App: the GitHub services
// (`appServices`) inside the agentic writeback applier (`writebackApplier`), against a GitHub stand-in over HTTP. For
// each adoptable side kind the lookup searches by the kind's marker in the profile's intents table and answers `found`
// with the one object's id, `absent` when none carries the marker, and `undetermined` when the read fails
// (specs/github-output.md § Appliers). A `pr.propose` row carries the `prProposePayload` binding's payload and goes to
// the writeback applier's lookup, which reads the branch head, its commit's execution trailer and the open pull request.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  executionTrailer,
  gitDataLayer,
  prProposePayload,
  WritebackRecords,
} from "@fractalboxdev/flare-dispatch-agentic";
import { profile } from "@fractalboxdev/flare-dispatch-profile";
import {
  Actuators,
  AlarmPort,
  type IntentRow,
  type LookupAnswer,
} from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writebackApplier } from "../../../apps/control-plane/src/agentic.ts";
import type { ControlPlaneEnv } from "../../../apps/control-plane/src/config.ts";
import { appServices } from "../../../apps/control-plane/src/github.ts";
import type { GithubState } from "../../../apps/control-plane/test/e2e-local/fixtures/github-server.ts";
import {
  startStack,
  WEBHOOK_SECRET,
  type Stack,
} from "../../../apps/control-plane/test/e2e-local/stack.ts";

const STATE = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "../../../apps/control-plane/test/e2e-local/fixtures/intake-github.json",
    ),
    "utf8",
  ),
) as GithubState;

const WIDGETS = "acme/widgets";
const BASE = STATE.repositories[WIDGETS]!.branches["main"]!;
const HEAD = "9".repeat(40);

let stack: Stack;

/** A pull request opened against `main` of acme/widgets; answers the executions it admitted. */
const openPullRequest = async () => {
  const delivery = stack.github.delivery(
    "pull_request",
    "pull_request.opened.json",
    WEBHOOK_SECRET,
    (p) => {
      const pr = p["pull_request"] as Record<string, Record<string, unknown>>;
      return {
        ...p,
        pull_request: {
          ...pr,
          head: { ...pr["head"], sha: HEAD },
          base: { ...pr["base"], sha: BASE },
        },
      };
    },
  );
  const r = await fetch(`${stack.url}/v1/webhooks/github`, {
    method: "POST",
    headers: delivery.headers,
    body: delivery.body,
  });
  expect(r.status).toBe(202);
  return ((await r.json()) as { executions: string[] }).executions;
};

describe("the installation quota's key", () => {
  beforeAll(async () => {
    stack = await startStack({ github: STATE });
  }, 120_000);

  afterAll(async () => {
    await stack?.close();
  });

  it("[FD-GH-056] admission keys a repository's rows by the installation that serves it, and the drain opens the check run under that key", async () => {
    const [executionId] = await openPullRequest();
    expect(executionId).toBeDefined();
    const db = await stack.mf.getD1Database("DB");
    const rows = async () =>
      (
        await db
          .prepare("select kind, limit_key, state from outbox where execution_id = ?")
          .bind(executionId)
          .all<{ kind: string; limit_key: string; state: string }>()
      ).results;
    const installation = String(STATE.repositories[WIDGETS]!.installation);
    expect(await rows()).toEqual([
      { kind: "check.open", limit_key: installation, state: "pending" },
    ]);

    const worker = await stack.mf.getWorker();
    await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date() });
    await expect.poll(async () => (await rows()).map((r) => r.state)).toEqual(["applied"]);
    expect(
      stack.github.writes.filter((w) => w.path === `/repos/${WIDGETS}/check-runs`),
    ).toHaveLength(1);
  });
});

/** What the GitHub stand-in holds for acme/app while one scenario runs. */
interface Remote {
  comments: Record<number, readonly { id: number; body: string }[]>;
  reviews: Record<number, readonly { id: number; body: string }[]>;
  /** Newest first, as the marker search asks for them. */
  issues: readonly {
    id: number;
    number: number;
    body: string;
    pull_request?: object;
  }[];
  pulls: readonly {
    number: number;
    state: "open" | "closed";
    head: { ref: string };
  }[];
  releases: readonly { id: number; tag_name: string; draft: boolean }[];
  /** Branch name to head sha, as both the branches API and the git refs API answer it. */
  branches: Record<string, string>;
  /** As both the git commits API and the commits API answer them. */
  commits: Record<string, { sha: string; message: string }>;
  deliveries: readonly { id: number; guid: string; redelivery: boolean }[];
}

const SIDE_REPO = "acme/app";
const INSTALLATION = 7;
const INSTALLATION_TOKEN = "ghs-installation-7";
const APP_LOGIN = "flare-dispatch[bot]";
const MARKER = "<!-- flare-dispatch:intent exec-1/run:step:0 -->";
const OTHER_MARKER = "<!-- flare-dispatch:intent exec-1/run:step:1 -->";

const emptyRemote = (): Remote => ({
  comments: {},
  reviews: {},
  issues: [],
  pulls: [],
  releases: [],
  branches: {},
  commits: {},
  deliveries: [],
});

let remote: Remote = emptyRemote();
/** Requests whose path and query match fail: `error` answers 502, `drop` closes the connection unanswered. */
let failing: { readonly path: RegExp; readonly how: "error" | "drop" } | undefined;
const sideCalls: string[] = [];
let sideServer: Server;
let sideBase = "";

const answer = (path: string, query: URLSearchParams, authorization: string): [number, unknown] => {
  if (path === `/app/installations/${INSTALLATION}/access_tokens`)
    return [
      201,
      {
        token: INSTALLATION_TOKEN,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ];
  if (path === `/repos/${SIDE_REPO}/installation`) return [200, { id: INSTALLATION }];
  if (path.startsWith(`/repos/${SIDE_REPO}/`) && authorization !== `Bearer ${INSTALLATION_TOKEN}`)
    return [401, { message: "Bad credentials" }];
  const rest = path.slice(`/repos/${SIDE_REPO}`.length);
  let m: RegExpExecArray | null;
  if ((m = /^\/issues\/(\d+)\/comments$/.exec(rest)) !== null)
    return [200, remote.comments[Number(m[1])] ?? []];
  if ((m = /^\/pulls\/(\d+)\/reviews$/.exec(rest)) !== null)
    return [200, remote.reviews[Number(m[1])] ?? []];
  if (rest === "/issues") {
    const page = Number(query.get("page") ?? "1");
    return [200, remote.issues.slice((page - 1) * 100, page * 100)];
  }
  if (rest === "/pulls")
    return [
      200,
      remote.pulls
        .filter((p) => p.state === query.get("state") && `acme:${p.head.ref}` === query.get("head"))
        .map((p) => ({ ...p, html_url: pullUrl(p.number) })),
    ];
  if (rest === "/releases") return [200, remote.releases.map((r) => ({ ...r, assets: [] }))];
  if ((m = /^\/branches\/(.+)$/.exec(rest)) !== null) {
    const sha = remote.branches[decodeURIComponent(m[1]!)];
    return sha === undefined
      ? [404, { message: "Branch not found" }]
      : [200, { commit: { sha }, protected: false }];
  }
  if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) !== null) {
    const sha = remote.branches[decodeURIComponent(m[1]!)];
    return sha === undefined
      ? [404, { message: "Not Found" }]
      : [200, { ref: `refs/heads/${m[1]}`, object: { sha, type: "commit" } }];
  }
  if ((m = /^\/git\/commits\/(\w+)$/.exec(rest)) !== null) {
    const commit = remote.commits[m[1]!];
    return commit === undefined
      ? [404, { message: "Not Found" }]
      : [200, { ...commit, tree: { sha: `tree-${commit.sha}` } }];
  }
  if ((m = /^\/commits\/(\w+)$/.exec(rest)) !== null) {
    const commit = remote.commits[m[1]!];
    return commit === undefined
      ? [404, { message: "Not Found" }]
      : [
          200,
          {
            sha: commit.sha,
            commit: { message: commit.message, tree: { sha: `tree-${commit.sha}` } },
            author: { login: APP_LOGIN },
          },
        ];
  }
  if (path === "/app/hook/deliveries") return [200, remote.deliveries];
  if ((m = /^\/app\/hook\/deliveries\/(\d+)$/.exec(path)) !== null) {
    const delivery = remote.deliveries.find((d) => d.id === Number(m![1]));
    return delivery === undefined ? [404, { message: "Not Found" }] : [200, delivery];
  }
  return [404, { message: "Not Found" }];
};

const pullUrl = (number: number) => `https://github.com/${SIDE_REPO}/pull/${number}`;

/** The control plane's GitHub services under an App whose API base is the stand-in. */
const sideServices = () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const app: Parameters<typeof appServices>[1] = {
    appId: "4242",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fetch: (input, init) => fetch(input, init),
    baseUrl: sideBase,
  };
  // The lookup reads nothing from D1: the conclusion facts the check-run applier reads are never asked for here.
  const env = { DB: {}, PLANE_ID: "conformance" } as unknown as ControlPlaneEnv;
  return appServices(env, app, Layer.succeed(AlarmPort, { deliver: () => Effect.void }));
};

/** A lookup reads no staged-write record; the `pr.propose` apply is the only reader. */
const unreadRecords = Layer.succeed(WritebackRecords, {
  blobs: () => Effect.die("a lookup reads no staged blob"),
  modelCalls: () => Effect.die("a lookup reads no model call"),
  issuedCredentials: () => Effect.die("a lookup reads no issued credential"),
});

/**
 * The actuators as the control plane composes them under the App: the GitHub services inside the writeback applier,
 * whose git data carries the installation token to the stand-in.
 */
const sideActuators = () => {
  const support = Layer.mergeAll(
    gitDataLayer({
      apiBase: sideBase,
      fetch: (input, init) => fetch(input, init),
      token: () => Effect.succeed(INSTALLATION_TOKEN),
    }),
    unreadRecords,
  ).pipe(Layer.provideMerge(sideServices()));
  return writebackApplier(APP_LOGIN).pipe(Layer.provideMerge(support));
};

/** `lookup` on the actuator the profile's intents table binds the row's kind to. */
const sideLookup = (row: IntentRow): Promise<LookupAnswer> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const binding = profile.intent_kinds[row.kind]?.actuator;
      const actuator = binding === undefined ? undefined : (yield* Actuators).get(binding);
      if (actuator?.lookup === undefined) return yield* Effect.die(`no lookup for ${row.kind}`);
      return yield* actuator.lookup(row);
    }).pipe(Effect.provide(sideActuators())),
  );

interface SideCase {
  readonly kind: string;
  readonly payload: unknown;
  /** An ops intent belongs to no execution. */
  readonly ops?: true;
  /** Exactly one object carries the marker, beside objects that do not; answers its id. */
  readonly found: (r: Remote) => string;
  /** No object carries the marker. */
  readonly absent: (r: Remote) => void;
  /** Further remotes the lookup answers absent for, by what makes them absent. */
  readonly absentAlso?: Readonly<Record<string, (r: Remote) => void>>;
  /**
   * The reads the lookup takes, in order. Each fails in turn in the undetermined scenarios over the `found` remote,
   * so the lookup reaches every one.
   */
  readonly reads: readonly RegExp[];
  /** More than one object carries the marker. */
  readonly twice?: (r: Remote) => void;
}

const noiseIssues = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: 5000 + i,
    number: 500 - i,
    body: i === 3 ? `a pull request with the marker\n\n${MARKER}` : `noise\n\n${OTHER_MARKER}`,
    ...(i === 3 ? { pull_request: {} } : {}),
  }));

const PROPOSE_BRANCH = "flare-dispatch/fix-lint";
const HEAD_SHA = "a".repeat(40);

/** The row's payload as the profile's `prProposePayload` binding builds it from an accepted success. */
const PROPOSE = (() => {
  const bound = prProposePayload({
    executionId: "exec-1",
    run: "fix-lint",
    repo: { owner: "acme", name: "app" },
    outcome: "success",
    stagedWrite: {
      branch: PROPOSE_BRANCH,
      baseBranch: "main",
      baseCommit: "b".repeat(40),
      message: "fix lint",
      pr: { title: "Fix lint", body: "", draft: false, labels: [] },
      entries: [],
    },
  });
  if (bound._tag !== "payload")
    throw new Error("an accepted success with a staged write binds a payload");
  return bound.payload;
})();

/** The proposal's branch, whose head is the applier's commit for exec-1. */
const proposed = (r: Remote) => {
  r.branches[PROPOSE_BRANCH] = HEAD_SHA;
  r.commits[HEAD_SHA] = { sha: HEAD_SHA, message: `fix lint\n\n${executionTrailer("exec-1")}` };
};

const CASES: readonly SideCase[] = [
  {
    kind: "comment",
    payload: { issue_number: 5, body: "Review summary" },
    found: (r) => {
      r.comments[5] = [
        { id: 100, body: "a person's comment" },
        { id: 101, body: `Review summary\n\n${MARKER}` },
        { id: 102, body: `another step\n\n${OTHER_MARKER}` },
      ];
      return "101";
    },
    absent: (r) => {
      r.comments[5] = [
        { id: 100, body: "a person's comment" },
        { id: 102, body: `another step\n\n${OTHER_MARKER}` },
      ];
    },
    reads: [/\/issues\/5\/comments/],
    twice: (r) => {
      r.comments[5] = [
        { id: 101, body: `one\n\n${MARKER}` },
        { id: 103, body: `two\n\n${MARKER}` },
      ];
    },
  },
  {
    kind: "review",
    payload: { pull_number: 9, body: "Findings" },
    found: (r) => {
      r.reviews[9] = [
        { id: 200, body: "LGTM" },
        { id: 201, body: `Findings\n\n${MARKER}` },
      ];
      return "201";
    },
    absent: (r) => {
      r.reviews[9] = [
        { id: 200, body: "LGTM" },
        { id: 202, body: `Findings\n\n${OTHER_MARKER}` },
      ];
    },
    reads: [/\/pulls\/9\/reviews/],
    twice: (r) => {
      r.reviews[9] = [
        { id: 201, body: `one\n\n${MARKER}` },
        { id: 203, body: `two\n\n${MARKER}` },
      ];
    },
  },
  {
    kind: "issue",
    payload: { title: "Flaky test", body: "Seen twice" },
    // The marked issue is past the first page of 100, behind a pull request that carries the marker.
    found: (r) => {
      r.issues = [...noiseIssues(130), { id: 4999, number: 1, body: `Seen twice\n\n${MARKER}` }];
      return "4999";
    },
    absent: (r) => {
      r.issues = noiseIssues(130);
    },
    reads: [/\/issues\?.*&page=2$/],
    twice: (r) => {
      r.issues = [
        { id: 4998, number: 2, body: `one\n\n${MARKER}` },
        { id: 4999, number: 1, body: `two\n\n${MARKER}` },
      ];
    },
  },
  {
    kind: "pr.propose",
    payload: PROPOSE,
    found: (r) => {
      proposed(r);
      r.pulls = [
        { number: 40, state: "open", head: { ref: "flare-dispatch/other" } },
        { number: 41, state: "open", head: { ref: PROPOSE_BRANCH } },
      ];
      return pullUrl(41);
    },
    absent: (r) => {
      r.branches["flare-dispatch/other"] = HEAD_SHA;
      r.commits[HEAD_SHA] = { sha: HEAD_SHA, message: `other\n\n${executionTrailer("exec-1")}` };
    },
    absentAlso: {
      "a branch head that is another execution's commit": (r) => {
        r.branches[PROPOSE_BRANCH] = HEAD_SHA;
        r.commits[HEAD_SHA] = {
          sha: HEAD_SHA,
          message: `fix lint\n\n${executionTrailer("exec-2")}`,
        };
        r.pulls = [{ number: 41, state: "open", head: { ref: PROPOSE_BRANCH } }];
      },
      "the execution's branch head with no open pull request": (r) => {
        proposed(r);
        r.pulls = [{ number: 41, state: "closed", head: { ref: PROPOSE_BRANCH } }];
      },
    },
    reads: [/\/git\/ref\/heads\//, new RegExp(`/repos/${SIDE_REPO}/commits/`), /\/pulls\?/],
  },
  {
    kind: "release.draft",
    payload: { tag: "v1.2.0", target: "main", name: "v1.2.0", body: "notes" },
    found: (r) => {
      r.releases = [
        { id: 300, tag_name: "v1.1.0", draft: false },
        { id: 301, tag_name: "v1.2.0", draft: true },
      ];
      return "301";
    },
    absent: (r) => {
      r.releases = [{ id: 300, tag_name: "v1.1.0", draft: false }];
    },
    reads: [/\/releases/],
  },
  {
    kind: "release.publish",
    payload: { tag: "v1.2.0" },
    found: (r) => {
      r.releases = [
        { id: 300, tag_name: "v1.1.0", draft: false },
        { id: 301, tag_name: "v1.2.0", draft: false },
      ];
      return "301";
    },
    // A draft under the tag is the draft's effect, not the publish's.
    absent: (r) => {
      r.releases = [{ id: 301, tag_name: "v1.2.0", draft: true }];
    },
    reads: [/\/releases/],
  },
  {
    kind: "canary.push",
    ops: true,
    payload: {
      branch: "flare-dispatch/canary",
      tick_time: "2026-11-11T10:00:00Z",
    },
    found: (r) => {
      r.branches["flare-dispatch/canary"] = "c0ffee";
      r.commits["c0ffee"] = {
        sha: "c0ffee",
        message: "flare-dispatch canary 2026-11-11T10:00:00Z",
      };
      return "c0ffee";
    },
    absent: (r) => {
      r.branches["flare-dispatch/canary"] = "beef00";
      r.commits["beef00"] = {
        sha: "beef00",
        message: "flare-dispatch canary 2026-11-11T09:59:00Z",
      };
    },
    reads: [/\/git\/commits\//],
  },
  {
    kind: "delivery.redeliver",
    ops: true,
    payload: { delivery_id: 10 },
    found: (r) => {
      r.deliveries = [
        { id: 10, guid: "g-1", redelivery: false },
        { id: 11, guid: "g-1", redelivery: true },
        { id: 12, guid: "g-2", redelivery: true },
      ];
      return "11";
    },
    absent: (r) => {
      r.deliveries = [
        { id: 10, guid: "g-1", redelivery: false },
        { id: 12, guid: "g-2", redelivery: true },
      ];
    },
    reads: [/\/app\/hook\/deliveries\?/],
    twice: (r) => {
      r.deliveries = [
        { id: 10, guid: "g-1", redelivery: false },
        { id: 11, guid: "g-1", redelivery: true },
        { id: 13, guid: "g-1", redelivery: true },
      ];
    },
  },
];

const sideRow = (c: SideCase): IntentRow => ({
  executionId: c.ops === true ? null : "exec-1",
  scopeId: SIDE_REPO,
  intentKey: "run:step:0",
  kind: c.kind,
  payload: c.payload,
  payloadDigest: "digest",
  effectClass: "adoptable",
  attempts: 1,
});

/** Every call but the token mint is a read: a lookup never writes. */
const wroteNothing = () =>
  expect(
    sideCalls.filter(
      (c) => !c.startsWith("GET ") && c !== `POST /app/installations/${INSTALLATION}/access_tokens`,
    ),
  ).toEqual([]);

describe("the side-output applier's lookup", () => {
  beforeAll(async () => {
    sideServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://stand-in");
      const target = `${url.pathname}${url.search}`;
      sideCalls.push(`${req.method} ${target}`);
      if (failing?.path.test(target) === true) {
        if (failing.how === "drop") return req.socket.destroy();
        res.writeHead(502, { "content-type": "application/json" });
        return res.end(JSON.stringify({ message: "Bad Gateway" }));
      }
      const [status, body] = answer(
        url.pathname,
        url.searchParams,
        req.headers.authorization ?? "",
      );
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => sideServer.listen(0, "127.0.0.1", resolve));
    sideBase = `http://127.0.0.1:${(sideServer.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => sideServer.close(() => resolve())));

  const scenario = (seed: (r: Remote) => unknown, fail?: typeof failing) => {
    remote = emptyRemote();
    seed(remote);
    failing = fail;
    sideCalls.length = 0;
  };

  it("[FD-GH-092] the cases are every adoptable kind the intents table binds outside the check run", () => {
    const adoptable = Object.entries(profile.intent_kinds)
      .filter(([, k]) => k.effect_class === "adoptable" && k.actuator !== "checkRun")
      .map(([kind]) => kind);
    expect(CASES.map((c) => c.kind).sort()).toEqual([...adoptable].sort());
  });

  for (const c of CASES) {
    it(`[FD-GH-092] ${c.kind}: the one object carrying the marker is found by its id`, async () => {
      let ref = "";
      scenario((r) => (ref = c.found(r)));
      expect(await sideLookup(sideRow(c))).toEqual({
        _tag: "found",
        externalRef: ref,
      });
      wroteNothing();
    });

    it(`[FD-GH-092] ${c.kind}: no object carrying the marker is absent`, async () => {
      scenario(c.absent);
      expect(await sideLookup(sideRow(c))).toEqual({ _tag: "absent" });
      wroteNothing();
    });

    for (const [what, seed] of Object.entries(c.absentAlso ?? {}))
      it(`[FD-GH-092] ${c.kind}: ${what} is absent`, async () => {
        scenario(seed);
        expect(await sideLookup(sideRow(c))).toEqual({ _tag: "absent" });
        wroteNothing();
      });

    it(`[FD-GH-092] ${c.kind}: a read that fails is undetermined, never absent or found`, async () => {
      for (const read of c.reads)
        for (const how of ["error", "drop"] as const) {
          scenario(c.found, { path: read, how });
          const answer = await sideLookup(sideRow(c));
          expect(answer).toMatchObject({ _tag: "undetermined" });
          expect(sideCalls.some((call) => read.test(call))).toBe(true);
          if (how === "error")
            expect(answer).toMatchObject({
              reason: expect.stringMatching(/502/),
            });
        }
      wroteNothing();
    });

    const twice = c.twice;
    if (twice !== undefined)
      it(`[FD-GH-092] ${c.kind}: more than one object carrying the marker is undetermined`, async () => {
        scenario(twice);
        expect(await sideLookup(sideRow(c))).toEqual({
          _tag: "undetermined",
          reason: "2 objects carry the marker",
        });
      });
  }
});
