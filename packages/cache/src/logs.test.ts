import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto.ts";
import {
  logObjectName,
  parseLogObjectName,
  serveLogs,
  stepKey,
  stripAnsi,
  sweepLogs,
  type LogExecution,
  type LogRead,
} from "./logs.ts";
import type { Bucket } from "./manifest.ts";
import { emptyBucket, startMiniflare } from "./support.test-support.ts";

const EXEC = "exec-logs";
let mf: Awaited<ReturnType<typeof startMiniflare>>;
let bucket: Bucket;
beforeAll(async () => {
  mf = await startMiniflare();
  bucket = mf.bucket;
});
afterAll(async () => mf?.mf.dispose());
beforeEach(async () => emptyBucket(bucket));

const NOW = 1_700_000_000_000;
const deps = (execution: LogExecution | null = { terminal: true }) => ({
  bucket,
  execution: async () => execution,
  nonce: () => "n0nce",
});
/** Reads `/v1/executions/<EXEC>/logs[/<file>][?query]` for a caller already identified. */
const logs = (file: string | undefined, query = "", execution?: LogExecution) =>
  serveLogs(
    new Request(`http://x/v1/executions/${EXEC}/logs${file === undefined ? "" : `/${file}`}${query}`),
    { executionId: EXEC, file },
    deps(execution),
  );
const served = (r: LogRead) => {
  expect(r).toMatchObject({ _tag: "Served" });
  return (r as Extract<LogRead, { _tag: "Served" }>).response;
};
const segment = async (journal: string, stream: string, start: number, end: number, epoch = 1) =>
  (await logObjectName({ executionId: EXEC, epoch, journalName: journal, stream, start, end }))!;
const write = async (name: string, lines: string[], meta = { executor_id: "cf-1", executor_kind: "cloudflare" }) =>
  bucket.put(name, `${lines.map((l) => JSON.stringify({ line: l })).join("\n")}\n`, { customMetadata: meta });

describe("logs", () => {
  it("[FD-CACHE-081] a log name derives from the journal name, epoch and offsets, never a process counter", async () => {
    const a = await segment("step:install", "stdout", 0, 100);
    expect(a).toBe(`logs/${EXEC}/1/${(await sha256Hex("step:install")).slice(0, 24)}/stdout-0-100.ndjson`);
    // A replay computes the same name; a reclaimed epoch another one.
    expect(await segment("step:install", "stdout", 0, 100)).toBe(a);
    expect(await segment("step:install", "stdout", 0, 100, 2)).not.toBe(a);
    expect(await stepKey("x")).toHaveLength(24);
  });

  it("[FD-CACHE-082] the reader rejects a name outside the grammar", async () => {
    for (const bad of [
      `logs/${EXEC}/1/${"0".repeat(24)}/stdout-10-5.ndjson`,
      `logs/${EXEC}/0/${"0".repeat(24)}/stdout-0-5.ndjson`,
      `logs/${EXEC}/1/${"0".repeat(23)}/stdout-0-5.ndjson`,
      `logs/${EXEC}/1/${"0".repeat(24)}/stdout-0-5.txt`,
      `logs/${EXEC}/1/${"0".repeat(24)}/../x`,
      `logs/${EXEC}/1/${"0".repeat(24)}/stdout-0-5-7.ndjson`,
    ])
      expect(parseLogObjectName(bad)).toBeUndefined();
    expect(await logs("1/x/stdout.ndjson")).toEqual({ _tag: "NoFile" });
  });

  it("[FD-CACHE-083] serves one file as NDJSON or text, and the aggregate in step order past 1000 objects", async () => {
    const first = await segment("step:a", "stdout", 0, 10);
    await write(first, ["\u001b[32mgreen\u001b[0m"]);
    const file = first.slice(`logs/${EXEC}/`.length);
    const nd = served(await logs(file));
    expect(nd.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await nd.text()).toContain('"line"');
    const text = served(await logs(file, "?format=text"));
    expect(await text.text()).toBe("green");
    for (let i = 1; i <= 1001; i++) await write(await segment("step:b", "stdout", i * 10, i * 10 + 10), [`b${i}`]);
    const all = served(await logs(undefined, "?format=text"));
    const lines = (await all.text()).split("\n");
    expect(lines).toHaveLength(1002);
    expect(lines[0]).toBe("green");
    expect(lines[1]).toBe("b1");
    expect(lines.at(-1)).toBe("b1001");
  }, 120_000);

  it("[FD-CACHE-084] [FD-CACHE-086] the viewer sends a nonce CSP, inserts text only as textContent, strips ANSI and names the producer", async () => {
    const name = await segment("step:a", "stderr", 0, 10);
    await write(name, ["</script><img src=x onerror=alert(1)>", "\u001b[1mbold\u001b[0m"]);
    const r = served(await logs(undefined, "?format=html"));
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-n0nce'");
    const html = await r.text();
    expect(html).not.toContain("</script><img");
    expect(html).not.toContain("\u001b");
    expect(html).toContain("textContent");
    expect(html).not.toContain("innerHTML");
    expect(html).toContain("executor cf-1 (cloudflare)");
    expect(html).toContain("epoch 1");
    expect(stripAnsi("\u001b]8;;http://x\u0007link\u001b]8;;\u0007")).toBe("link");
  });

  it("[FD-CACHE-085] a terminal execution's logs are immutable; a running one's are not cached", async () => {
    const name = await segment("step:a", "stdout", 0, 1);
    await write(name, ["x"]);
    expect(served(await logs(undefined, "", { terminal: true })).headers.get("cache-control")).toContain("immutable");
    expect(served(await logs(undefined, "", { terminal: false })).headers.get("cache-control")).toBe("no-store");
  });

  it("[FD-CACHE-088] a confidential-compute execution's viewer shows a pointer and fetches no log content", async () => {
    const name = await segment("step:a", "stdout", 0, 1);
    await write(name, ["secret"]);
    const r = served(await logs(undefined, "?format=html", { terminal: true, confidential: true, executorId: "dev-1" }));
    const html = await r.text();
    expect(html).toContain('"executorId":"dev-1"');
    expect(html).toContain(`"executionId":"${EXEC}"`);
    expect(html).not.toContain("secret");
  });

  it("[FD-CACHE-089] the log sweep deletes an execution's logs 30 days after it ended", async () => {
    const ended = await segment("step:a", "stdout", 0, 1);
    await write(ended, ["x"]);
    const running = `logs/exec-running/1/${"0".repeat(24)}/stdout-0-1.ndjson`;
    await bucket.put(running, "x");
    const endedAt = async (id: string) => (id === EXEC ? NOW : null);
    expect((await sweepLogs(bucket, endedAt, NOW + 29 * 24 * 3600 * 1000)).deleted).toBe(0);
    expect((await sweepLogs(bucket, endedAt, NOW + 31 * 24 * 3600 * 1000)).deleted).toBe(1);
    expect(await bucket.head(ended)).toBeNull();
    expect(await bucket.head(running)).not.toBeNull();
  });
});
