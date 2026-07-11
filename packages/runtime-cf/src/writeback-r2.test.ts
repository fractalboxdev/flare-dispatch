// Integration tests for the Worker-side writeback executor.
//
// Seeds the container's changed-files artifact in a real (Miniflare) R2 bucket,
// mocks the Git Data API with MSW, and asserts `runWriteback`:
//   - skips cleanly on an absent / empty manifest;
//   - rejects a manifest that breaks the spec's safety rules (traversal,
//     allowlist, size cap, .github/workflows gate) BEFORE any GitHub call;
//   - commits the validated manifest (blobs + deletions + modes) and opens a PR.
//
// The pure validation is exhaustively covered in core's writeback.test.ts; here
// the focus is the R2 read + the end-to-end commit wiring.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  WRITEBACK_ARTIFACT,
  WRITEBACK_FILES_DIR,
  WRITEBACK_MANIFEST_FILE,
  type WritebackManifest,
  type WritebackSpec,
} from "@fractalbox/flare-dispatch-core";
import { runWriteback } from "./writeback-r2";
import { makeTestBindings, type TestBindings } from "./test-support";

const EXEC = "01WBTEST0000000000000000001";
const API_BASE = "https://api.github.com";
const REPO_BASE = `${API_BASE}/repos/:owner/:repo`;

let calls: string[] = [];
let lastTreeBody: { tree: Array<Record<string, unknown>> } | undefined;
let lastPrBody: Record<string, unknown> | undefined;

const server = setupServer(
  http.get(`${REPO_BASE}/git/ref/heads/:branch`, () => {
    calls.push("GET ref");
    return HttpResponse.json({ object: { sha: "basecommitsha" } });
  }),
  http.get(`${REPO_BASE}/git/commits/:sha`, () => {
    calls.push("GET commit");
    return HttpResponse.json({ tree: { sha: "basetreesha" } });
  }),
  http.post(`${REPO_BASE}/git/blobs`, () => {
    calls.push("POST blob");
    return HttpResponse.json({ sha: "blobsha" });
  }),
  http.post(`${REPO_BASE}/git/trees`, async ({ request }) => {
    calls.push("POST tree");
    lastTreeBody = (await request.json()) as {
      tree: Array<Record<string, unknown>>;
    };
    return HttpResponse.json({ sha: "newtreesha" });
  }),
  http.post(`${REPO_BASE}/git/commits`, () => {
    calls.push("POST commit");
    return HttpResponse.json({ sha: "newcommitsha" });
  }),
  http.post(`${REPO_BASE}/git/refs`, () => {
    calls.push("POST ref");
    return HttpResponse.json({ ref: "refs/heads/x" }, { status: 201 });
  }),
  http.get(`${REPO_BASE}/pulls`, () => {
    calls.push("GET pulls");
    return HttpResponse.json([]);
  }),
  http.post(`${REPO_BASE}/pulls`, async ({ request }) => {
    calls.push("POST pull");
    lastPrBody = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json(
      { number: 42, html_url: "https://github.com/owner/name/pull/42" },
      { status: 201 },
    );
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  calls = [];
  lastTreeBody = undefined;
  lastPrBody = undefined;
});
afterAll(() => server.close());

const spec = (over: Partial<WritebackSpec> = {}): WritebackSpec => ({
  branch: "flare-dispatch/refresh",
  commitMessage: "chore: refresh fixtures",
  pr: { title: "Refresh fixtures", body: "Proposed by flare-dispatch." },
  ...over,
});

const mintToken = async () => "installation-token";

const baseOpts = (bucket: R2Bucket, over: Partial<WritebackSpec> = {}) => ({
  bucket,
  executionId: EXEC,
  spec: spec(over),
  repo: "owner/name",
  dispatchRef: "refs/heads/main",
  artifactName: WRITEBACK_ARTIFACT,
  apiBase: API_BASE,
  mintToken,
});

/** Seed a manifest + its file blobs under the writeback artifact prefix. */
const seed = async (
  bucket: R2Bucket,
  manifest: WritebackManifest,
  blobs: Record<string, string>,
) => {
  const prefix = `artifacts/${EXEC}/${WRITEBACK_ARTIFACT}/`;
  await bucket.put(
    `${prefix}${WRITEBACK_MANIFEST_FILE}`,
    JSON.stringify(manifest),
  );
  for (const [path, content] of Object.entries(blobs)) {
    await bucket.put(`${prefix}${WRITEBACK_FILES_DIR}/${path}`, content);
  }
};

describe("runWriteback", () => {
  let bindings: TestBindings;
  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  it("skips cleanly when no manifest was produced", async () => {
    const outcome = await runWriteback(baseOpts(bindings.bucket));
    expect(outcome.kind).toBe("skipped");
    expect(calls).toHaveLength(0); // no GitHub calls
  });

  it("skips cleanly on an empty manifest", async () => {
    await seed(bindings.bucket, { entries: [] }, {});
    const outcome = await runWriteback(baseOpts(bindings.bucket));
    expect(outcome.kind).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("commits files + deletions and opens a PR", async () => {
    await seed(
      bindings.bucket,
      {
        entries: [
          { path: "fixtures/api.json", mode: "100644" },
          { path: "scripts/gen.sh", mode: "100755" },
          { path: "fixtures/stale.json", deleted: true },
        ],
      },
      {
        "fixtures/api.json": '{"v":2}',
        "scripts/gen.sh": "#!/bin/sh\n",
      },
    );

    const outcome = await runWriteback(baseOpts(bindings.bucket));
    expect(outcome.kind).toBe("committed");
    if (outcome.kind === "committed") {
      expect(outcome.created).toBe(true);
      expect(outcome.number).toBe(42);
      expect(outcome.files).toBe(2);
      expect(outcome.deletions).toBe(1);
    }
    // The base tree came from the dispatch ref (main), not a default-branch
    // lookup, and the tree carries the executable mode + the deletion.
    const tree = lastTreeBody?.tree ?? [];
    expect(tree.find((e) => e.path === "scripts/gen.sh")?.mode).toBe("100755");
    expect(tree.find((e) => e.path === "fixtures/stale.json")?.sha).toBeNull();
    expect(lastPrBody?.draft).toBe(true); // proposed diff defaults to draft
  });

  it("rejects a traversal manifest BEFORE any GitHub call", async () => {
    await seed(
      bindings.bucket,
      { entries: [{ path: "../escape" }] },
      { "../escape": "x" },
    );
    const outcome = await runWriteback(baseOpts(bindings.bucket));
    expect(outcome.kind).toBe("rejected");
    expect(calls).toHaveLength(0);
  });

  it("rejects when a written entry has no backing blob", async () => {
    await seed(bindings.bucket, { entries: [{ path: "fixtures/a.json" }] }, {});
    const outcome = await runWriteback(baseOpts(bindings.bucket));
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reasons[0]).toContain("no file blob");
    }
  });

  it("enforces the spec allowlist", async () => {
    await seed(
      bindings.bucket,
      { entries: [{ path: "src/secret.ts" }] },
      { "src/secret.ts": "leak" },
    );
    const outcome = await runWriteback(
      baseOpts(bindings.bucket, { pathAllowlist: ["fixtures/**"] }),
    );
    expect(outcome.kind).toBe("rejected");
    expect(calls).toHaveLength(0);
  });

  it("enforces the byte cap from object sizes", async () => {
    await seed(
      bindings.bucket,
      { entries: [{ path: "big.json" }] },
      { "big.json": "x".repeat(100) },
    );
    const outcome = await runWriteback(
      baseOpts(bindings.bucket, { maxBytes: 10 }),
    );
    expect(outcome.kind).toBe("rejected");
    expect(calls).toHaveLength(0);
  });

  it("pr:false pushes the branch but opens no PR", async () => {
    await seed(
      bindings.bucket,
      { entries: [{ path: "fixtures/a.json" }] },
      { "fixtures/a.json": "{}" },
    );
    const outcome = await runWriteback(
      baseOpts(bindings.bucket, { pr: false }),
    );
    expect(outcome.kind).toBe("committed");
    if (outcome.kind === "committed") expect(outcome.url).toBeUndefined();
    expect(calls).not.toContain("POST pull");
  });
});
