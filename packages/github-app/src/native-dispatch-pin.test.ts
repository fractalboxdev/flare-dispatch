import { expect, it } from "vitest";
import { dispatchNativeWindows, prepareNativeWindowsDispatch } from "./native-windows";

const executorRef = "a".repeat(40);
const dispatchRef = "refs/tags/native-executor-v1";
const root = "https://api.github.com/repos/owner/context";
const options = { repo: "owner/context", token: "installation-token", executorRef, dispatchRef,
  request: { executor_ref: executorRef, dispatch_ref: dispatchRef, nonce: "native-0123456789abcdef" } };
const release = () => ({ id: 42, url: `${root}/releases/42`, tag_name: "native-executor-v1",
  immutable: true, draft: false, published_at: "2026-10-01T00:00:00Z" });
const reference = () => ({ ref: dispatchRef, object: { type: "commit", sha: executorRef } });
const workflow = () => ({ id: 7, path: ".github/workflows/native-windows.yml", state: "active" });
const file = () => ({ type: "file", path: ".github/workflows/native-windows.yml", sha: "b".repeat(40), size: 1024 });

const fixture = (overrides: Record<string, unknown> = {}, postStatus = 204) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const bodies: Record<string, unknown> = {
    [`${root}/releases/tags/native-executor-v1`]: release(),
    [`${root}/git/ref/tags/native-executor-v1`]: reference(),
    [`${root}/actions/workflows/native-windows.yml`]: workflow(),
    [`${root}/contents/.github/workflows/native-windows.yml`]: file(),
    [`${root}/contents/.github/workflows/native-windows.yml?ref=${executorRef}`]: file(),
    ...overrides,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer installation-token");
    if (init?.method === "POST") {
      expect(url).toBe(`${root}/actions/workflows/native-windows.yml/dispatches`);
      expect(JSON.parse(String(init.body))).toEqual({ ref: dispatchRef, inputs: { request: JSON.stringify(options.request) } });
      return new Response(null, { status: postStatus });
    }
    if (!(url in bodies)) return new Response(null, { status: 404 });
    return bodies[url] instanceof Response ? bodies[url] as Response : Response.json(bodies[url]);
  };
  return { calls, fetchImpl };
};

it("dispatches a live-proven immutable release tag, keeping the reviewed executor SHA in the request", async () => {
  const test = fixture();
  await dispatchNativeWindows({ ...options, fetchImpl: test.fetchImpl });
  expect(test.calls.map(call => call.url)).toEqual([
    `${root}/releases/tags/native-executor-v1`, `${root}/git/ref/tags/native-executor-v1`,
    `${root}/actions/workflows/native-windows.yml`,
    `${root}/contents/.github/workflows/native-windows.yml`,
    `${root}/contents/.github/workflows/native-windows.yml?ref=${executorRef}`,
    `${root}/actions/workflows/native-windows.yml/dispatches`,
  ]);
});

it("refuses mutable, missing, foreign and incorrectly pinned prerequisites before any dispatch", async () => {
  for (const overrides of [
    { [`${root}/releases/tags/native-executor-v1`]: { ...release(), immutable: false } },
    { [`${root}/releases/tags/native-executor-v1`]: { ...release(), immutable: undefined } },
    { [`${root}/releases/tags/native-executor-v1`]: { ...release(), draft: true } },
    { [`${root}/releases/tags/native-executor-v1`]: { ...release(), published_at: null } },
    { [`${root}/releases/tags/native-executor-v1`]: { ...release(), tag_name: "other" } },
    { [`${root}/releases/tags/native-executor-v1`]: { ...release(), url: "https://api.github.com/repos/foreign/context/releases/42" } },
    { [`${root}/git/ref/tags/native-executor-v1`]: { ...reference(), ref: "refs/heads/native-executor-v1" } },
    { [`${root}/git/ref/tags/native-executor-v1`]: { ...reference(), object: { type: "commit", sha: "c".repeat(40) } } },
    { [`${root}/actions/workflows/native-windows.yml`]: new Response(null, { status: 404 }) },
    { [`${root}/actions/workflows/native-windows.yml`]: { ...workflow(), state: "disabled_manually" } },
    { [`${root}/contents/.github/workflows/native-windows.yml`]: new Response(null, { status: 404 }) },
    { [`${root}/contents/.github/workflows/native-windows.yml?ref=${executorRef}`]: new Response(null, { status: 404 }) },
    { [`${root}/contents/.github/workflows/native-windows.yml?ref=${executorRef}`]: { ...file(), type: "symlink" } },
  ]) {
    const test = fixture(overrides);
    await expect(dispatchNativeWindows({ ...options, fetchImpl: test.fetchImpl })).rejects.toMatchObject({ name: "GithubApiError", body: "" });
    expect(test.calls.filter(call => call.init?.method === "POST"), JSON.stringify(overrides)).toHaveLength(0);
  }
});

it("peels authenticated annotated tags to a commit and refuses cycles, blobs and more than eight tag objects", async () => {
  const tagSha = "d".repeat(40);
  const tagUrl = `${root}/git/tags/${tagSha}`;
  const good = fixture({
    [`${root}/git/ref/tags/native-executor-v1`]: { ...reference(), object: { type: "tag", sha: tagSha } },
    [tagUrl]: { sha: tagSha, object: { type: "commit", sha: executorRef } },
  });
  await dispatchNativeWindows({ ...options, fetchImpl: good.fetchImpl });
  expect(good.calls.some(call => call.url === tagUrl)).toBe(true);
  for (const object of [{ type: "tag", sha: tagSha }, { type: "blob", sha: executorRef }]) {
    const test = fixture({
      [`${root}/git/ref/tags/native-executor-v1`]: { ...reference(), object: { type: "tag", sha: tagSha } },
      [tagUrl]: { sha: tagSha, object },
    });
    await expect(dispatchNativeWindows({ ...options, fetchImpl: test.fetchImpl })).rejects.toThrow();
    expect(test.calls.filter(call => call.init?.method === "POST")).toHaveLength(0);
    expect(test.calls.length).toBeLessThanOrEqual(3);
  }
  const chain: Record<string, unknown> = {
    [`${root}/git/ref/tags/native-executor-v1`]: { ...reference(), object: { type: "tag", sha: "1".repeat(40) } },
  };
  for (let index = 1; index <= 9; index++) chain[`${root}/git/tags/${String(index).repeat(40)}`] = {
    sha: String(index).repeat(40), object: { type: "tag", sha: String(index + 1).repeat(40) },
  };
  const bounded = fixture(chain);
  await expect(dispatchNativeWindows({ ...options, fetchImpl: bounded.fetchImpl })).rejects.toThrow();
  expect(bounded.calls.filter(call => call.url.includes("/git/tags/"))).toHaveLength(8);
  expect(bounded.calls.filter(call => call.init?.method === "POST")).toHaveLength(0);
});

it("refuses raw revisions, branches and malformed dispatch tags without network authority", async () => {
  for (const ref of [executorRef, "main", "refs/heads/main", "refs/tags/../escape", "refs/tags/a.lock", "refs/tags/a//b"]) {
    const test = fixture();
    await expect(dispatchNativeWindows({ ...options, dispatchRef: ref, fetchImpl: test.fetchImpl })).rejects.toThrow();
    expect(test.calls).toHaveLength(0);
  }
});

it("does not retry an ambiguous POST after immutable tag admission", async () => {
  const test = fixture({}, 500);
  await expect(dispatchNativeWindows({ ...options, fetchImpl: test.fetchImpl })).rejects.toThrow();
  expect(test.calls.filter(call => call.init?.method === "POST")).toHaveLength(1);
});

it("prepares read-only authority, freezes the admitted payload and consumes its POST closure only once", async () => {
  const test = fixture();
  const mutable = { ...options, request: { ...options.request }, fetchImpl: test.fetchImpl };
  const post = await prepareNativeWindowsDispatch(mutable);
  expect(test.calls.filter(call => call.init?.method === "POST")).toHaveLength(0);
  mutable.dispatchRef = "refs/heads/unreviewed";
  mutable.request.executor_ref = "f".repeat(40);
  await post();
  await expect(post()).rejects.toThrow();
  expect(test.calls.filter(call => call.init?.method === "POST")).toHaveLength(1);
});
