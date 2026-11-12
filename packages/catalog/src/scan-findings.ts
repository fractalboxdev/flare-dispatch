// The security gate's findings (specs/runs/gate.md § Security gate): each scanner's JSON report read into findings that
// carry `scanner`, `ruleId`, `path`, `startLine`, `level` and `fingerprint` (FD-GATE-096). A finding's `fingerprint` is
// the SHA-256 of the canonical JSON of its scanner, `ruleId` and fingerprint locator (FD-GATE-097), the locator the
// scanner table names: `<path>:<start line>` for gitleaks and zizmor, `<lockfile path>:<package>@<version>` for
// OSV-Scanner.
//
// A gitleaks report holds each match under `Secret` and `Match`. The report schemas read neither member, so no finding
// and no fingerprint can hold or derive from a matched value, and a scanner's log reaches the runner with every
// matched value withheld (FD-GATE-098).
import { canonicalJson, sha256Hex } from "@fractalboxdev/flare-dispatch-cache/crypto";
import { Data, Effect, Exit, Match, Schema } from "effect";
import { redactLog, redactValues } from "./egress.ts";
import type { Scanner } from "./scan-bundle.ts";

/** A finding's annotation level, as a check run's annotation takes it. */
export const FindingLevel = Schema.Literals(["notice", "warning", "failure"]);
export type FindingLevel = typeof FindingLevel.Type;

/** One finding a scanner reports (FD-GATE-096). */
export const ScanFinding = Schema.Struct({
  scanner: Schema.Literals(["gitleaks", "zizmor", "osv-scanner"]),
  /** The gitleaks rule id, the zizmor audit id or the OSV advisory id. */
  ruleId: Schema.NonEmptyString,
  /** The path relative to the checkout: the file gitleaks or zizmor names, or OSV-Scanner's lockfile. */
  path: Schema.NonEmptyString,
  /** The 1-based line the finding starts at; 1 for an OSV-Scanner finding, which names no line. */
  startLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  level: FindingLevel,
  /** The lowercase hex SHA-256 of the canonical JSON of `scanner`, `ruleId` and the fingerprint locator. */
  fingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type ScanFinding = typeof ScanFinding.Type;

/** A scanner's report could not be found in its output, or does not have the shape of that scanner's report. */
export class ScanReportUnreadable extends Schema.TaggedError<ScanReportUnreadable>()(
  "ScanReportUnreadable",
  { scanner: Schema.String, detail: Schema.String },
) {}

/** The findings a scanner step reports: its report's findings, or why the report could not be read. */
export type StepFindings = Data.TaggedEnum<{
  Read: { readonly findings: readonly ScanFinding[] };
  Unreadable: { readonly detail: string };
}>;
export const StepFindings = Data.taggedEnum<StepFindings>();

/** The fingerprint locator of a finding (specs/runs/gate.md § Security gate, scanner table). */
export type FingerprintLocator =
  | { readonly scanner: "gitleaks" | "zizmor"; readonly path: string; readonly startLine: number }
  | {
      readonly scanner: "osv-scanner";
      readonly lockfile: string;
      readonly package: string;
      readonly version: string;
    };

/** `<path>:<start line>` for gitleaks and zizmor, `<lockfile path>:<package>@<version>` for OSV-Scanner. */
export const fingerprintLocator = (locator: FingerprintLocator): string =>
  locator.scanner === "osv-scanner"
    ? `${locator.lockfile}:${locator.package}@${locator.version}`
    : `${locator.path}:${locator.startLine}`;

/** The SHA-256 of the canonical JSON of a finding's scanner, `ruleId` and fingerprint locator (FD-GATE-097). */
export const scanFingerprint = (finding: {
  readonly scanner: Scanner;
  readonly ruleId: string;
  readonly locator: string;
}): Effect.Effect<string> =>
  Effect.promise(() =>
    sha256Hex(
      canonicalJson({ scanner: finding.scanner, ruleId: finding.ruleId, locator: finding.locator }),
    ),
  );

// Each report schema reads only the members a finding takes; an unknown member, `Secret` and `Match` among them, is
// stripped on decode.

const Line = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Row = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A gitleaks JSON report: one entry per match. */
const GitleaksReport = Schema.Array(
  Schema.Struct({ RuleID: Schema.NonEmptyString, File: Schema.NonEmptyString, StartLine: Line }),
);

/** A zizmor JSON report: one entry per finding, located by its primary location's 0-based start row. */
const ZizmorReport = Schema.Array(
  Schema.Struct({
    ident: Schema.NonEmptyString,
    determinations: Schema.Struct({ severity: Schema.String }),
    ignored: Schema.optional(Schema.Boolean),
    locations: Schema.Array(
      Schema.Struct({
        symbolic: Schema.Struct({
          key: Schema.Struct({ Local: Schema.Struct({ given_path: Schema.NonEmptyString }) }),
          kind: Schema.optional(Schema.String),
        }),
        concrete: Schema.Struct({
          location: Schema.Struct({ start_point: Schema.Struct({ row: Row }) }),
        }),
      }),
    ).check(Schema.isMinLength(1)),
  }),
);

/** An OSV-Scanner JSON report: each lockfile's packages, each with the advisories that affect it. */
const OsvReport = Schema.Struct({
  results: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          source: Schema.Struct({ path: Schema.NonEmptyString }),
          packages: Schema.optional(
            Schema.NullOr(
              Schema.Array(
                Schema.Struct({
                  package: Schema.Struct({ name: Schema.NonEmptyString, version: Schema.String }),
                  vulnerabilities: Schema.optional(
                    Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.NonEmptyString }))),
                  ),
                }),
              ),
            ),
          ),
        }),
      ),
    ),
  ),
});

/** A finding's annotation level from zizmor's severity: `High` is `failure`, `Medium` `warning`, any other `notice`. */
export const zizmorLevel = (severity: string): FindingLevel =>
  Match.value(severity).pipe(
    Match.when("High", (): FindingLevel => "failure"),
    Match.when("Medium", (): FindingLevel => "warning"),
    Match.orElse((): FindingLevel => "notice"),
  );

/** `path` relative to the checkout `dir`, with any leading `./` the invocation added removed. */
export const checkoutPath = (path: string, dir: string): string => {
  const root = dir.endsWith("/") ? dir : `${dir}/`;
  let out = path.startsWith(root) ? path.slice(root.length) : path;
  while (out.startsWith("./")) out = out.slice(2);
  return out;
};

const CLOSER: Readonly<Record<string, string>> = { "[": "]", "{": "}" };

/** How many closing lines, from the last, a candidate report start tries before the next start. */
const ENDS_PER_START = 4;

/**
 * The JSON report in a scanner's combined output. The output interleaves the report on stdout with log lines on
 * stderr, so the report is the first span of whole lines that opens with `[` or `{` at the start of a line, closes
 * with the matching bracket at the end of a line, and parses as JSON.
 */
export const reportJson = (output: string): unknown => {
  try {
    return JSON.parse(output);
  } catch {
    // The output holds log lines as well as the report.
  }
  const lines = output.split("\n");
  for (let start = 0; start < lines.length; start++) {
    const closer = CLOSER[lines[start]!.charAt(0)];
    if (closer === undefined) continue;
    let tried = 0;
    for (let end = lines.length - 1; end >= start && tried < ENDS_PER_START; end--) {
      if (!lines[end]!.trimEnd().endsWith(closer)) continue;
      tried++;
      try {
        return JSON.parse(lines.slice(start, end + 1).join("\n"));
      } catch {
        // Not this span.
      }
    }
  }
  return undefined;
};

const decode = <A>(
  scanner: Scanner,
  schema: Schema.Codec<A, unknown>,
  json: unknown,
): Effect.Effect<A, ScanReportUnreadable> => {
  const exit = Schema.decodeUnknownExit(schema)(json);
  return Exit.isSuccess(exit)
    ? Effect.succeed(exit.value)
    : Effect.fail(
        new ScanReportUnreadable({ scanner, detail: `report does not match the ${scanner} schema` }),
      );
};

type Unfingerprinted = Omit<ScanFinding, "fingerprint"> & { readonly locator: string };

const gitleaksFindings = (json: unknown, dir: string) =>
  decode("gitleaks", GitleaksReport, json).pipe(
    Effect.map((report) =>
      report.map((m): Unfingerprinted => {
        const path = checkoutPath(m.File, dir);
        return {
          scanner: "gitleaks",
          ruleId: m.RuleID,
          path,
          startLine: m.StartLine,
          level: "failure",
          locator: fingerprintLocator({ scanner: "gitleaks", path, startLine: m.StartLine }),
        };
      }),
    ),
  );

const zizmorFindings = (json: unknown, dir: string) =>
  decode("zizmor", ZizmorReport, json).pipe(
    Effect.map((report) =>
      report
        .filter((f) => f.ignored !== true)
        .map((f): Unfingerprinted => {
          const primary = f.locations.find((l) => l.symbolic.kind === "Primary") ?? f.locations[0]!;
          const path = checkoutPath(primary.symbolic.key.Local.given_path, dir);
          const startLine = primary.concrete.location.start_point.row + 1;
          return {
            scanner: "zizmor",
            ruleId: f.ident,
            path,
            startLine,
            level: zizmorLevel(f.determinations.severity),
            locator: fingerprintLocator({ scanner: "zizmor", path, startLine }),
          };
        }),
    ),
  );

const osvFindings = (json: unknown, dir: string) =>
  decode("osv-scanner", OsvReport, json).pipe(
    Effect.map((report) =>
      (report.results ?? []).flatMap((result) => {
        const lockfile = checkoutPath(result.source.path, dir);
        return (result.packages ?? []).flatMap((p) =>
          (p.vulnerabilities ?? []).map(
            (v): Unfingerprinted => ({
              scanner: "osv-scanner",
              ruleId: v.id,
              path: lockfile,
              startLine: 1,
              level: "failure",
              locator: fingerprintLocator({
                scanner: "osv-scanner",
                lockfile,
                package: p.package.name,
                version: p.package.version,
              }),
            }),
          ),
        );
      }),
    ),
  );

/**
 * The findings of a scanner's report, read from its combined output, with each finding's fingerprint (FD-GATE-096,
 * FD-GATE-097). `dir` is the checkout the scanner ran in; every path is relative to it. Findings with the same
 * fingerprint are one finding, reported once in report order.
 */
export const scanFindings = (
  scanner: Scanner,
  output: string,
  dir: string,
): Effect.Effect<readonly ScanFinding[], ScanReportUnreadable> =>
  Effect.gen(function* () {
    const json = reportJson(output);
    if (json === undefined)
      return yield* new ScanReportUnreadable({ scanner, detail: "no JSON report in the output" });
    const read = yield* Match.value(scanner).pipe(
      Match.when("gitleaks", () => gitleaksFindings(json, dir)),
      Match.when("zizmor", () => zizmorFindings(json, dir)),
      Match.when("osv-scanner", () => osvFindings(json, dir)),
      Match.exhaustive,
    );
    const findings = new Map<string, ScanFinding>();
    for (const { locator, ...finding } of read) {
      const fingerprint = yield* scanFingerprint({ scanner, ruleId: finding.ruleId, locator });
      if (!findings.has(fingerprint)) findings.set(fingerprint, { ...finding, fingerprint });
    }
    return [...findings.values()];
  });

/** The members of a gitleaks report that hold a matched value. */
const MATCHED_MEMBERS = ["Secret", "Match"] as const;

/**
 * A `Secret` or `Match` member and its string value. A value the output limit cut off ends at the end of the output,
 * after at most a lone escaping backslash, and is matched up to there.
 */
const MATCHED_MEMBER = new RegExp(
  `"(${MATCHED_MEMBERS.join("|")})"(\\s*):(\\s*)"(?:[^"\\\\]|\\\\.)*(?:"|\\\\?$)`,
  "g",
);

/**
 * Every matched value a gitleaks report in `output` holds, as gitleaks wrote it and as JSON escapes it, other than the
 * `REDACTED` that `--redact=100` writes in its place.
 */
export const matchedValues = (output: string): readonly string[] => {
  const json = reportJson(output);
  if (!Array.isArray(json)) return [];
  const values: string[] = [];
  for (const entry of json as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    for (const member of MATCHED_MEMBERS) {
      const value: unknown = (entry as Record<string, unknown>)[member];
      if (typeof value !== "string" || value === "" || value === "REDACTED") continue;
      values.push(value, JSON.stringify(value).slice(1, -1));
    }
  }
  return values;
};

/**
 * A scanner's output as its log holds it (FD-GATE-098): every `Secret` and `Match` member's value replaced by
 * `REDACTED`, every matched value the report holds withheld wherever else the output repeats it, and every token
 * shape redacted.
 */
export const scanLog = (output: string): string =>
  redactLog(
    redactValues(output, matchedValues(output)).replace(
      MATCHED_MEMBER,
      (_match, member: string, before: string, after: string) => `"${member}"${before}:${after}"REDACTED"`,
    ),
  );

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** `scanLog` over a subprocess's output bytes, the form `CommandOptions.logAs` takes. */
export const scanLogBytes = (output: Uint8Array): Uint8Array =>
  encoder.encode(scanLog(decoder.decode(output)));
