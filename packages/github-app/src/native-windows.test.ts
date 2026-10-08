import { expect, it, vi } from "vitest";
import { dispatchNativeWindows, readNativeWindowsRuns, readNativeWindowsJobs, readNativeWindowsArtifacts, streamNativeWindowsArchive } from "./native-windows";

const options = { repo: "owner/name", token: "installation-token", executorRef: "a".repeat(40), request: { nonce: "native-0123456789abcdef" } };

it("refuses native evidence exceeding its byte ceiling before parsing page metadata", async () => {
  await expect(readNativeWindowsRuns({ ...options,
    fetchImpl: async () => Response.json({ workflow_runs: [], extra: "x".repeat(1024 * 1024) }),
  })).rejects.toMatchObject({ name: "GithubApiError", body: "" });
});

it("refuses invalid UTF-8 in unused native evidence fields", async () => {
  const start = new TextEncoder().encode('{"workflow_runs":[],"extra":"');
  const end = new TextEncoder().encode('"}');
  const bytes = new Uint8Array(start.length + 1 + end.length);
  bytes.set(start); bytes[start.length] = 255; bytes.set(end, start.length + 1);
  await expect(readNativeWindowsRuns({ ...options, fetchImpl: async () => new Response(bytes) }))
    .rejects.toMatchObject({ name: "GithubApiError", body: "" });
});

it("refuses empty producer chunks before they accumulate metadata without consuming the byte budget", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls <= 50) controller.enqueue(new Uint8Array());
      else { controller.enqueue(new TextEncoder().encode('{"workflow_runs":[]}')); controller.close(); }
    },
  });
  await expect(readNativeWindowsRuns({ ...options, fetchImpl: async () => new Response(body) }))
    .rejects.toMatchObject({ name: "GithubApiError", body: "" });
  expect(pulls).toBeLessThan(5);
});

it("bounds native evidence fetch and body reads even when a provider ignores its abort signal", async () => {
  vi.useFakeTimers();
  try {
    for (const stalledBody of [false, true]) {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const fetchImpl: typeof fetch = stalledBody
        ? async () => new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }))
        : async () => new Promise<Response>(() => {});
      const outcome = readNativeWindowsRuns({ ...options, fetchImpl }).then(
        () => ({ done: true, refused: false }), () => ({ done: true, refused: true }),
      );
      await vi.advanceTimersByTimeAsync(10001);
      const observed = await Promise.race([outcome, Promise.resolve({ done: false, refused: false })]);
      controller?.error(new Error("fixture finished"));
      expect(observed, String(stalledBody)).toEqual({ done: true, refused: true });
    }
  } finally { vi.useRealTimers(); }
});

it("dispatches the fixed native executor exactly once and never retries an ambiguous POST", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("provider unavailable", { status: 500 });
  };
  await expect(dispatchNativeWindows({ ...options, fetchImpl })).rejects.toThrow();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://api.github.com/repos/owner/name/actions/workflows/native-windows.yml/dispatches");
  expect(calls[0]?.init?.method).toBe("POST");
  expect(calls[0]?.init?.redirect).toBe("error");
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ ref: options.executorRef, inputs: { request: JSON.stringify(options.request) } });
});

it("reads a finite native-only run page without filtering away active nonce candidates", async () => {
  let url = "";
  const runs = await readNativeWindowsRuns({ ...options, fetchImpl: async (input) => {
    url = String(input);
    return Response.json({ workflow_runs: [{ id: 42, display_title: "native-0123456789abcdef", status: "queued" }] });
  } });
  expect(url).toBe("https://api.github.com/repos/owner/name/actions/workflows/native-windows.yml/runs?event=workflow_dispatch&per_page=25");
  expect(runs).toEqual([{ id: 42, display_title: "native-0123456789abcdef", status: "queued" }]);
});

it("binds finite job and artifact reads to the exact API run and attempt", async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    urls.push(String(url));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer installation-token");
    expect(init?.redirect).toBe("error");
    return Response.json({ jobs: [{ id: 4, labels: ["windows-11-arm"] }], artifacts: [{ id: 5 }] });
  };
  expect(await readNativeWindowsJobs({ ...options, fetchImpl, runId: 42, attempt: 2 })).toEqual([{ id: 4, labels: ["windows-11-arm"] }]);
  expect(await readNativeWindowsArtifacts({ ...options, fetchImpl, runId: 42 })).toEqual([{ id: 5 }]);
  expect(urls).toEqual([
    "https://api.github.com/repos/owner/name/actions/runs/42/attempts/2/jobs?per_page=25",
    "https://api.github.com/repos/owner/name/actions/runs/42/artifacts?per_page=25",
  ]);
});

it("refuses malformed repository/revision/run identifiers before issuing a request", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; return new Response(null, { status: 204 }); };
  await expect(dispatchNativeWindows({ ...options, repo: "owner/name/other", fetchImpl })).rejects.toThrow();
  await expect(dispatchNativeWindows({ ...options, executorRef: "main", fetchImpl })).rejects.toThrow();
  await expect(readNativeWindowsJobs({ ...options, runId: -1, attempt: 1, fetchImpl })).rejects.toThrow();
  expect(calls).toBe(0);
});

it("streams the API-bound archive without forwarding the installation credential to its redirect", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://artifact.example/archive.zip?signed=opaque" } })
      : new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };
  const response = await streamNativeWindowsArchive({ ...options, fetchImpl, artifactId: 5 });
  expect(await response.arrayBuffer()).toHaveProperty("byteLength", 3);
  expect(calls[0]?.url).toBe("https://api.github.com/repos/owner/name/actions/artifacts/5/zip");
  expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer installation-token");
  expect(calls[0]?.init?.redirect).toBe("manual");
  expect(new Headers(calls[1]?.init?.headers).has("authorization")).toBe(false);
  expect(calls[1]?.init?.redirect).toBe("error");
});

it("refuses unsafe archive redirects before contacting a second endpoint", async () => {
  for (const location of ["http://artifact.example/archive.zip", "https://user:secret@artifact.example/archive.zip", "/archive.zip"]) {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location } }); };
    await expect(streamNativeWindowsArchive({ ...options, fetchImpl, artifactId: 5 })).rejects.toThrow();
    expect(calls).toBe(1);
  }
});

it("reads every native evidence page before treating a nonce or job as absent", async () => {
  for (const [read, suffix, key] of [
    [readNativeWindowsRuns, "workflows/native-windows.yml/runs?event=workflow_dispatch&per_page=25", "workflow_runs"],
    [(opts: typeof options & { fetchImpl: typeof fetch }) => readNativeWindowsJobs({ ...opts, runId: 42, attempt: 2 }), "runs/42/attempts/2/jobs?per_page=25", "jobs"],
    [(opts: typeof options & { fetchImpl: typeof fetch }) => readNativeWindowsArtifacts({ ...opts, runId: 42 }), "runs/42/artifacts?per_page=25", "artifacts"],
  ] as const) {
    const first = `https://api.github.com/repos/owner/name/actions/${suffix}`;
    const calls: string[] = [];
    const records = await read({ ...options, fetchImpl: async (url, init) => {
      calls.push(String(url));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer installation-token");
      return calls.length === 1
        ? Response.json({ [key]: Array.from({ length: 25 }, (_, id) => ({ id })), total_count: 26 },
          { headers: { link: `<${first}&page=2>; rel="next"` } })
        : Response.json({ [key]: [{ id: 25 }], total_count: 26 });
    } });
    expect(records).toHaveLength(26);
    expect(records[25]).toEqual({ id: 25 });
    expect(calls).toEqual([first, `${first}&page=2`]);
  }
});

it("refuses incomplete, unsafe or over-budget native evidence rather than returning partial absence", async () => {
  for (const link of [undefined, "<https://other.example/runs?page=2>; rel=\"next\"",
    "<https://api.github.com/repos/owner/name/actions/workflows/native-windows.yml/runs?event=workflow_dispatch&per_page=25&page=3>; rel=\"next\""]) {
    let calls = 0;
    await expect(readNativeWindowsRuns({ ...options, fetchImpl: async () => {
      calls++;
      return Response.json({ workflow_runs: Array.from({ length: 25 }, (_, id) => ({ id })), total_count: 26 },
        { headers: link === undefined ? {} : { link } });
    } })).rejects.toThrow();
    expect(calls).toBe(1);
  }
  let calls = 0;
  await expect(readNativeWindowsRuns({ ...options, fetchImpl: async () => {
    calls++;
    const next = `https://api.github.com/repos/owner/name/actions/workflows/native-windows.yml/runs?event=workflow_dispatch&per_page=25&page=${calls + 1}`;
    return Response.json({ workflow_runs: Array.from({ length: 25 }, (_, id) => ({ id: calls * 25 + id })), total_count: 125 },
      { headers: { link: `<${next}>; rel="next"` } });
  } })).rejects.toThrow();
  expect(calls).toBe(4);
});
