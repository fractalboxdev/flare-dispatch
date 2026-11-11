// `fd login` against the operating system's real credential store: the macOS keychain through `security`, or the
// Secret Service through `secret-tool`. `cloudflared` is a stand-in on `PATH` that completes the browser flow and
// prints an Access token of the stack's team; every other piece is the `fd-<subcommand>` executables as installed.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATOR } from "../support.ts";
import { startStack, type Stack } from "./stack.ts";

const FD_BIN = join(import.meta.dirname, "../../../../packages/fd/bin");
const SERVICE = "flare-dispatch";

let stack: Stack;
let token: string;
let work: string;

/** The secret the OS credential store holds for `account`, read with the store's own tool. */
const stored = (account: string): string | undefined => {
  const r =
    process.platform === "darwin"
      ? spawnSync("security", ["find-generic-password", "-a", account, "-s", SERVICE, "-w"])
      : spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", account]);
  const out = r.stdout?.toString("utf8").trim() ?? "";
  return r.status === 0 && out !== "" ? out : undefined;
};

const forget = (account: string) =>
  process.platform === "darwin"
    ? spawnSync("security", ["delete-generic-password", "-a", account, "-s", SERVICE])
    : spawnSync("secret-tool", ["clear", "service", SERVICE, "account", account]);

/** Every file under `dir`, recursively. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true })
    .map((f) => join(dir, String(f)))
    .filter((f) => statSync(f).isFile());

interface Ran {
  readonly code: number | null;
  readonly output: string;
}

/** One `fd-<subcommand>` executable, as `fd` runs it from `PATH`. */
const fd = (subcommand: string, args: readonly string[] = []): Promise<Ran> =>
  new Promise((resolve, reject) => {
    const child = spawn(join(FD_BIN, `fd-${subcommand}.mjs`), args, {
      cwd: work,
      env: {
        HOME: process.env["HOME"],
        PATH: `${join(work, "bin")}:${process.env["PATH"] ?? ""}`,
        // The Secret Service's session bus.
        ...Object.fromEntries(
          ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"].flatMap((k) =>
            process.env[k] === undefined ? [] : [[k, process.env[k]]],
          ),
        ),
        XDG_CONFIG_HOME: join(work, "config"),
        FD_URL: stack.url,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });

beforeAll(async () => {
  stack = await startStack();
  token = await stack.team.jwt(OPERATOR);
  work = mkdtempSync(join(tmpdir(), "fd-login-"));
  // The browser flow's stand-in: `access login` succeeds, `access token` prints the team's token.
  const bin = join(work, "bin");
  spawnSync("mkdir", ["-p", bin, join(work, "config")]);
  writeFileSync(
    join(bin, "cloudflared"),
    `#!/bin/sh\nif [ "$2" = "token" ]; then printf '%s\\n' '${token}'; fi\nexit 0\n`,
  );
  chmodSync(join(bin, "cloudflared"), 0o755);
});

afterAll(async () => {
  if (stack !== undefined) forget(stack.url);
  await stack?.close();
});

describe("fd login", () => {
  it("[FD-IFC-067] stores the Access token only in the OS credential store, and never writes or prints it", async () => {
    expect(stored(stack.url)).toBeUndefined();
    const login = await fd("login");
    expect(login).toMatchObject({ code: 0 });
    expect(login.output).not.toContain(token);
    expect(stored(stack.url)).toBe(token);
    // No file `fd` could have written holds the token: its config directory and its working directory.
    const files = filesUnder(work).filter((f) => !f.endsWith("/bin/cloudflared"));
    expect(files.filter((f) => readFileSync(f, "utf8").includes(token))).toEqual([]);
  });

  it("[FD-IFC-067] a later command reads the token from the store, sends it, and prints no credential", async () => {
    expect(stored(stack.url)).toBe(token);
    const before = stack.requests.length;
    const ls = await fd("ls");
    expect(ls).toMatchObject({ code: 0 });
    expect(ls.output).not.toContain(token);
    const sent = stack.requests.slice(before);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((r) => r.headers["cf-access-token"] === token)).toBe(true);

    // With the store emptied, the command has no credential to send: it exits 5 naming `fd login` (FD-IFC-068).
    forget(stack.url);
    const without = await fd("ls");
    expect(without.code).toBe(5);
    expect(without.output).toContain("fd login");
  });
});
