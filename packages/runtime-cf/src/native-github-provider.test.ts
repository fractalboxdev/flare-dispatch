import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { NativeRequest } from "@fractalboxdev/flare-dispatch-core";
import { makeNativeGithubProvider } from "./native-github-provider";

const request: NativeRequest = {
  repo: "owner/context", head: "1".repeat(40), base: "2".repeat(40), executor_ref: "3".repeat(40),
  nonce: "native-0123456789abcdef", target: "aarch64-pc-windows-msvc", mode: "gate", profile: "",
  command_sha256: "e964c83ffcc2427c138b484a6fc61f7ebcf70b59186899176e48da89516bb2da",
};
const apiRun = (id = 456) => ({
  id, run_attempt: 1, event: "workflow_dispatch", head_sha: request.executor_ref,
  path: ".github/workflows/native-windows.yml", display_title: `native-${request.nonce}`,
  repository: { full_name: request.repo }, actor: { login: "native-controller[bot]", type: "Bot" },
  extra_api_field: "unused metadata",
});
const runEffect = Effect.runPromise;

describe("authenticated native GitHub provider", () => {
  it("POSTs one admitted literal request at its fixed executor revision", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const provider = makeNativeGithubProvider({ repo: request.repo, token: "fixture-installation", fetchImpl });
    await runEffect(provider.dispatch(request));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/owner/context/actions/workflows/native-windows.yml/dispatches");
    expect(JSON.parse(String(init.body))).toEqual({ ref: request.executor_ref, inputs: { request: JSON.stringify(request) } });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-installation");
    expect(init.redirect).toBe("error");
  });

  it("decodes complete paginated API run identity without using workload metadata", async () => {
    let pages = 0;
    const fetchImpl = vi.fn(async () => {
      pages++;
      return pages === 1
        ? Response.json({ total_count: 2, workflow_runs: [{ ...apiRun(455), display_title: "native-unrelated" }] }, {
          headers: { link: '<https://api.github.com/repos/owner/context/actions/workflows/native-windows.yml/runs?event=workflow_dispatch&per_page=25&page=2>; rel="next"' },
        })
        : Response.json({ total_count: 2, workflow_runs: [apiRun()] });
    });
    const provider = makeNativeGithubProvider({ repo: request.repo, token: "fixture-installation", fetchImpl });
    const runs = await runEffect(provider.listRuns(request));
    expect(runs).toHaveLength(2);
    expect(runs[1]).toEqual({
      repo: request.repo, runId: 456, runAttempt: 1, event: "workflow_dispatch",
      executorRef: request.executor_ref, workflowPath: ".github/workflows/native-windows.yml",
      runName: `native-${request.nonce}`, actorLogin: "native-controller[bot]", actorType: "Bot",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses cross-repository, invalid command and missing credentials before HTTP", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const provider = makeNativeGithubProvider({ repo: request.repo, token: "fixture-installation", fetchImpl });
    for (const invalid of [
      { ...request, repo: "other/context" }, { ...request, command_sha256: "4".repeat(64) },
      { ...request, head: "main" }, { ...request, profile: "contextful-full" },
    ]) {
      await expect(runEffect(provider.dispatch(invalid))).rejects.toThrow();
      await expect(runEffect(provider.listRuns(invalid))).rejects.toThrow();
    }
    await expect(runEffect(makeNativeGithubProvider({ repo: request.repo, token: "", fetchImpl })
      .dispatch(request))).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses incomplete pages and malformed run evidence as errors rather than empty absence", async () => {
    for (const body of [
      { total_count: 2, workflow_runs: [apiRun()] },
      { total_count: 1, workflow_runs: [{ ...apiRun(), actor: null }] },
      { total_count: 1, workflow_runs: [{ ...apiRun(), run_attempt: 0 }] },
      { total_count: 1, workflow_runs: [{ ...apiRun(), id: Number.MAX_SAFE_INTEGER + 1 }] },
    ]) {
      const provider = makeNativeGithubProvider({ repo: request.repo, token: "fixture-installation",
        fetchImpl: async () => Response.json(body) });
      await expect(runEffect(provider.listRuns(request))).rejects.toThrow();
    }
  });

  it("sanitizes ambiguous network errors without retrying the POST", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("fixture secret network diagnostic"); });
    const outcome = await runEffect(makeNativeGithubProvider({ repo: request.repo,
      token: "fixture-installation", fetchImpl }).dispatch(request).pipe(Effect.either));
    expect(outcome).toHaveProperty("left.reason", "native GitHub dispatch outcome uncertain");
    expect(JSON.stringify(outcome)).not.toContain("fixture secret network diagnostic");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
