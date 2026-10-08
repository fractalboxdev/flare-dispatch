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
  created_at:"2026-10-08T00:00:00Z",
});
const admission = Date.parse("2026-10-08T00:05:00Z") / 1000;
const runEffect = Effect.runPromise;

describe("authenticated native GitHub provider", () => {
  it("refuses omitted or invalid durable admission time before any discovery HTTP", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ total_count:0, workflow_runs:[] }));
    const provider = makeNativeGithubProvider({ repo:request.repo, token:"fixture-installation", fetchImpl });
    for (const value of [undefined, null, "2026-10-08T00:05:00Z", 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER])
      await expect(runEffect(provider.listRuns(request, value))).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses pagination that drops the immutable created filter", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ total_count:2, workflow_runs:[apiRun()] }, { headers:{
      link:'<https://api.github.com/repos/owner/context/actions/workflows/native-windows.yml/runs?event=workflow_dispatch&per_page=25&page=2>; rel="next"',
    } }));
    const provider = makeNativeGithubProvider({ repo:request.repo, token:"fixture-installation", fetchImpl });
    await expect(runEffect(provider.listRuns(request, admission))).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  const completedRun = () => ({ ...apiRun(), status: "completed", conclusion: "success" });
  const completedJob = () => ({ id: 789, run_id: 456, head_sha: request.executor_ref,
    name: "aarch64", status: "completed", conclusion: "success", labels: ["windows-11-arm"] });
  const artifact = () => ({ id: 987, name: `native-${request.nonce}`, expired: false,
    size_in_bytes: 123, workflow_run: { id: 456, head_sha: request.executor_ref } });
  const bound = { runId: 456, runAttempt: 1 };
  const collector = (runs: unknown[] = [completedRun()], jobs: unknown[] = [completedJob()], artifacts: unknown[] = [artifact()]) => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes("/attempts/1/jobs")) return Response.json({ total_count: jobs.length, jobs });
      if (path.includes("/runs/456/artifacts")) return Response.json({ total_count: artifacts.length, artifacts });
      if (path.endsWith("/runs/456/attempts/1")) return Response.json(runs.length === 1 ? runs[0] : null);
      return Response.json({ total_count: runs.length, workflow_runs: runs });
    });
    return { provider: makeNativeGithubProvider({ repo: request.repo, token: "fixture-installation", fetchImpl }), fetchImpl };
  };

  it("revalidates a bound run through its exact attempt without listing history", async () => {
    const { provider, fetchImpl } = collector();
    expect(await runEffect(provider.readRun(request, bound))).toMatchObject({ runId:456, runAttempt:1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.github.com/repos/owner/context/actions/runs/456/attempts/1");
    for (const altered of [apiRun(457), { ...apiRun(), run_attempt:2 }]) {
      const alteredProvider = collector([altered]).provider;
      await expect(runEffect(alteredProvider.readRun(request, bound))).rejects.toThrow();
    }
  });

  it("collects independent terminal API evidence and the exact artifact under the durable run binding", async () => {
    const { provider, fetchImpl } = collector();
    const evidence = await runEffect(provider.collect(request, bound, "native-controller[bot]"));
    expect(evidence.artifactId).toBe(987);
    expect(evidence.api).toEqual({
      repo: request.repo, runId: 456, runAttempt: 1, event: "workflow_dispatch",
      executorRef: request.executor_ref, workflowPath: ".github/workflows/native-windows.yml",
      runName: `native-${request.nonce}`, actorLogin: "native-controller[bot]", actorType: "Bot",
      status: "completed", conclusion: "success", job: "aarch64", jobStatus: "completed",
      jobConclusion: "success", labels: ["windows-11-arm"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("collects the exact bound run attempt even after workflow history exceeds the discovery budget", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/runs/456/attempts/1")) return Response.json(completedRun());
      if (path.endsWith("/attempts/1/jobs")) return Response.json({ total_count: 1, jobs: [completedJob()] });
      if (path.endsWith("/runs/456/artifacts")) return Response.json({ total_count: 1, artifacts: [artifact()] });
      return Response.json({ total_count: 101, workflow_runs: [completedRun()] });
    });
    const provider = makeNativeGithubProvider({ repo: request.repo, token: "fixture-installation", fetchImpl });
    expect((await runEffect(provider.collect(request, bound, "native-controller[bot]"))).artifactId).toBe(987);
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes("/workflows/"))).toBe(true);
  });

  it("refuses changed or ambiguous run bindings and authentic failed or live jobs", async () => {
    for (const runs of [[], [completedRun(), completedRun()],
      [{ ...completedRun(), id: 455 }], [{ ...completedRun(), run_attempt: 2 }],
      [{ ...completedRun(), actor: { login: "other-controller[bot]", type: "Bot" } }],
      [{ ...completedRun(), status: "in_progress", conclusion: null }],
      [{ ...completedRun(), conclusion: "failure" }],
    ]) await expect(runEffect(collector(runs).provider.collect(request, bound, "native-controller[bot]"))).rejects.toThrow();
    for (const jobs of [[], [completedJob(), completedJob()],
      [{ ...completedJob(), run_id: 455 }], [{ ...completedJob(), head_sha: request.head }],
      [{ ...completedJob(), name: "x86_64" }], [{ ...completedJob(), labels: ["windows-2025"] }],
      [{ ...completedJob(), status: "in_progress", conclusion: null }], [{ ...completedJob(), conclusion: "failure" }],
    ]) await expect(runEffect(collector(undefined, jobs).provider.collect(request, bound, "native-controller[bot]"))).rejects.toThrow();
  });

  it("refuses missing, duplicate, expired, oversized or foreign artifact identities before download", async () => {
    for (const artifacts of [[], [artifact(), artifact()],
      [{ ...artifact(), name: "native-unrelated" }], [{ ...artifact(), expired: true }],
      [{ ...artifact(), size_in_bytes: 8589934593 }],
      [{ ...artifact(), workflow_run: { id: 455, head_sha: request.executor_ref } }],
      [{ ...artifact(), workflow_run: { id: 456, head_sha: request.head } }],
    ]) {
      const { provider, fetchImpl } = collector(undefined, undefined, artifacts);
      await expect(runEffect(provider.collect(request, bound, "native-controller[bot]"))).rejects.toThrow();
      expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes("/zip"))).toBe(true);
    }
  });

  it("consumes every artifact page and refuses partial absence or changed authenticated scope", async () => {
    for (const broken of [false, "missing", "foreign"] as const) {
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        const path = String(url);
        if (path.includes("/attempts/1/jobs")) return Response.json({ total_count: 1, jobs: [completedJob()] });
        if (path.endsWith("/runs/456/attempts/1")) return Response.json(completedRun());
        if (path.includes("/runs/456/artifacts")) {
          if (new URL(path).searchParams.get("page") === "2") return Response.json({ total_count: 2, artifacts: [artifact()] });
          const next = broken === "foreign" ? "https://other.example/artifacts?page=2"
            : "https://api.github.com/repos/owner/context/actions/runs/456/artifacts?per_page=25&page=2";
          return Response.json({ total_count: 2, artifacts: [{ ...artifact(), id: 986, name: "unrelated" }] },
            broken === "missing" ? undefined : { headers: { link: `<${next}>; rel="next"` } });
        }
        return Response.json({ total_count: 1, workflow_runs: [completedRun()] });
      });
      const provider = makeNativeGithubProvider({ repo: request.repo, token: "fixture-installation", fetchImpl });
      if (broken) await expect(runEffect(provider.collect(request, bound, "native-controller[bot]"))).rejects.toThrow();
      else expect((await runEffect(provider.collect(request, bound, "native-controller[bot]"))).artifactId).toBe(987);
      expect(fetchImpl.mock.calls.every(([url]) => String(url).startsWith("https://api.github.com/repos/owner/context/"))).toBe(true);
    }
  });

  it("refuses malformed durable bindings and controller identity before any API request", async () => {
    const { provider, fetchImpl } = collector();
    for (const value of [{ ...bound, runId: 0 }, { ...bound, runAttempt: 0 },
      { ...bound, runId: Number.MAX_SAFE_INTEGER + 1 }, { ...bound, extra: true }])
      await expect(runEffect(provider.collect(request, value, "native-controller[bot]"))).rejects.toThrow();
    await expect(runEffect(provider.collect(request, bound, ""))).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

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
    const fetchImpl = vi.fn(async (raw: string | URL | Request) => {
      const url = new URL(String(raw));
      expect(url.searchParams.get("created")).toBe(">=2026-10-08T00:00:00Z");
      pages++;
      url.searchParams.set("page", "2");
      return pages === 1
        ? Response.json({ total_count: 2, workflow_runs: [{ ...apiRun(455), display_title: "native-unrelated" }] }, {
          headers: { link: `<${url}>; rel="next"` },
        })
        : Response.json({ total_count: 2, workflow_runs: [apiRun()] });
    });
    const provider = makeNativeGithubProvider({ repo: request.repo, token: "fixture-installation", fetchImpl });
    const runs = await runEffect(provider.listRuns(request, admission));
    expect(runs).toHaveLength(2);
    expect(runs[1]).toEqual({
      repo: request.repo, runId: 456, runAttempt: 1, event: "workflow_dispatch",
      executorRef: request.executor_ref, workflowPath: ".github/workflows/native-windows.yml",
      runName: `native-${request.nonce}`, actorLogin: "native-controller[bot]", actorType: "Bot",
      createdAt:apiRun().created_at,
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
      await expect(runEffect(provider.listRuns(invalid, admission))).rejects.toThrow();
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
      await expect(runEffect(provider.listRuns(request, admission))).rejects.toThrow();
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
