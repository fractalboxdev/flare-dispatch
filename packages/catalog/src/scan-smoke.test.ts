// The gate image's scanner smoke commands (specs/runs/gate.md FD-GATE-114, FD-GATE-115): the repository manifest's
// `sandboxImage` entry lists them, and each one runs `infra/v2/scan-smoke/run.sh` on a fixture. Here every scanner is
// a stub on PATH that exits with a chosen code and records how it was run, so the suites check the exit-code mapping
// and the invocation without the scanner binaries; the image build runs the same commands against the real ones.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxImageEntrySchema } from "./manifest.ts";
import { SCANNERS, type Scanner } from "./scan-bundle.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SMOKE_DIR = join(ROOT, "infra/v2/scan-smoke");
const IMAGE_SMOKE_DIR = "/opt/flare-dispatch/scan-smoke";
const SMOKE_COMMAND = /^\/opt\/flare-dispatch\/scan-smoke\/run\.sh (\S+) (\S+)$/;

/** Each exit code's scan result: the exit-code table of specs/runs/gate.md § Security gate. */
const EXIT_RESULTS: Readonly<Record<Scanner, Readonly<Record<string, readonly number[]>>>> = {
  gitleaks: { clean: [0], finding: [42], "tool-error": [1] },
  zizmor: { clean: [0], finding: [11, 12, 13, 14], "tool-error": [1, 2, 3] },
  "osv-scanner": { clean: [0], finding: [1], "tool-error": [127], "nothing-in-scope": [128] },
};
/** Every mapped code of any scanner, and codes no scanner maps. */
const PROBED_CODES = [0, 1, 2, 3, 10, 11, 12, 13, 14, 15, 42, 127, 128, 255];
const RESULTS = ["finding", "tool-error"] as const;

const gateImage = () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, ".github/flare-dispatch.json"), "utf8")) as {
    readonly runs: readonly { readonly recipe: string; readonly params?: unknown }[];
  };
  const entries = manifest.runs
    .filter((r) => r.recipe === "sandbox-image")
    .map((r) => Schema.decodeUnknownSync(SandboxImageEntrySchema)(r.params));
  const image = entries
    .flatMap((e) => e.images)
    .find((i) => i.dockerfile === "infra/v2/Dockerfile.gate");
  if (image === undefined) throw new Error("no sandboxImage entry builds infra/v2/Dockerfile.gate");
  return image;
};

/** The manifest's smoke command that runs `scanner` on its `result` fixture. */
const smokeOf = (scanner: Scanner, result: string) => {
  const command = gateImage().smoke.find((c) => {
    const m = SMOKE_COMMAND.exec(c);
    return m?.[1] === scanner && m[2] === result;
  });
  if (command === undefined) throw new Error(`no smoke command runs ${scanner} on ${result}`);
  return command;
};

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs one smoke command, from the checkout in place of the image's copy, with `scanner` a stub that exits `code`.
 * The stub records its argv, the checkout root's entries and, for OSV-Scanner, the advisory database it was given.
 */
const runSmoke = async (command: string, scanner: Scanner, code: number) => {
  const dir = mkdtempSync(join(tmpdir(), "fd-scan-smoke-"));
  scratch.push(dir);
  const stub = join(dir, scanner);
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > '${dir}/argv'`,
      `ls -A > '${dir}/checkout'`,
      `if [ -n "\${OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY:-}" ]; then cp "$OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY/osv-scalibr/npm/all.zip" '${dir}/all.zip'; fi`,
      `exit ${code}`,
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  const local = command.replace(IMAGE_SMOKE_DIR, SMOKE_DIR);
  const env = {
    ...process.env,
    PATH: `${dir}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
  const status = await new Promise<number | null>((resolve) =>
    execFile("sh", ["-c", local], { env }, (error) =>
      resolve(error === null ? 0 : typeof error.code === "number" ? error.code : null),
    ),
  );
  const read = (name: string) =>
    existsSync(join(dir, name))
      ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)
      : [];
  return {
    status,
    argv: read("argv"),
    checkout: read("checkout"),
    database: existsSync(join(dir, "all.zip")) ? readFileSync(join(dir, "all.zip")) : undefined,
  };
};

/** The entries of a zip archive whose members are stored uncompressed, by name. */
const storedEntries = (zip: Buffer): Record<string, string> => {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const commentLength = zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    const dataAt = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    entries[name] = zip.toString("utf8", dataAt, dataAt + size);
    at += 46 + nameLength + commentLength;
  }
  return entries;
};

const fixture = (...path: string[]) => readFileSync(join(SMOKE_DIR, "fixtures", ...path), "utf8");

describe("gate image scanner smoke", () => {
  it("[FD-GATE-114] [FD-GATE-115] the image that holds the scanners smokes each one on a finding and a tool-error fixture", () => {
    const pairs = gateImage()
      .smoke.map((c) => SMOKE_COMMAND.exec(c))
      .filter((m) => m !== null)
      .map((m) => `${m[1]} ${m[2]}`);
    expect([...pairs].sort()).toEqual(
      SCANNERS.flatMap((s) => RESULTS.map((r) => `${s} ${r}`)).sort(),
    );
    const dockerfile = readFileSync(join(ROOT, "infra/v2/Dockerfile.gate"), "utf8");
    expect(dockerfile).toContain(`COPY infra/v2/scan-smoke ${IMAGE_SMOKE_DIR}`);
    expect(dockerfile).toContain("COPY infra/v2/scan-tools /etc/flare-dispatch/scan-tools");
    for (const scanner of SCANNERS) {
      expect(dockerfile).toMatch(new RegExp(`install [^\\n]*\\b${scanner}\\b`));
      for (const result of RESULTS)
        expect(existsSync(join(SMOKE_DIR, "fixtures", scanner, result, "head"))).toBe(true);
    }
  });

  /** The probed exit codes on which the smoke command for `result` passes. */
  const passingCodes = async (scanner: Scanner, result: (typeof RESULTS)[number]) => {
    const command = smokeOf(scanner, result);
    const runs = await Promise.all(PROBED_CODES.map((code) => runSmoke(command, scanner, code)));
    return PROBED_CODES.filter((_, i) => runs[i]!.status === 0);
  };

  it.each(SCANNERS)(
    "[FD-GATE-114] the %s finding smoke fails unless the exit code maps to finding",
    async (scanner) => {
      expect(await passingCodes(scanner, "finding")).toEqual(EXIT_RESULTS[scanner]["finding"]);
    },
  );

  it.each(SCANNERS)(
    "[FD-GATE-115] the %s tool-error smoke fails unless the exit code maps to tool-error",
    async (scanner) => {
      expect(await passingCodes(scanner, "tool-error")).toEqual(
        EXIT_RESULTS[scanner]["tool-error"],
      );
    },
  );

  it("[FD-GATE-114] runs gitleaks with the gate's invocation over the fixture range, with the head's .gitleaksignore deleted", async () => {
    const run = await runSmoke(smokeOf("gitleaks", "finding"), "gitleaks", 42);
    expect(run.status).toBe(0);
    const range = run.argv.find((a) => a.startsWith("--log-opts="));
    expect(range).toMatch(/^--log-opts=[0-9a-f]{40}\.\.[0-9a-f]{40}$/);
    expect(run.argv).toEqual([
      "git",
      range,
      "--config",
      join(SMOKE_DIR, "fixtures/gitleaks/finding/config.toml"),
      "--ignore-gitleaks-allow",
      "--redact=100",
      "--exit-code",
      "42",
      "--report-format",
      "json",
    ]);
    // The planted value carries an inline allow marker and a head `.gitleaks.toml`, which the flags override; the
    // base has no `.gitleaksignore`, so the scan deletes the head's.
    expect(fixture("gitleaks/finding/head/app.conf")).toContain("gitleaks:allow");
    expect(fixture("gitleaks/finding/head/.gitleaksignore")).toContain("fd-smoke-planted");
    expect(run.checkout).toContain(".gitleaks.toml");
    expect(run.checkout).toContain("app.conf");
    expect(run.checkout).not.toContain(".gitleaksignore");
  });

  it("[FD-GATE-114] runs zizmor with the gate's invocation on the changed workflow, the bundle config replacing the head's", async () => {
    const run = await runSmoke(smokeOf("zizmor", "finding"), "zizmor", 14);
    expect(run.status).toBe(0);
    expect(run.argv).toEqual([
      "--offline",
      "--no-progress",
      "--format",
      "json",
      "--config",
      join(SMOKE_DIR, "fixtures/zizmor/finding/config.yml"),
      ".github/workflows/smoke.yml",
    ]);
    for (const head of ["zizmor.yml", ".github/zizmor.yml"])
      expect(fixture("zizmor/finding/head", head)).toContain("template-injection");
    expect(run.checkout).toContain("zizmor.yml");
  });

  it("[FD-GATE-114] runs OSV-Scanner offline on the changed lockfile against the planted advisory, with the head's osv-scanner.toml deleted", async () => {
    const run = await runSmoke(smokeOf("osv-scanner", "finding"), "osv-scanner", 1);
    expect(run.status).toBe(0);
    expect(run.argv).toEqual([
      "scan",
      "source",
      "--offline-vulnerabilities",
      "--format",
      "json",
      "-L",
      "package-lock.json",
    ]);
    const advisory = fixture("osv-db/npm/FD-SMOKE-2026-0001.json");
    expect(storedEntries(run.database!)).toEqual({ "FD-SMOKE-2026-0001.json": advisory });
    const planted = (JSON.parse(advisory) as { affected: { package: { name: string } }[] })
      .affected[0]!.package.name;
    expect(fixture("osv-scanner/finding/head/package-lock.json")).toContain(
      `node_modules/${planted}`,
    );
    expect(fixture("osv-scanner/finding/head/osv-scanner.toml")).toContain("FD-SMOKE-2026-0001");
    expect(run.checkout).toContain("package-lock.json");
    expect(run.checkout).not.toContain("osv-scanner.toml");
  });
});
