// The device executor's `GithubRead` Layer against a GitHub stand-in over HTTP: every read answers GitHub's value, and
// every failed read fails with `GithubUncredentialed` or `GithubReadFailed`, never an empty or absent answer
// (specs/run-model.md § `GithubRead`).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  GithubRead,
  githubReadLayer,
  type GithubReadError,
} from "@fractalboxdev/flare-dispatch-catalog";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = "acme/app";
const SHA = "a".repeat(40);
const TAG_OBJECT = "b".repeat(40);

/** What the stand-in answers on every path while a scenario runs. */
type Answer =
  | { readonly kind: "json"; readonly status: number; readonly body: unknown }
  | { readonly kind: "text"; readonly status: number; readonly body: string }
  | { readonly kind: "drop" };

const healthy: Readonly<Record<string, unknown>> = {
  [`/repos/${REPO}/git/ref/heads/main`]: { object: { sha: SHA, type: "commit" } },
  [`/repos/${REPO}/git/ref/tags/v1.0.0`]: { object: { sha: TAG_OBJECT, type: "tag" } },
  [`/repos/${REPO}/git/tags/${TAG_OBJECT}`]: { object: { sha: SHA, type: "commit" } },
  [`/repos/${REPO}/compare/main...${SHA}`]: { status: "behind" },
};

let answer: ((path: string) => Answer) | undefined;
const seen: string[] = [];
let server: Server;
let apiBase = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    seen.push(path);
    const a: Answer = answer?.(path) ?? { kind: "json", status: 200, body: healthy[path] ?? {} };
    if (a.kind === "drop") return req.socket.destroy();
    res.writeHead(a.status, { "content-type": "application/json" });
    res.end(a.kind === "json" ? JSON.stringify(a.body) : a.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Read = (g: GithubRead["Service"]) => Effect.Effect<unknown, GithubReadError>;

const reads: Readonly<Record<"branchHead" | "tagCommit" | "reachableFrom", Read>> = {
  branchHead: (g: GithubRead["Service"]) => g.branchHead(REPO, "main"),
  tagCommit: (g: GithubRead["Service"]) => g.tagCommit(REPO, "v1.0.0"),
  reachableFrom: (g: GithubRead["Service"]) => g.reachableFrom(REPO, SHA, "main"),
};

/** The read's value, or the tag of the typed error it failed with; a defect rejects. */
const outcome = (read: Read, base = apiBase) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return { succeeded: yield* read(yield* GithubRead) } as
        | { readonly succeeded: unknown }
        | { readonly failed: string };
    }).pipe(
      Effect.catchTags({
        GithubUncredentialed: () => Effect.succeed({ failed: "GithubUncredentialed" }),
        GithubReadFailed: () => Effect.succeed({ failed: "GithubReadFailed" }),
      }),
      Effect.provide(githubReadLayer({ apiBase: base, fetch: globalThis.fetch })),
    ),
  );

describe("GithubRead against a GitHub stand-in", () => {
  it("[FD-RUN-017] answers GitHub's value for each read", async () => {
    answer = undefined;
    expect(await outcome(reads.branchHead)).toEqual({ succeeded: SHA });
    expect(await outcome(reads.tagCommit)).toEqual({ succeeded: SHA });
    expect(await outcome(reads.reachableFrom)).toEqual({ succeeded: true });
  });

  it("[FD-RUN-017] fails each read with GithubUncredentialed on 401 and GithubReadFailed on any other failure, never an empty answer", async () => {
    const failures: readonly [string, Answer, string][] = [
      [
        "401",
        { kind: "json", status: 401, body: { message: "Bad credentials" } },
        "GithubUncredentialed",
      ],
      ["403", { kind: "json", status: 403, body: { message: "Forbidden" } }, "GithubReadFailed"],
      ["404", { kind: "json", status: 404, body: { message: "Not Found" } }, "GithubReadFailed"],
      ["502", { kind: "json", status: 502, body: {} }, "GithubReadFailed"],
      ["an empty list", { kind: "json", status: 200, body: [] }, "GithubReadFailed"],
      ["an empty object", { kind: "json", status: 200, body: {} }, "GithubReadFailed"],
      ["null", { kind: "json", status: 200, body: null }, "GithubReadFailed"],
      [
        "a body that is not JSON",
        { kind: "text", status: 200, body: "<html>" },
        "GithubReadFailed",
      ],
      ["a dropped connection", { kind: "drop" }, "GithubReadFailed"],
    ];
    for (const [name, failing, tag] of failures)
      for (const [read, call] of Object.entries(reads)) {
        answer = () => failing;
        expect({ name, read, ...(await outcome(call)) }).toEqual({ name, read, failed: tag });
      }
    answer = undefined;
  });

  it("[FD-RUN-017] fails a peeled tag read when the annotated tag object's read fails", async () => {
    answer = (path) =>
      path === `/repos/${REPO}/git/tags/${TAG_OBJECT}`
        ? { kind: "json", status: 500, body: {} }
        : { kind: "json", status: 200, body: healthy[path] ?? {} };
    expect(await outcome(reads.tagCommit)).toEqual({ failed: "GithubReadFailed" });
    answer = undefined;
  });

  it("[FD-RUN-017] fails with GithubReadFailed when GitHub is unreachable", async () => {
    for (const read of Object.values(reads))
      expect(await outcome(read, "http://127.0.0.1:1")).toEqual({ failed: "GithubReadFailed" });
  });
});
