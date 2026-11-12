import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { nativeCommand } from "../core/src/native-windows";
import { nativeTestArchive } from "./src/testing/native-archive";

const migrations = await readD1Migrations(fileURLToPath(new URL("../../infra/migrations", import.meta.url)));
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
let calls: { method: string; path: string }[] = [];
let redirectApp = false;
let successful = false, lostDispatch = false, exactReads = 0;
const workload = { repo: "owner/context", head: "1".repeat(40), base: "2".repeat(40), executor_ref: "3".repeat(40),
  nonce: "native-0123456789abcdef", target: "aarch64-pc-windows-msvc" as const, mode: "gate" as const, profile: "" as const,
  command_sha256: "e964c83ffcc2427c138b484a6fc61f7ebcf70b59186899176e48da89516bb2da" };
const log = Buffer.from("verified native Workflow command\n");
const { mode: _mode, profile: _profile, ...receiptRequest } = workload;
const bytes = nativeTestArchive([{ path: "command.log", bytes: log }, { path: "receipt.json", bytes: Buffer.from(JSON.stringify({
  version: 1, ...receiptRequest, command: nativeCommand(workload), runner_os: "Windows", runner_arch: "ARM64",
  run_id: "123", run_attempt: "1", job: "aarch64", exit_code: 0, failure: null,
  started_at: "2026-10-08T00:00:00Z", completed_at: "2026-10-08T00:00:01Z",
  artifacts: [{ path: "command.log", bytes: log.length, sha256: createHash("sha256").update(log).digest("hex") }],
})) }]);
const fixtureControl = async (request: Request) => {
  const url = new URL(request.url);
  if (url.pathname === "/reset") { calls = []; redirectApp = url.searchParams.get("redirect") === "1";
    successful = url.searchParams.get("success") === "1"; lostDispatch = url.searchParams.get("lost") === "1"; exactReads = 0; }
  return Response.json({ calls });
};
const nativeApi = async (request: Request) => {
  const url = new URL(request.url);
  calls.push({ method: request.method, path: url.pathname });
  if (url.origin === "https://archive.example" && url.pathname === "/bytes")
    return request.headers.has("authorization") ? new Response(null, { status: 403 }) : new Response(bytes);
  if (url.origin !== "https://api.github.com") return new Response(null, { status: 503 });
  const app = ["/app", "/repos/owner/context/installation", "/app/installations/77/access_tokens"].includes(url.pathname);
  const authorization = request.headers.get("authorization") ?? "";
  const parts = authorization.slice("Bearer ".length).split(".");
  const validApp = /^Bearer [^.]+\.[^.]+\.[^.]+$/.test(authorization)
    && verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, "base64url"));
  if (app ? !validApp : authorization !== "Bearer fixture-native-installation-token")
    return new Response(null, { status: 401 });
  if (url.pathname === "/app") return redirectApp
    ? new Response(null, { status: 302, headers: { location: "https://redirect.example/secret" } })
    : Response.json({ id: 42, slug: "native-controller" });
  if (url.pathname === "/repos/owner/context/installation") return Response.json({ id: 77, app_id: 42,
    account: { login: "owner" }, suspended_at: null, permissions: { actions: "write" } });
  if (url.pathname === "/app/installations/77/access_tokens") return Response.json({ token: "fixture-native-installation-token",
    expires_at: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z"), repository_selection: "selected",
    repositories: [{ name: "context", full_name: "owner/context" }], permissions: { actions: "write", metadata: "read" } }, { status: 201 });
  if (url.pathname.endsWith("/dispatches")) return new Response(null, { status: lostDispatch ? 503 : 204 });
  const run = { id: 123, run_attempt: 1, event: "workflow_dispatch", head_sha: "3".repeat(40),
    path: ".github/workflows/native-windows.yml", display_title: "native-native-0123456789abcdef", repository: { full_name: "owner/context" },
    actor: { login: "native-controller[bot]", type: "Bot" }, created_at: new Date().toISOString(), status: "completed", conclusion: successful ? "success" : "cancelled" };
  if (url.pathname.endsWith("/native-windows.yml/runs")) return Response.json({ total_count: 1, workflow_runs: [run] });
  if (url.pathname.endsWith("/attempts/1")) { exactReads++;
    return Response.json(successful && exactReads === 1 ? { ...run, status: "in_progress", conclusion: null } : run); }
  if (url.pathname.endsWith("/jobs")) return Response.json({ total_count: 1, jobs: [{ id: 456, run_id: 123,
    head_sha: workload.executor_ref, name: "aarch64", status: "completed", conclusion: "success", labels: ["windows-11-arm"] }] });
  if (url.pathname.endsWith("/artifacts")) return Response.json({ total_count: 1, artifacts: [{ id: 789,
    name: `native-${workload.nonce}`, expired: false, size_in_bytes: bytes.length, workflow_run: { id: 123, head_sha: workload.executor_ref } }] });
  if (url.pathname.endsWith("/789/zip")) return new Response(null, { status: 302, headers: { location: "https://archive.example/bytes" } });
  return new Response(null, { status: 503 });
};

export default defineWorkersConfig({ test: {
  name: "native-workflow-workers", include: ["src/native-workflow.workers.test.ts"],
  setupFiles: ["./src/apply-migrations.ts"],
  poolOptions: { workers: {
    main: fileURLToPath(new URL("../../apps/dispatcher/src/testing/native-workflow-entry.ts", import.meta.url)), singleWorker: true,
    miniflare: {
      compatibilityDate: "2026-05-01", compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["RUNS_METADATA"], r2Buckets: ["RUNS_STORAGE"],
      workflows: { NATIVE_WORKFLOW: { name: "native-workflow-test", className: "NativeWorkflow" } },
      outboundService: nativeApi,
      serviceBindings: { NATIVE_FIXTURE_CONTROL: fixtureControl },
      bindings: { TEST_MIGRATIONS: migrations, GITHUB_APP_ID: "42", GITHUB_APP_PRIVATE_KEY: privateKey,
        NATIVE_EXECUTION_POLICY: JSON.stringify({ repo: "owner/context", executor_ref: "3".repeat(40), timeoutSec: 60, pollIntervalSec: 30 }) },
    },
  } },
} });
