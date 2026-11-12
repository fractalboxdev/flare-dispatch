// The statement lookups under `/v1/provenance/*` as the Worker serves them: mounted on its router, with each
// statement's repository's GitHub visibility read through the isolate's `GithubRead`. A development deployment reads
// the visibility its captured repository carries, so one deployment captures a public repository and another captures
// one whose visibility it did not read.
import { join } from "node:path";
import { LOG_APPEND_SCHEMA } from "@fractalboxdev/flare-dispatch-cache";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUD, OPERATOR, PLANE, startAccessTeam, type AccessTeam } from "./support.ts";

const PUBLIC_REPO = "acme/widgets";
const PRIVATE_REPO = "acme/secret";
const PUBLIC_EXECUTION = "01PROVENANCEPUBLIC0000000";
const PRIVATE_EXECUTION = "01PROVENANCEPRIVATE000000";
/** A digest only the private repository's statement names. */
const APP = "a".repeat(64);
/** A digest both repositories' statements name. */
const LIB = "b".repeat(64);

const captured = (visibility?: string) => ({
  repository: PUBLIC_REPO,
  installation: 1,
  default_branch: "main",
  head: "f".repeat(40),
  files: {},
  ...(visibility === undefined ? {} : { visibility }),
});

let team: AccessTeam;
let script: string;
/** Captures `PUBLIC_REPO` with GitHub visibility `public`. */
let open: Miniflare;
/** Captures `PUBLIC_REPO` without its visibility, so no read answers it. */
let unread: Miniflare;

const miniflare = (repository: object) =>
  new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: script }],
    compatibilityDate: "2026-05-01",
    d1Databases: { DB: "control-plane" },
    durableObjects: {
      CHANNEL: { className: "ExecutorChannel", useSQLite: true },
      EXECUTION: { className: "ExecutionEngine", useSQLite: true },
      EPOCH_ANCHOR: { className: "EpochAnchor", useSQLite: true },
      MONITOR: { className: "LivenessMonitor", useSQLite: true },
      CACHE_LEDGER: { className: "CacheLedger", useSQLite: true },
    },
    r2Buckets: ["CACHE"],
    bindings: {
      DEPLOYMENT: "development",
      PLANE_ID: PLANE,
      ACCESS_TEAM_DOMAIN: team.teamDomain,
      ACCESS_AUD: AUD,
      OPERATORS: JSON.stringify([OPERATOR]),
      DISPATCHERS: JSON.stringify([OPERATOR]),
      FD_DEV_REPOSITORY: JSON.stringify(repository),
      LINK_KEY: "link-key-for-provenance-route-tests",
      LINK_EPOCH: "1",
    },
  });

/** A countersigned statement's envelope naming `digests` as its subjects. */
const envelope = (digests: readonly string[]) =>
  JSON.stringify({
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(
      JSON.stringify({
        _type: "https://in-toto.io/Statement/v1",
        subject: digests.map((d, i) => ({ name: `artifact-${i}`, digest: { sha256: d } })),
        predicateType: "https://slsa.dev/provenance/v1",
        predicate: {},
      }),
    ).toString("base64"),
    signatures: [{ keyid: "device", sig: "c2ln" }],
  });

/** Records one logged statement as the log-append drain leaves it. */
const record = async (
  mf: Miniflare,
  statement: { digest: string; execution: string; repository: string; subjects: string[] },
) => {
  const db = await mf.getD1Database("DB");
  for (const sql of LOG_APPEND_SCHEMA) await db.prepare(sql).run();
  await db
    .prepare(
      `insert into provenance_log_appends (envelope_digest, execution_id, repository, log, envelope, verifiers,
         attempts, next_attempt_at, log_index, entry_id, integrated_time, inserted_at)
       values (?, ?, ?, ?, ?, '[]', 1, null, ?, ?, ?, ?)`,
    )
    .bind(
      statement.digest,
      statement.execution,
      statement.repository,
      statement.repository === PUBLIC_REPO ? "rekor" : "private",
      envelope(statement.subjects),
      statement.repository === PUBLIC_REPO ? 41 : 3,
      `entry-${statement.digest}`,
      Date.now(),
      Date.now(),
    )
    .run();
  for (const subject of statement.subjects)
    await db
      .prepare(
        "insert into provenance_statement_subjects (subject_digest, envelope_digest) values (?, ?)",
      )
      .bind(`sha256:${subject}`, statement.digest)
      .run();
};

const seed = async (mf: Miniflare) => {
  await record(mf, {
    digest: "sha256:public-statement",
    execution: PUBLIC_EXECUTION,
    repository: PUBLIC_REPO,
    subjects: [LIB],
  });
  await record(mf, {
    digest: "sha256:private-statement",
    execution: PRIVATE_EXECUTION,
    repository: PRIVATE_REPO,
    subjects: [APP, LIB],
  });
};

beforeAll(async () => {
  team = await startAccessTeam();
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "../src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  script = bundle.outputFiles[0]!.text;
  open = miniflare(captured("public"));
  unread = miniflare(captured());
  await Promise.all([open.ready, unread.ready]);
  await Promise.all([seed(open), seed(unread)]);
});

afterAll(async () => {
  await Promise.all([open?.dispose(), unread?.dispose()]);
  await team?.close();
});

const lookup = async (mf: Miniflare, path: string, identity?: string) =>
  mf.dispatchFetch(`http://x${path}`, {
    headers: identity === undefined ? {} : { "cf-access-jwt-assertion": await team.jwt(identity) },
  });

const digestsOf = async (response: { json(): Promise<unknown> }) =>
  ((await response.json()) as { statements: { envelope_digest: string }[] }).statements.map(
    (s) => s.envelope_digest,
  );

const errorOf = async (response: { json(): Promise<unknown> }) =>
  ((await response.json()) as { error: string }).error;

describe("the provenance routes", () => {
  it("[FD-IFC-053] serves a public repository's statements to a caller without identity", async () => {
    const byExecution = await lookup(open, `/v1/provenance/executions/${PUBLIC_EXECUTION}`);
    expect(byExecution.status).toBe(200);
    const body = (await byExecution.json()) as { statements: Record<string, unknown>[] };
    expect(body.statements).toHaveLength(1);
    expect(body.statements[0]).toMatchObject({
      envelope_digest: "sha256:public-statement",
      execution_id: PUBLIC_EXECUTION,
      log: "rekor",
      status: "logged",
      log_index: 41,
      subjects: [{ name: "artifact-0", digest: `sha256:${LIB}` }],
    });
    // A subject both repositories' statements name answers only the public repository's without identity.
    const bySubject = await lookup(open, `/v1/provenance/subjects/sha256:${LIB}`);
    expect(bySubject.status).toBe(200);
    expect(await digestsOf(bySubject)).toEqual(["sha256:public-statement"]);
  });

  it("[FD-IFC-054] requires an Access JWT for the statements of a repository whose visibility is not public", async () => {
    // A repository no installation reads, and one whose visibility the deployment did not capture, are not public.
    for (const [mf, path] of [
      [open, `/v1/provenance/executions/${PRIVATE_EXECUTION}`],
      [open, `/v1/provenance/subjects/sha256:${APP}`],
      [unread, `/v1/provenance/executions/${PUBLIC_EXECUTION}`],
      [unread, `/v1/provenance/subjects/sha256:${LIB}`],
      [open, "/v1/provenance/log/proof/inclusion?leaf_index=3"],
    ] as const) {
      const response = await lookup(mf, path);
      expect(response.status, path).toBe(401);
      expect(await errorOf(response), path).toBe("unauthenticated");
    }
    // An Access identity reads every statement.
    const member = "member@example.com";
    expect(
      await digestsOf(await lookup(open, `/v1/provenance/executions/${PRIVATE_EXECUTION}`, member)),
    ).toEqual(["sha256:private-statement"]);
    expect(
      await digestsOf(
        await lookup(unread, `/v1/provenance/executions/${PUBLIC_EXECUTION}`, member),
      ),
    ).toEqual(["sha256:public-statement"]);
    expect(
      (await digestsOf(await lookup(open, `/v1/provenance/subjects/sha256:${LIB}`, member))).sort(),
    ).toEqual(["sha256:private-statement", "sha256:public-statement"]);
    // A token the team did not sign is refused, never served as no identity.
    const forged = await open.dispatchFetch(`http://x/v1/provenance/subjects/sha256:${LIB}`, {
      headers: { "cf-access-jwt-assertion": "e30.e30.c2ln" },
    });
    expect(forged.status).toBe(403);
  });
});
