import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { commandSupervisor, commandSpool } from "./check-command";

describe("native check command supervisor", () => {
  it("a successful parent exit cleans redirected descendants before publishing its receipt", async () => {
    const handle = {
      id: `native-${crypto.randomUUID()}`,
      container: { id: "explicit" },
      fingerprint: "native",
      startedAt: Date.now(),
      deadline: Date.now() + 5000,
    };
    let descendant = 0;
    try {
      const child = spawn(process.execPath, [
        "-e",
        commandSupervisor(handle, "sleep 30 >/dev/null 2>&1 & echo $!; exit 0"),
      ]);
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", () => resolve());
      });
      descendant = Number((await readFile(`${commandSpool(handle)}/stdout`, "utf8")).trim());
      expect(
        JSON.parse(await readFile(`${commandSpool(handle)}/terminal.json`, "utf8")),
      ).toMatchObject({ exitCode: 0, timedOut: false });
      expect(descendant).toBeGreaterThan(0);
      expect(() => process.kill(descendant, 0)).toThrow();
    } finally {
      if (descendant > 0) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {}
      }
      await rm(commandSpool(handle), { recursive: true, force: true });
    }
  });
  it("records actual zero and nonzero exits with separate output spools", async () => {
    for (const code of [0, 7]) {
      const handle = {
        id: `native-${crypto.randomUUID()}`,
        container: { id: "explicit" },
        fingerprint: "native",
        startedAt: Date.now(),
        deadline: Date.now() + 5000,
      };
      try {
        const child = spawn(process.execPath, [
          "-e",
          commandSupervisor(handle, `printf 'real-output'; printf 'real-error' >&2; exit ${code}`),
        ]);
        const actual = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("exit", resolve);
        });
        expect(actual).toBe(code);
        expect(
          JSON.parse(await readFile(`${commandSpool(handle)}/terminal.json`, "utf8")),
        ).toMatchObject({ exitCode: code, timedOut: false });
        expect(await readFile(`${commandSpool(handle)}/stdout`, "utf8")).toBe("real-output");
        expect(await readFile(`${commandSpool(handle)}/stderr`, "utf8")).toBe("real-error");
      } finally {
        await rm(commandSpool(handle), { recursive: true, force: true });
      }
    }
  });
  it("the absolute deadline stops the owned POSIX process group", async () => {
    const handle = {
      id: `native-${crypto.randomUUID()}`,
      container: { id: "explicit" },
      fingerprint: "native",
      startedAt: Date.now(),
      deadline: Date.now() + 500,
    };
    try {
      const child = spawn(process.execPath, [
        "-e",
        commandSupervisor(handle, "sleep 30 & echo $!; wait"),
      ]);
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", () => resolve());
      });
      const terminal = JSON.parse(await readFile(`${commandSpool(handle)}/terminal.json`, "utf8"));
      expect(terminal.timedOut).toBe(true);
      expect(terminal.endedAt - handle.startedAt).toBeLessThan(2500);
      const descendant = Number((await readFile(`${commandSpool(handle)}/stdout`, "utf8")).trim());
      expect(descendant).toBeGreaterThan(0);
      expect(() => process.kill(descendant, 0)).toThrow();
    } finally {
      await rm(commandSpool(handle), { recursive: true, force: true });
    }
  });
  it("an output flood refuses publication and bounds the persistent spool", async () => {
    const handle = {
      id: `native-${crypto.randomUUID()}`,
      container: { id: "explicit" },
      fingerprint: "native",
      startedAt: Date.now(),
      deadline: Date.now() + 5000,
    };
    try {
      const child = spawn(process.execPath, [
        "-e",
        commandSupervisor(handle, "node -e 'process.stdout.write(Buffer.alloc(65*1024*1024,120))'"),
      ]);
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", () => resolve());
      });
      expect((await stat(`${commandSpool(handle)}/stdout`)).size).toBeLessThanOrEqual(
        64 * 1024 * 1024,
      );
      expect(
        JSON.parse(await readFile(`${commandSpool(handle)}/terminal.json`, "utf8")),
      ).toMatchObject({ logExceeded: true });
    } finally {
      await rm(commandSpool(handle), { recursive: true, force: true });
    }
  });
});
