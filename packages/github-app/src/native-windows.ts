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

type DispatchOptions = NativeClient & {
  readonly executorRef: string; readonly dispatchRef: string; readonly request: Readonly<Record<string, unknown>>;
};
const revision = (raw: unknown): raw is string => typeof raw === "string" && /^[0-9a-f]{40}$/.test(raw);
const object = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new GithubApiError("native executor prerequisite metadata is malformed", 0, "");
  return raw as Record<string, unknown>;
};
const tagName = (ref: string): string => {
  if (typeof ref !== "string" || !ref.startsWith("refs/tags/") || ref.length > 200
    || !ref.slice(10).split("/").every(segment => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)
      && !segment.includes("..") && !segment.endsWith(".") && !segment.endsWith(".lock")))
    throw new GithubApiError("native dispatch reference must be a fully qualified release tag", 0, "");
  return ref.slice(10);
};

/**
 * Read-only proof precedes the durable POST claim. Published immutable releases lock their tag;
 * deleting a release cannot permit reusing its tag name. A later race can refuse, never select a new SHA.
 * The returned closure is ephemeral and single-use; only the durable controller owns when to invoke it.
 */
export const prepareNativeWindowsDispatch = async (raw: DispatchOptions): Promise<() => Promise<void>> => {
  const opts = { ...raw };
  if (!/^[0-9a-f]{40}$/.test(opts.executorRef))
    throw new GithubApiError("native executor revision is not immutable", 0, "");
  const tag = tagName(opts.dispatchRef);
  if (opts.request.executor_ref !== opts.executorRef || opts.request.dispatch_ref !== opts.dispatchRef)
    throw new GithubApiError("native dispatch request differs from its executor policy", 0, "");
  const body = JSON.stringify({ ref: opts.dispatchRef, inputs: { request: JSON.stringify(opts.request) } });
  const url = endpoint(opts, "workflows/native-windows.yml/dispatches");
  const base = `${resolveClient(opts).apiBase}/repos/${opts.repo}`;
  const read = async (suffix: string) => object((await readNativeJson(opts, `${base}/${suffix}`, 64 * 1024)).body);
  const refused = () => new GithubApiError("native executor release, tag or workflow proof refused", 0, "");
  const release = await read(`releases/tags/${encodeURIComponent(tag)}`);
  if (!Number.isSafeInteger(release.id) || (release.id as number) < 1 || release.url !== `${base}/releases/${release.id}`
    || release.tag_name !== tag || release.immutable !== true || release.draft !== false
    || typeof release.published_at !== "string" || !Number.isFinite(Date.parse(release.published_at))) throw refused();
  const ref = await read(`git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref.ref !== opts.dispatchRef) throw refused();
  let target = object(ref.object);
  const seen = new Set<string>();
  while (target.type === "tag") {
    if (!revision(target.sha) || seen.has(target.sha) || seen.size >= 8) throw refused();
    seen.add(target.sha);
    const annotated = await read(`git/tags/${target.sha}`);
    if (annotated.sha !== target.sha) throw refused();
    target = object(annotated.object);
  }
  if (target.type !== "commit" || target.sha !== opts.executorRef) throw refused();
  const workflow = await read("actions/workflows/native-windows.yml");
  if (!Number.isSafeInteger(workflow.id) || (workflow.id as number) < 1
    || workflow.path !== ".github/workflows/native-windows.yml" || workflow.state !== "active") throw refused();
  // Omitting ref is GitHub's default-branch Contents read; workflow metadata alone can outlive a deleted file.
  for (const suffix of ["", `?ref=${opts.executorRef}`]) {
    const file = await read(`contents/.github/workflows/native-windows.yml${suffix}`);
    if (file.type !== "file" || file.path !== ".github/workflows/native-windows.yml" || !revision(file.sha)
      || !Number.isSafeInteger(file.size) || (file.size as number) < 1 || (file.size as number) > 48 * 1024) throw refused();
  }
  let used = false;
  return async () => {
    if (used) throw new GithubApiError("native dispatch authority was already consumed", 0, "");
    used = true;
    const response = await resolveClient(opts).doFetch(url, {
      method: "POST", redirect: "manual", headers: ghHeaders(opts.token, { json: true }), body,
    });
    void response.body?.cancel().catch(() => {});
    if (response.status !== 204) throw new GithubApiError("native executor dispatch has an unexpected response", response.status, "");
  };
};

/** A durable controller admission precedes this single POST; ambiguous outcomes require read-only reconciliation. */
export const dispatchNativeWindows = async (opts: DispatchOptions): Promise<void> => (await prepareNativeWindowsDispatch(opts))();

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

export const readNativeWindowsRuns = async (opts: NativeClient & { readonly createdAfter?: string }): Promise<readonly unknown[]> => {
  const query = new URLSearchParams({ event:"workflow_dispatch", per_page:"25" });
  if (opts.createdAfter !== undefined) query.set("created", `>=${opts.createdAfter}`);
  return readPages(opts, `workflows/native-windows.yml/runs?${query}`, "workflow_runs");
};

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
  const archive = await doFetch(target, { method: "GET", redirect: "manual" });
  if (archive.status !== 200 || !archive.body) {
    void archive.body?.cancel().catch(() => {});
    throw new GithubApiError("native archive body is absent", archive.status, "");
  }
  return archive;
};
