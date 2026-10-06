import { describe, expect, it, vi } from "vitest";
import { appendGitNote } from "./git-notes";

const sha = "a".repeat(40);
const one = "1".repeat(40);
const two = "2".repeat(40);
const three = "3".repeat(40);
const four = "4".repeat(40);
const ok = (value: unknown, status = 200) => Response.json(value, { status });
const options = {
  token: "test-token",
  repo: "owner/repo",
  commit: sha,
  text: '{"run_id":"new"}',
  apiBase: "https://api.example.test",
};

describe("appendGitNote", () => {
  it("creates refs/notes/measures without rewriting the measured branch", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      requests.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path.endsWith("/git/ref/notes/measures")) return ok({}, 404);
      if (path.endsWith("/git/blobs")) return ok({ sha: one }, 201);
      if (path.endsWith("/git/trees")) return ok({ sha: two }, 201);
      if (path.endsWith("/git/commits")) return ok({ sha: three }, 201);
      if (path.endsWith("/git/refs")) return ok({ ref: "refs/notes/measures" }, 201);
      throw new Error(`unexpected ${method} ${path}`);
    });
    await appendGitNote({ ...options, fetchImpl: fetchImpl as typeof fetch });
    expect(requests.map((r) => `${r.method} ${r.path.split("/repos/owner/repo")[1]}`)).toEqual([
      "GET /git/ref/notes/measures",
      "POST /git/blobs",
      "POST /git/trees",
      "POST /git/commits",
      "POST /git/refs",
    ]);
    expect(requests[2]?.body).toEqual({
      tree: [{ path: sha, mode: "100644", type: "blob", sha: one }],
    });
    expect(requests[4]?.body).toEqual({ ref: "refs/notes/measures", sha: three });
  });

  it("appends to an existing note and skips a repeated report", async () => {
    // Git's own `git notes append` separates reports with one blank line.
    const previous = '{"run_id":"old"}\n\n{"run_id":"older"}\n';
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      requests.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path.endsWith("/git/ref/notes/measures")) return ok({ object: { sha: one } });
      if (path.endsWith(`/git/commits/${one}`)) return ok({ tree: { sha: two } });
      if (path.endsWith(`/git/trees/${two}`))
        return ok({
          tree: [{ path: sha, type: "blob", sha: three }],
        });
      if (path.endsWith(`/git/blobs/${three}`))
        return ok({ encoding: "base64", content: btoa(previous) });
      if (path.endsWith("/git/blobs")) return ok({ sha: four }, 201);
      if (path.endsWith("/git/trees")) return ok({ sha: four }, 201);
      if (path.endsWith("/git/commits")) return ok({ sha: four }, 201);
      if (path.endsWith("/git/refs/notes/measures")) return ok({}, 200);
      throw new Error(`unexpected ${method} ${path}`);
    });
    await appendGitNote({ ...options, fetchImpl: fetchImpl as typeof fetch });
    const writtenBlob = requests.find((r) => r.method === "POST" && r.path.endsWith("/git/blobs"));
    expect((writtenBlob?.body as { content: string } | undefined)?.content).toBe(
      `${previous}\n${options.text}\n`,
    );
    expect(requests.at(-1)?.body).toEqual({ sha: four, force: false });
    const duplicate = await appendGitNote({
      ...options,
      text: '{"run_id":"old"}',
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(duplicate).toBeUndefined();
    expect(
      requests.filter((r) => r.method === "POST" && r.path.endsWith("/git/blobs")),
    ).toHaveLength(1);
  });

  it("re-reads the ref after a concurrent writer creates it", async () => {
    let refReads = 0;
    let refWrites = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      if (path.endsWith("/git/ref/notes/measures")) {
        refReads += 1;
        return refReads === 1 ? ok({}, 404) : ok({ object: { sha: one } });
      }
      if (path.endsWith(`/git/commits/${one}`)) return ok({ tree: { sha: two } });
      if (path.endsWith(`/git/trees/${two}`)) return ok({ tree: [] });
      if (path.endsWith("/git/blobs")) return ok({ sha: three }, 201);
      if (path.endsWith("/git/trees")) return ok({ sha: three }, 201);
      if (path.endsWith("/git/commits")) return ok({ sha: four }, 201);
      if (path.endsWith("/git/refs") && method === "POST") {
        refWrites += 1;
        return ok({}, 422);
      }
      if (path.endsWith("/git/refs/notes/measures") && method === "PATCH") {
        refWrites += 1;
        return ok({});
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    await appendGitNote({ ...options, fetchImpl: fetchImpl as typeof fetch });
    expect(refReads).toBe(2);
    expect(refWrites).toBe(2);
  });
});
