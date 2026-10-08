import { GithubApiError } from "./errors";
import { ghHeaders, resolveClient } from "./http";
import { readNativeJson } from "./native-json";

type NativeClient = {
  readonly repo: string; readonly token: string;
  readonly apiBase?: string; readonly fetchImpl?: typeof fetch;
};

const endpoint = (opts: NativeClient, suffix: string): string => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo))
    throw new GithubApiError("native repository identity is malformed", 0, "");
  return `${resolveClient(opts).apiBase}/repos/${opts.repo}/actions/${suffix}`;
};
const positiveId = (id: number): number => {
  if (!Number.isSafeInteger(id) || id < 1) throw new GithubApiError("native API identity is malformed", 0, "");
  return id;
};

/** A durable controller admission precedes this single POST; ambiguous outcomes require read-only reconciliation. */
export const dispatchNativeWindows = async (opts: NativeClient & {
  readonly executorRef: string; readonly request: Readonly<Record<string, unknown>>;
}): Promise<void> => {
  if (!/^[0-9a-f]{40}$/.test(opts.executorRef))
    throw new GithubApiError("native executor revision is not immutable", 0, "");
  const url = endpoint(opts, "workflows/native-windows.yml/dispatches");
  const response = await resolveClient(opts).doFetch(url, {
    method: "POST", redirect: "error", headers: ghHeaders(opts.token, { json: true }),
    body: JSON.stringify({ ref: opts.executorRef, inputs: { request: JSON.stringify(opts.request) } }),
  });
  void response.body?.cancel().catch(() => {});
  if (response.status !== 204) throw new GithubApiError("native executor dispatch has an unexpected response", response.status, "");
};

/** Four authenticated pages are complete evidence or a refusal, never a partial absence. */
const readPages = async (opts: NativeClient, suffix: string, key: string): Promise<readonly unknown[]> => {
  const first = new URL(endpoint(opts, suffix));
  const records: unknown[] = [];
  for (let page = 1; page <= 4; page++) {
    const url = new URL(first);
    if (page > 1) url.searchParams.set("page", String(page));
    const { body, headers } = await readNativeJson(opts, url.toString(), 1024 * 1024);
    if (typeof body !== "object" || body === null || !(key in body))
      throw new GithubApiError("native executor evidence page is malformed", 0, "");
    const object = body as Record<string, unknown>;
    const entries = object[key];
    if (!Array.isArray(entries) || entries.length > 25)
      throw new GithubApiError("native executor evidence page exceeds its finite bound", 0, "");
    records.push(...entries);
    const total = object.total_count;
    if (total !== undefined && (typeof total !== "number" || !Number.isSafeInteger(total) || total < records.length))
      throw new GithubApiError("native executor evidence count is inconsistent", 0, "");

    const header = headers.get("link");
    const next: string[] = [];
    if (header !== null) {
      if (header.length > 8192) throw new GithubApiError("native evidence pagination is malformed", 0, "");
      for (const part of header.split(",")) {
        const match = /^\s*<([^>]+)>\s*;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
        if (!match) throw new GithubApiError("native evidence pagination is malformed", 0, "");
        if (match[2] === "next") next.push(match[1]!);
      }
    }
    if (next.length === 0) {
      if (typeof total === "number" && total !== records.length)
        throw new GithubApiError("native executor evidence is incomplete", 0, "");
      // The Effect service decodes every member against the admitted request before using it.
      return records;
    }
    if (next.length !== 1) throw new GithubApiError("native evidence next page is ambiguous", 0, "");
    let target: URL;
    try { target = new URL(next[0]!); } catch {
      throw new GithubApiError("native evidence next page is malformed", 0, "");
    }
    const expected = new URL(first);
    expected.searchParams.set("page", String(page + 1));
    const params = [...target.searchParams];
    if (target.origin !== expected.origin || target.pathname !== expected.pathname
      || target.username !== "" || target.password !== "" || target.hash !== ""
      || params.length !== [...expected.searchParams].length
      || params.some(([name, value]) => target.searchParams.getAll(name).length !== 1
        || expected.searchParams.get(name) !== value))
      throw new GithubApiError("native evidence next page changes its authenticated scope", 0, "");
  }
  throw new GithubApiError("native executor evidence exceeds its pagination budget", 0, "");
};

export const readNativeWindowsRuns = async (opts: NativeClient): Promise<readonly unknown[]> =>
  readPages(opts, "workflows/native-windows.yml/runs?event=workflow_dispatch&per_page=25", "workflow_runs");

/** A durable binding selects one immutable run attempt without scanning workflow history. */
export const readNativeWindowsRun = async (opts: NativeClient & {
  readonly runId: number; readonly attempt: number;
}): Promise<unknown> => (await readNativeJson(opts,
  endpoint(opts, `runs/${positiveId(opts.runId)}/attempts/${positiveId(opts.attempt)}`), 1024 * 1024)).body;

export const readNativeWindowsJobs = async (opts: NativeClient & {
  readonly runId: number; readonly attempt: number;
}): Promise<readonly unknown[]> =>
  readPages(opts, `runs/${positiveId(opts.runId)}/attempts/${positiveId(opts.attempt)}/jobs?per_page=25`, "jobs");

export const readNativeWindowsArtifacts = async (opts: NativeClient & {
  readonly runId: number;
}): Promise<readonly unknown[]> =>
  readPages(opts, `runs/${positiveId(opts.runId)}/artifacts?per_page=25`, "artifacts");

/** Only the authenticated API request carries the installation token; archive bytes remain streamed. */
export const streamNativeWindowsArchive = async (opts: NativeClient & {
  readonly artifactId: number;
}): Promise<Response> => {
  const { doFetch } = resolveClient(opts);
  const response = await doFetch(endpoint(opts, `artifacts/${positiveId(opts.artifactId)}/zip`), {
    method: "GET", redirect: "manual", headers: ghHeaders(opts.token),
  });
  if (response.status !== 302)
    throw new GithubApiError("native archive has no API-bound redirect", response.status, "");
  const location = response.headers.get("location");
  if (!location) throw new GithubApiError("native archive redirect is absent", 0, "");
  const target = new URL(location);
  if (target.protocol !== "https:" || target.username || target.password)
    throw new GithubApiError("native archive redirect is unsafe", 0, "");
  const archive = await doFetch(target, { method: "GET", redirect: "error" });
  if (archive.status !== 200 || !archive.body) {
    void archive.body?.cancel().catch(() => {});
    throw new GithubApiError("native archive body is absent", archive.status, "");
  }
  return archive;
};
