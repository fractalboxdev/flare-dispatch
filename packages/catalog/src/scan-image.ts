// The gate image as a scan's preconditions read it (specs/runs/gate.md FD-GATE-105, FD-GATE-109): each scanner's
// version as its binary prints it, and the binaries `/etc/flare-dispatch/scan-tools` lists, one per line. Node process
// code: the runner child builds this Layer inside the image.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { ScanImage, ScannerVersionUnknown } from "./ports.ts";
import { SCAN_TOOLS_FILE } from "./scan-bundle.ts";

/** The argv that prints each scanner's version. */
export const VERSION_ARGV: Readonly<Record<string, readonly string[]>> = {
  gitleaks: ["version"],
  zizmor: ["--version"],
  "osv-scanner": ["--version"],
};

/** The first semver version in a version command's output, with any leading `v` dropped. */
export const versionIn = (output: string): string | undefined =>
  /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output)?.[1];

/** The binaries a scan-tools file lists: one per line, blank lines and `#` comments skipped. */
export const scanToolsIn = (text: string): readonly string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));

const PROBE_TIMEOUT_MS = 30_000;

/**
 * The image this process runs in. A scanner whose binary is absent, exits non-zero or prints no version has no
 * version in the image. An image without the scan-tools file lists no binary, which fails every baseline check.
 */
export const nodeScanImage = (
  opts: { readonly scanToolsFile?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Layer.Layer<ScanImage> =>
  Layer.succeed(ScanImage, {
    scannerVersion: (scanner) =>
      Effect.callback<string, ScannerVersionUnknown>((resume) => {
        const argv = VERSION_ARGV[scanner];
        if (argv === undefined) {
          resume(Effect.fail(new ScannerVersionUnknown({ scanner, detail: "not a scanner" })));
          return;
        }
        execFile(
          scanner,
          [...argv],
          { timeout: PROBE_TIMEOUT_MS, env: opts.env ?? process.env },
          (error, stdout, stderr) => {
            const version = error === null ? versionIn(`${stdout}\n${stderr}`) : undefined;
            resume(
              version === undefined
                ? Effect.fail(
                    new ScannerVersionUnknown({
                      scanner,
                      detail: error === null ? "printed no version" : String(error.message),
                    }),
                  )
                : Effect.succeed(version),
            );
          },
        );
      }),
    scanTools: Effect.promise(() =>
      readFile(opts.scanToolsFile ?? SCAN_TOOLS_FILE, "utf8").then(scanToolsIn, () => []),
    ),
  });
