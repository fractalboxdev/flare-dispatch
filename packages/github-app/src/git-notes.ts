import { GithubApiError } from "./errors";
import { assertOk, ghHeaders, resolveClient, splitRepo } from "./http";

export type AppendGitNoteOptions = {
  readonly token: string;
  readonly repo: string;
  readonly commit: string;
  readonly text: string;
  readonly ref?: string;
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
};

/** Append one report to the measured commit's git note, retrying ref races. */
export const appendGitNote = async (opts: AppendGitNoteOptions): Promise<void> => {
  if (!/^[0-9a-f]{40}$/.test(opts.commit)) {
    throw new GithubApiError("git note requires a full commit SHA", 0, "");
  }
  const ref = opts.ref ?? "measures";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) ||
    ref.split("/").some((s) => s === ".." || s === ".")
  ) {
    throw new GithubApiError("invalid git notes ref", 0, "");
  }
  const { owner, name } = splitRepo(opts.repo);
  const { apiBase, doFetch } = resolveClient(opts);
  const base = `${apiBase}/repos/${owner}/${name}`;
  const headers = ghHeaders(opts.token, { json: true });
  const api = async <T>(
    path: string,
    method = "GET",
    body?: unknown,
    missing = false,
  ): Promise<{ status: number; value: T }> => {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!(missing && response.status === 404))
      await assertOk(response, `git note ${method} ${path} failed`);
    return { status: response.status, value: (await response.json().catch(() => ({}))) as T };
  };
  // `git notes append` uses the flat 40-hex path for a new notes ref. Preserve
  // an existing fanout path when Git has compacted the tree into 2/38 form.
  const flatPath = opts.commit;
  const fanoutPath = `${opts.commit.slice(0, 2)}/${opts.commit.slice(2)}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await api<{ object?: { sha?: string } }>(
      `/git/ref/notes/${ref}`,
      "GET",
      undefined,
      true,
    );
    const parent = head.status === 404 ? undefined : head.value.object?.sha;
    if (head.status !== 404 && !parent)
      throw new GithubApiError("notes ref has no commit", head.status, "");
    let treeSha: string | undefined;
    let path = flatPath;
    let previous = "";
    if (parent) {
      const commit = await api<{ tree?: { sha?: string } }>(`/git/commits/${parent}`);
      treeSha = commit.value.tree?.sha;
      if (!treeSha) throw new GithubApiError("notes commit has no tree", commit.status, "");
      const tree = await api<{ tree?: Array<{ path?: string; sha?: string; type?: string }> }>(
        `/git/trees/${treeSha}?recursive=1`,
      );
      const entry = tree.value.tree?.find(
        (item) => (item.path === flatPath || item.path === fanoutPath) && item.type === "blob",
      );
      path = entry?.path ?? flatPath;
      if (entry?.sha) {
        const blob = await api<{ content?: string; encoding?: string }>(`/git/blobs/${entry.sha}`);
        if (blob.value.encoding !== "base64" || typeof blob.value.content !== "string") {
          throw new GithubApiError("note blob is not base64", blob.status, "");
        }
        previous = new TextDecoder().decode(
          Uint8Array.from(atob(blob.value.content.replace(/\s/g, "")), (c) => c.charCodeAt(0)),
        );
      }
    }
    // Workflow replay may repeat the write after a successful GitHub response.
    if (previous.split("\n").includes(opts.text)) return;
    const content =
      previous.length === 0 ? `${opts.text}\n` : `${previous.trimEnd()}\n\n${opts.text}\n`;
    const blob = await api<{ sha: string }>("/git/blobs", "POST", { content, encoding: "utf-8" });
    const tree = await api<{ sha: string }>("/git/trees", "POST", {
      ...(treeSha ? { base_tree: treeSha } : {}),
      tree: [{ path, mode: "100644", type: "blob", sha: blob.value.sha }],
    });
    const next = await api<{ sha: string }>("/git/commits", "POST", {
      message: `Attach measures for ${opts.commit}`,
      tree: tree.value.sha,
      parents: parent ? [parent] : [],
    });
    const result = await doFetch(`${base}/git/refs${parent ? `/notes/${ref}` : ""}`, {
      method: parent ? "PATCH" : "POST",
      headers,
      body: JSON.stringify(
        parent
          ? { sha: next.value.sha, force: false }
          : { ref: `refs/notes/${ref}`, sha: next.value.sha },
      ),
    });
    if (result.ok) return;
    // A concurrent writer advanced or created the ref. Re-read and append.
    if (result.status === 409 || result.status === 422) continue;
    await assertOk(result, "git note ref update failed");
  }
  throw new GithubApiError("git note ref changed during four append attempts", 409, "");
};
