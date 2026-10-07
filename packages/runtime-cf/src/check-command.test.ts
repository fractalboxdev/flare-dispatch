import { describe, expect, it } from "vitest";
import { makeCheckCommandOwner, commandFingerprint } from "./check-command";

const request = {
  id: "check-fixed",
  container: { id: "explicit-box" },
  fingerprint: await commandFingerprint("exit 7", "/workspace", {}, 60, "explicit-box"),
  startedAt: 1000,
  deadline: 61000,
};
const opts = { handle: request, command: "exit 7", cwd: "/workspace", env: {} };

function fixture() {
  const records = new Map<string, unknown>();
  let reserved = false;
  let launches = 0;
  let now = 1000;
  let present = false;
  let loseResponse = false;
  let exitCode: number | undefined;
  const storage = {
    async load(key: string) {
      return records.get(key);
    },
    async reserve(key: string, value: unknown) {
      if (records.has(key)) return false;
      records.set(key, value);
      reserved = true;
      return true;
    },
    async save(key: string, value: unknown, expected: unknown) {
      if (JSON.stringify(records.get(key)) !== JSON.stringify(expected)) return false;
      records.set(key, value);
      return true;
    },
  };
  const box = {
    async writeFile() {
      return { success: true };
    },
    async startProcess(_command: string, options: { processId?: string; autoCleanup?: boolean }) {
      expect(reserved).toBe(true);
      expect(options.processId).toBe(request.id);
      expect(options.autoCleanup).toBe(false);
      launches++;
      present = true;
      if (loseResponse) throw new Error("lost launch response");
    },
    async getProcess() {
      return present
        ? { status: exitCode === undefined ? "running" : "completed", exitCode }
        : null;
    },
    async exec() {
      return { exitCode: 0, stdout: JSON.stringify({ exitCode, timedOut: false, endedAt: now }) };
    },
  };
  const owner = () => makeCheckCommandOwner(storage, box, () => now);
  return {
    owner,
    records,
    launches: () => launches,
    lose: () => {
      loseResponse = true;
    },
    gone: () => {
      present = false;
    },
    exit: (code: number) => {
      exitCode = code;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("durable check command", () => {
  it("changed environment cannot recover an old command receipt", async () => {
    const f = fixture();
    await f.owner().start(opts);
    await expect(f.owner().start({ ...opts, env: { TOKEN: "changed" } })).rejects.toThrow(
      "identity",
    );
    expect(f.launches()).toBe(1);
    expect(await commandFingerprint("command", "/cwd", { B: "2", A: "1" }, 60, "box")).toBe(
      await commandFingerprint("command", "/cwd", { A: "1", B: "2" }, 60, "box"),
    );
  });
  it("lost launch response and reconstructed owner recover one process", async () => {
    const f = fixture();
    f.lose();
    await expect(f.owner().start(opts)).rejects.toThrow("lost launch response");
    await f.owner().start(opts);
    expect(f.launches()).toBe(1);
    expect(await f.owner().observe(request)).toMatchObject({ state: "running" });
  });
  it("concurrent reservation launches once and a missing uncertain process never relaunches", async () => {
    const f = fixture();
    await Promise.allSettled([f.owner().start(opts), f.owner().start(opts)]);
    expect(f.launches()).toBe(1);
    f.gone();
    await expect(f.owner().start(opts)).rejects.toThrow("uncertain");
    expect(f.launches()).toBe(1);
  });
  it("preserves the original deadline and actual zero/nonzero exit", async () => {
    for (const code of [7, 0]) {
      const f = fixture();
      await f.owner().start(opts);
      f.exit(code);
      expect(await f.owner().observe(request)).toMatchObject({ state: "exited", exitCode: code });
    }
    const f = fixture();
    await f.owner().start(opts);
    f.advance(61501);
    expect(await f.owner().observe(request)).toMatchObject({ state: "timeout" });
    await expect(
      f.owner().start({ ...opts, handle: { ...request, deadline: 999999 } }),
    ).rejects.toThrow("identity");
    expect(f.launches()).toBe(1);
  });
  it("a reconstructed owner replays the original finalized receipt and rejects invented duration", async () => {
    const f = fixture();
    await f.owner().start(opts);
    f.advance(27);
    f.exit(7);
    const result = {
      exitCode: 7,
      durationMs: 27,
      logPath: "logs/check.ndjson",
      stdout: "scrubbed",
      stderr: "",
    };
    await expect(f.owner().finish(request, { ...result, durationMs: 999 })).rejects.toThrow(
      "receipt",
    );
    expect(await f.owner().finish(request, result)).toEqual(result);
    expect(await f.owner().finish(request, { ...result, logPath: "different" })).toEqual(result);
    expect(await f.owner().receipt(request)).toEqual(result);
  });
});
