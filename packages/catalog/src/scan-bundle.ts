// The security gate's scan bundle (specs/runs/gate.md § Security gate): a DSSE envelope with payload type
// `application/vnd.flare-dispatch.scan-bundle.v1+json` whose payload pins the scanners' configurations, accepted
// version ranges and exit maps, the suppression files and markers, and the baseline checks. One model serves both
// sides: `fd deploy`'s drift check verifies the envelope's SHA-256, its signature under a key whose window holds the
// verification time, and its payload (specs/operability.md FD-OPS-094 to FD-OPS-097); a scan reads the pinned envelope
// from `cas/<digest>`, checks its SHA-256, the image's scanner versions and tools and the advisory snapshot of each
// ecosystem whose lockfile the range changes, and runs no scanner where any of them fails (FD-GATE-100 to
// FD-GATE-107, FD-GATE-109). The module is Worker-safe: the deploy side runs in Node and the control plane imports
// the schema.
import { sha256Hex } from "@fractalboxdev/flare-dispatch-cache/crypto";
import {
  AnyDsseEnvelope,
  fromBase64,
  ProvenancePublicJwk,
  verifyDsseSignature,
  type DsseSignature,
} from "@fractalboxdev/flare-dispatch-cache/dsse";
import { contentObjectKey } from "@fractalboxdev/flare-dispatch-cache/namespaces";
import { Cause, Effect, Exit, Layer, Option, Schema, SchemaIssue } from "effect";
import {
  AdvisorySnapshots,
  ScanBundleStore,
  ScanBundleUnreadable,
  ScanImage,
  type AdvisorySnapshot,
} from "./ports.ts";
import { Outcome, ScanConfigReason, type Reason } from "./reasons.ts";

export const SCAN_BUNDLE_PAYLOAD_TYPE = "application/vnd.flare-dispatch.scan-bundle.v1+json";

/** The scanners whose version ranges and exit maps a scan bundle pins. */
export const SCANNERS = ["gitleaks", "zizmor", "osv-scanner"] as const;
export type Scanner = (typeof SCANNERS)[number];

/** The image file that lists the binaries a baseline check may run (FD-GATE-109). */
export const SCAN_TOOLS_FILE = "/etc/flare-dispatch/scan-tools";

/** The suppression files every bundle restores from the base commit. */
export const REQUIRED_SUPPRESSION_FILES = [".gitleaksignore", "osv-scanner.toml"] as const;
/** A line the zizmor suppression marker must match, so the recipe strips it from added lines. */
const ZIZMOR_MARKER_SAMPLE = "uses: actions/checkout@v4 # zizmor: ignore[unpinned-uses]";

/** A bundle's SHA-256: 64 lowercase hex digits. */
export const BundleDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

// ---- Semver ranges -------------------------------------------------------------------

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A semver 2.0.0 version, with an optional leading `v`, or `undefined`. */
export const parseVersion = (text: string): Version | undefined => {
  const m = VERSION.exec(text.trim());
  if (m === null) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split("."),
  };
};

const compareIdentifier = (a: string, b: string): number => {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na) return -1;
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/** Semver precedence (semver 2.0.0 § 11). */
const compare = (a: Version, b: Version): number => {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return b.prerelease.length - a.prerelease.length;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const c = compareIdentifier(x, y);
    if (c !== 0) return c;
  }
  return 0;
};

type Op = ">=" | ">" | "<=" | "<" | "=";
interface Comparator {
  readonly op: Op;
  readonly version: Version;
  /** The upper bound a caret, tilde, x-range or partial hyphen end implies, below every prerelease of it. */
  readonly implied?: true;
}

const PARTIAL =
  /^v?(\*|x|X|0|[1-9]\d*)(?:\.(\*|x|X|0|[1-9]\d*)(?:\.(\*|x|X|0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)?)?$/;

/** A partial version's parts: each number, or `undefined` from its first wildcard or missing part on. */
const parsePartial = (text: string) => {
  if (text === "" || text === "*" || text === "x" || text === "X") return { parts: [] as number[], pre: [] };
  const m = PARTIAL.exec(text);
  if (m === null) return undefined;
  const parts: number[] = [];
  for (const p of [m[1], m[2], m[3]]) {
    if (p === undefined || p === "*" || p === "x" || p === "X") break;
    parts.push(Number(p));
  }
  if (m[4] !== undefined && parts.length < 3) return undefined;
  return { parts, pre: m[4] === undefined ? [] : m[4].split(".") };
};

const v = (major: number, minor = 0, patch = 0, prerelease: readonly string[] = []): Version => ({
  major,
  minor,
  patch,
  prerelease,
});

/** The comparators one range term (`^1.2.3`, `~1.2`, `>=1.0.0`, `1.x`, `1.2.3`) means, or `undefined`. */
const termComparators = (term: string): readonly Comparator[] | undefined => {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.*)$/.exec(term)!;
  const op = m[1];
  const partial = parsePartial(m[2]!);
  if (partial === undefined) return undefined;
  const [major, minor, patch] = partial.parts;
  const low = v(major ?? 0, minor ?? 0, patch ?? 0, partial.pre);
  const n = partial.parts.length;
  if (op === "^") {
    if (n === 0) return [];
    const high =
      major! > 0 || n === 1
        ? v(major! + 1)
        : minor! > 0 || n === 2
          ? v(0, minor! + 1)
          : v(0, 0, patch! + 1);
    return [
      { op: ">=", version: low },
      { op: "<", version: { ...high, prerelease: ["0"] }, implied: true },
    ];
  }
  if (op === "~") {
    if (n === 0) return [];
    const high = n === 1 ? v(major! + 1) : v(major!, minor! + 1);
    return [
      { op: ">=", version: low },
      { op: "<", version: { ...high, prerelease: ["0"] }, implied: true },
    ];
  }
  if (op === undefined || op === "=") {
    if (n === 3) return [{ op: "=", version: low }];
    if (n === 0) return [];
    const high = n === 1 ? v(major! + 1) : v(major!, minor! + 1);
    return [
      { op: ">=", version: low },
      { op: "<", version: { ...high, prerelease: ["0"] }, implied: true },
    ];
  }
  if ((op === ">" || op === "<=") && (n === 1 || n === 2)) {
    // A partial bound covers its whole unnamed tail: `>1.2` excludes every 1.2.x, `<=1.2` includes it.
    const next = n === 1 ? v(major! + 1) : v(major!, minor! + 1);
    return op === ">"
      ? [{ op: ">=", version: next }]
      : [{ op: "<", version: { ...next, prerelease: ["0"] }, implied: true }];
  }
  return n === 0 ? (op === "<" || op === ">" ? undefined : []) : [{ op: op as Op, version: low }];
};

/** A semver range as comparator sets joined by `||`, or `undefined` where any term does not parse. */
export const parseRange = (range: string): readonly (readonly Comparator[])[] | undefined => {
  const sets: Comparator[][] = [];
  for (const raw of range.split("||")) {
    const set: Comparator[] = [];
    const text = raw.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1");
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    if (hyphen !== null) {
      const from = termComparators(`>=${hyphen[1]}`);
      const to = parsePartial(hyphen[2]!);
      if (from === undefined || to === undefined) return undefined;
      set.push(...from);
      const [major, minor, patch] = to.parts;
      if (to.parts.length === 3) set.push({ op: "<=", version: v(major!, minor!, patch!, to.pre) });
      else if (to.parts.length > 0)
        set.push({
          op: "<",
          version: to.parts.length === 1 ? v(major! + 1, 0, 0, ["0"]) : v(major!, minor! + 1, 0, ["0"]),
          implied: true,
        });
    } else
      for (const term of text === "" ? [""] : text.split(/\s+/)) {
        const cs = termComparators(term);
        if (cs === undefined) return undefined;
        set.push(...cs);
      }
    sets.push(set);
  }
  return sets;
};

const holds = (c: Comparator, version: Version): boolean => {
  const d = compare(version, c.version);
  switch (c.op) {
    case ">=":
      return d >= 0;
    case ">":
      return d > 0;
    case "<=":
      return d <= 0;
    case "<":
      return d < 0;
    case "=":
      return d === 0;
  }
};

const sameTuple = (a: Version, b: Version) =>
  a.major === b.major && a.minor === b.minor && a.patch === b.patch;

/**
 * Whether `version` lies inside `range`. A prerelease version satisfies only a comparator set that names a prerelease
 * of the same `major.minor.patch`, as npm's semver reads ranges. An unparseable version or range satisfies nothing.
 */
export const satisfies = (version: string, range: string): boolean => {
  const parsed = parseVersion(version);
  const sets = parseRange(range);
  if (parsed === undefined || sets === undefined) return false;
  return sets.some(
    (set) =>
      set.every((c) => holds(c, parsed)) &&
      (parsed.prerelease.length === 0 ||
        set.some(
          (c) => c.implied !== true && c.version.prerelease.length > 0 && sameTuple(c.version, parsed),
        )),
  );
};

// ---- Payload schema ------------------------------------------------------------------

const NonEmpty = Schema.String.check(Schema.isMinLength(1));

/** A scan result one exit code maps to. */
export const ScanResult = Schema.Literals(["clean", "finding", "tool-error", "nothing-in-scope"]);
export type ScanResult = typeof ScanResult.Type;

/** Each exit code, as a decimal string from 0 to 255, to its scan result. */
export const ExitMap = Schema.Record(
  Schema.String.check(Schema.isPattern(/^(0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])$/)),
  ScanResult,
);

/** A semver range a scanner's version must lie inside. */
export const SemverRange = NonEmpty.check(
  Schema.makeFilter((s: string) => (parseRange(s) === undefined ? "a semver range" : undefined)),
);

export const ScannerPin = Schema.Struct({ versions: SemverRange, exitMap: ExitMap });

const isRegExp = (s: string): boolean => {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
};

/** One baseline check: it decides `controlId` by running `argv`, whose first element is the binary `tool`. */
export const BaselineCheck = Schema.Struct({
  controlId: NonEmpty,
  rule: NonEmpty,
  tool: NonEmpty,
  argv: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  exitMap: ExitMap,
}).check(
  Schema.makeFilter((c: { readonly tool: string; readonly argv: readonly string[] }) =>
    c.argv[0] === c.tool
      ? undefined
      : { path: ["argv"], issue: `argv[0] is not the check's tool ${c.tool}` },
  ),
);
export type BaselineCheck = typeof BaselineCheck.Type;

/** The scan bundle v1 payload (specs/runs/gate.md § Security gate, Scan bundle field table). */
export const ScanBundlePayload = Schema.Struct({
  version: NonEmpty,
  gitleaks: Schema.Struct({ config: NonEmpty }),
  zizmor: Schema.Struct({ config: NonEmpty }),
  scanners: Schema.Struct({
    gitleaks: ScannerPin,
    zizmor: ScannerPin,
    "osv-scanner": ScannerPin,
  }),
  suppression: Schema.Struct({
    files: Schema.Array(NonEmpty).check(
      Schema.makeFilter((files: readonly string[]) => {
        const absent = REQUIRED_SUPPRESSION_FILES.filter((f) => !files.includes(f));
        return absent.length === 0 ? undefined : `lacks ${absent.join(", ")}`;
      }),
    ),
    markers: Schema.Array(
      NonEmpty.check(
        Schema.makeFilter((s: string) => (isRegExp(s) ? undefined : "a regular expression")),
      ),
    ).check(
      Schema.makeFilter((markers: readonly string[]) =>
        markers.some((m) => isRegExp(m) && new RegExp(m).test(ZIZMOR_MARKER_SAMPLE))
          ? undefined
          : "no marker matches # zizmor: ignore[...]",
      ),
    ),
  }),
  baselineChecks: Schema.Array(BaselineCheck),
});
export type ScanBundlePayload = typeof ScanBundlePayload.Type;

/** One public signing key with its deploy-verification window: `notBefore` inclusive, `notAfter` exclusive. */
export const ScanBundleKey = Schema.Struct({
  publicKey: ProvenancePublicJwk,
  notBefore: Schema.optional(Schema.String),
  notAfter: Schema.optional(Schema.String),
});
export type ScanBundleKey = typeof ScanBundleKey.Type;

// ---- Decode and verify ---------------------------------------------------------------

export class ScanBundleDigestMismatch extends Schema.TaggedError<ScanBundleDigestMismatch>()(
  "ScanBundleDigestMismatch",
  { expected: Schema.String, actual: Schema.String },
) {}

/** The bytes are not a DSSE envelope of the scan bundle's payload type with a base64 JSON payload. */
export class ScanBundleMalformed extends Schema.TaggedError<ScanBundleMalformed>()(
  "ScanBundleMalformed",
  { detail: Schema.String },
) {}

/** No signature verifies under a key whose window holds the verification time. */
export class ScanBundleUnsigned extends Schema.TaggedError<ScanBundleUnsigned>()(
  "ScanBundleUnsigned",
  { detail: Schema.String },
) {}

/** The payload fails the scan bundle schema at `path`, the first failing one. */
export class ScanBundleSchemaInvalid extends Schema.TaggedError<ScanBundleSchemaInvalid>()(
  "ScanBundleSchemaInvalid",
  { path: Schema.String, message: Schema.String },
) {}

export type ScanBundleRejection =
  | ScanBundleDigestMismatch
  | ScanBundleMalformed
  | ScanBundleUnsigned
  | ScanBundleSchemaInvalid;

/** A decoded envelope: the envelope as signed and its payload as the schema reads it. */
export interface ScanBundle {
  readonly digest: string;
  readonly envelope: AnyDsseEnvelope;
  readonly payload: ScanBundlePayload;
}

/** The lowercase hex SHA-256 of the envelope's bytes. */
export const scanBundleDigest = (bytes: Uint8Array) => Effect.promise(() => sha256Hex(bytes));

/** Fails where the bytes' SHA-256 is not `pin` (FD-OPS-096, FD-GATE-100, FD-GATE-103). */
export const checkDigest = (bytes: Uint8Array, pin: string) =>
  Effect.gen(function* () {
    const actual = yield* scanBundleDigest(bytes);
    if (actual !== pin) return yield* new ScanBundleDigestMismatch({ expected: pin, actual });
    return actual;
  });

const decodeEnvelopeJson = Schema.decodeUnknownOption(Schema.fromJsonString(AnyDsseEnvelope));

/** The envelope the bytes hold and its payload's JSON value. */
export const decodeEnvelope = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const envelope = Option.getOrUndefined(decodeEnvelopeJson(new TextDecoder().decode(bytes)));
    if (envelope === undefined)
      return yield* new ScanBundleMalformed({ detail: "not a DSSE envelope" });
    if (envelope.payloadType !== SCAN_BUNDLE_PAYLOAD_TYPE)
      return yield* new ScanBundleMalformed({
        detail: `payload type ${envelope.payloadType} is not ${SCAN_BUNDLE_PAYLOAD_TYPE}`,
      });
    const payload = fromBase64(envelope.payload);
    if (payload === undefined)
      return yield* new ScanBundleMalformed({ detail: "payload is not standard base64" });
    const json = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(payload)) as unknown,
      catch: () => new ScanBundleMalformed({ detail: "payload is not JSON" }),
    });
    return { envelope, json };
  });

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

const pathOf = (path: ReadonlyArray<unknown> | undefined): string =>
  (path ?? [])
    .map((p) =>
      String(typeof p === "object" && p !== null && "key" in p ? (p as { key: unknown }).key : p),
    )
    .join(".");

/** The payload as the v1 schema reads it, or the first path it fails at (FD-OPS-097). */
export const decodePayload = (json: unknown): Effect.Effect<ScanBundlePayload, ScanBundleSchemaInvalid> => {
  const exit = Schema.decodeUnknownExit(ScanBundlePayload, {
    onExcessProperty: "error",
    errors: "first",
  })(json);
  if (Exit.isSuccess(exit)) return Effect.succeed(exit.value);
  const first = Option.match(Cause.findErrorOption(exit.cause), {
    onNone: () => ({ path: "", message: Cause.pretty(exit.cause) }),
    onSome: (error) => {
      const issue = formatter(error.issue).issues[0];
      return { path: pathOf(issue?.path), message: issue?.message ?? "invalid" };
    },
  });
  return Effect.fail(new ScanBundleSchemaInvalid(first));
};

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const instant = (text: string | undefined): number | undefined =>
  text === undefined || !RFC3339.test(text) ? undefined : Date.parse(text);

/**
 * Whether a key's window holds `at`: `notBefore <= at < notAfter`. A missing, malformed or reversed window holds no
 * time, so it authorizes nothing (specs/operability.md § Scan bundle and advisory snapshot).
 */
export const windowHolds = (key: ScanBundleKey, at: number): boolean => {
  const from = instant(key.notBefore);
  const to = instant(key.notAfter);
  if (from === undefined || to === undefined || Number.isNaN(from) || Number.isNaN(to)) return false;
  return from < to && from <= at && at < to;
};

/**
 * Fails unless some signature of the envelope verifies under a key whose window holds `at`, the one verification time
 * the caller sampled (FD-OPS-095). The envelope's own content names no time the check reads.
 */
export const verifySignature = (envelope: AnyDsseEnvelope, keys: readonly ScanBundleKey[], at: number) =>
  Effect.gen(function* () {
    const open = keys.filter((k) => windowHolds(k, at));
    if (open.length === 0)
      return yield* new ScanBundleUnsigned({
        detail: `no key in scan.bundleKeys has a window holding ${new Date(at).toISOString()}`,
      });
    const verifies = (s: DsseSignature) =>
      Effect.promise(async () => {
        for (const k of open) if (await verifyDsseSignature(k.publicKey, envelope, s)) return true;
        return false;
      });
    for (const s of envelope.signatures) if (yield* verifies(s)) return;
    return yield* new ScanBundleUnsigned({
      detail: `no signature verifies under a key whose window holds ${new Date(at).toISOString()}`,
    });
  });

/**
 * The deploy side's verification of one envelope (FD-OPS-094 to FD-OPS-097): its SHA-256 is `digest`, a signature
 * verifies under a key of `keys` whose window holds `at`, and its payload passes the v1 schema. It stops at the first
 * check that fails.
 */
export const verifyScanBundle = (input: {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly keys: readonly ScanBundleKey[];
  readonly at: number;
}): Effect.Effect<ScanBundle, ScanBundleRejection> =>
  Effect.gen(function* () {
    const digest = yield* checkDigest(input.bytes, input.digest);
    const { envelope, json } = yield* decodeEnvelope(input.bytes);
    yield* verifySignature(envelope, input.keys, input.at);
    const payload = yield* decodePayload(json);
    return { digest, envelope, payload };
  });

// ---- Run side ------------------------------------------------------------------------

/**
 * The OSV ecosystem of each lockfile base name OSV-Scanner reads, under the name its archive has at
 * `https://osv-vulnerabilities.storage.googleapis.com/<ecosystem>/all.zip` and in `scan.advisoryEcosystems`.
 */
export const LOCKFILE_ECOSYSTEMS: Readonly<Record<string, string>> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "yarn.lock": "npm",
  "pnpm-lock.yaml": "npm",
  "bun.lock": "npm",
  "requirements.txt": "PyPI",
  "Pipfile.lock": "PyPI",
  "poetry.lock": "PyPI",
  "pdm.lock": "PyPI",
  "uv.lock": "PyPI",
  "Cargo.lock": "crates.io",
  "go.mod": "Go",
  "Gemfile.lock": "RubyGems",
  "gems.locked": "RubyGems",
  "composer.lock": "Packagist",
  "pom.xml": "Maven",
  "gradle.lockfile": "Maven",
  "buildscript-gradle.lockfile": "Maven",
  "packages.lock.json": "NuGet",
  "pubspec.lock": "Pub",
  "mix.lock": "Hex",
  "renv.lock": "CRAN",
  "conan.lock": "ConanCenter",
};

/** The ecosystem of a lockfile at `path`, or `undefined` for a path that is no lockfile OSV-Scanner reads. */
export const lockfileEcosystem = (path: string): string | undefined => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return Object.hasOwn(LOCKFILE_ECOSYSTEMS, base) ? LOCKFILE_ECOSYSTEMS[base] : undefined;
};

/** The ecosystems whose lockfiles `paths` change, each once, in sorted order. */
export const lockfileEcosystems = (paths: readonly string[]): readonly string[] =>
  [...new Set(paths.flatMap((p) => lockfileEcosystem(p) ?? []))].sort();

/**
 * `scan.advisoryMaxAgeHours` where the overlay sets none. Age counts from the archive's `Last-Modified` time, which
 * precedes the once-per-UTC-day refresh that records it by OSV's publish lag, so a snapshot reaches 24 h plus that lag
 * before the next refresh replaces it; 48 h holds every snapshot of an unbroken daily schedule within the setting.
 */
export const ADVISORY_MAX_AGE_DEFAULT_HOURS = 48;

/** Whether a snapshot's `Last-Modified` time is older than `maxAgeHours` at `now` (FD-GATE-107). */
export const snapshotStale = (
  snapshot: Pick<AdvisorySnapshot, "lastModified">,
  now: number,
  maxAgeHours: number,
): boolean => now - snapshot.lastModified > maxAgeHours * 3_600_000;

/**
 * What a scan's preconditions read beside the pin: the paths the scan range changes, the time the scan samples once,
 * and `scan.advisoryMaxAgeHours`.
 */
export interface ScanScope {
  readonly pin: string | undefined;
  readonly changedPaths: readonly string[];
  readonly now: number;
  readonly advisoryMaxAgeHours: number;
}

/**
 * A scan whose preconditions held: the pinned bundle, each scanner's version in the image, and the advisory snapshot
 * of each ecosystem whose lockfile the range changes, which OSV-Scanner reads offline.
 */
export interface PreparedScan {
  readonly bundle: ScanBundle;
  readonly versions: Readonly<Record<Scanner, string>>;
  readonly snapshots: Readonly<Record<string, AdvisorySnapshot>>;
}

/** A precondition failed: the scan records `failure` with `reason` and runs no scanner. */
export class ScanRefused extends Schema.TaggedError<ScanRefused>()("ScanRefused", {
  reason: Schema.String,
}) {}

const refuse = (reason: Reason) => Effect.fail(new ScanRefused({ reason }));

/**
 * The advisory snapshot of each ecosystem whose lockfile the range changes: an ecosystem with no recorded snapshot,
 * or whose record the store cannot read, refuses the scan as missing (FD-GATE-106); one whose `Last-Modified` time is
 * older than `scan.advisoryMaxAgeHours` refuses it as stale (FD-GATE-107). Ecosystems are checked in sorted order, so
 * the reason names the first that fails.
 */
export const advisoryPreconditions = (
  scope: Omit<ScanScope, "pin">,
): Effect.Effect<Readonly<Record<string, AdvisorySnapshot>>, ScanRefused, AdvisorySnapshots> =>
  Effect.gen(function* () {
    const ecosystems = lockfileEcosystems(scope.changedPaths);
    if (ecosystems.length === 0) return {};
    const store = yield* AdvisorySnapshots;
    const snapshots: Record<string, AdvisorySnapshot> = {};
    for (const ecosystem of ecosystems) {
      const snapshot = yield* store.read(ecosystem).pipe(
        Effect.catchTag("AdvisorySnapshotUnreadable", () => Effect.succeed(null)),
      );
      if (snapshot === null) return yield* refuse(ScanConfigReason.advisoryMissing(ecosystem));
      if (snapshotStale(snapshot, scope.now, scope.advisoryMaxAgeHours))
        return yield* refuse(ScanConfigReason.advisoryStale(ecosystem));
      snapshots[ecosystem] = snapshot;
    }
    return snapshots;
  });

/**
 * A scan's preconditions, before any scanner runs (specs/runs/gate.md § Security gate, step 1): the deployment pins a
 * bundle (FD-GATE-101); `cas/<pin>` holds it (FD-GATE-100, FD-GATE-102); its bytes' SHA-256 is the pin
 * (FD-GATE-103); its payload passes the schema; each scanner's version in the image lies inside its range
 * (FD-GATE-105); each baseline check's tool is a binary the image's scan-tools file lists (FD-GATE-109); and each
 * ecosystem whose lockfile the range changes has a recorded advisory snapshot no older than
 * `scan.advisoryMaxAgeHours` (FD-GATE-106, FD-GATE-107). The deploy verified the envelope's signature when it pinned
 * the digest, so the digest alone binds the bytes here.
 */
export const prepareScan = (
  scope: ScanScope,
): Effect.Effect<PreparedScan, ScanRefused, ScanBundleStore | ScanImage | AdvisorySnapshots> =>
  Effect.gen(function* () {
    const pin = scope.pin;
    if (pin === undefined || pin === "") return yield* refuse(ScanConfigReason.notPinned);
    const store = yield* ScanBundleStore;
    const image = yield* ScanImage;
    const bytes = yield* store.read(pin).pipe(
      Effect.catchTag("ScanBundleUnreadable", () => Effect.succeed(null)),
    );
    if (bytes === null) return yield* refuse(ScanConfigReason.missing);
    const digest = yield* checkDigest(bytes, pin).pipe(
      Effect.catchTag("ScanBundleDigestMismatch", () => refuse(ScanConfigReason.digest)),
    );
    const { envelope, json } = yield* decodeEnvelope(bytes).pipe(
      Effect.catchTag("ScanBundleMalformed", () => refuse(ScanConfigReason.schema(""))),
    );
    const payload = yield* decodePayload(json).pipe(
      Effect.catchTag("ScanBundleSchemaInvalid", (e) => refuse(ScanConfigReason.schema(e.path))),
    );
    const versions = {} as Record<Scanner, string>;
    for (const scanner of SCANNERS) {
      const version = yield* image.scannerVersion(scanner).pipe(
        Effect.catchTag("ScannerVersionUnknown", () =>
          refuse(ScanConfigReason.scannerVersion(scanner)),
        ),
      );
      if (!satisfies(version, payload.scanners[scanner].versions))
        return yield* refuse(ScanConfigReason.scannerVersion(scanner));
      versions[scanner] = version;
    }
    const tools = new Set(yield* image.scanTools);
    for (const check of payload.baselineChecks)
      if (!tools.has(check.tool)) return yield* refuse(ScanConfigReason.baselineCheck(check.controlId));
    const snapshots = yield* advisoryPreconditions(scope);
    return { bundle: { digest, envelope, payload }, versions, snapshots };
  });

/**
 * A security-gate scan: its preconditions, then `scan` over the prepared bundle. A failed precondition records
 * `failure` with its `config` reason and never calls `scan`, so no scanner runs.
 */
export const runScan = <E, R>(
  scope: ScanScope,
  scan: (prepared: PreparedScan) => Effect.Effect<Outcome, E, R>,
): Effect.Effect<Outcome, E, R | ScanBundleStore | ScanImage | AdvisorySnapshots> =>
  prepareScan(scope).pipe(
    Effect.matchEffect({
      onFailure: (refused) => Effect.succeed(Outcome.failure(refused.reason as Reason)),
      onSuccess: scan,
    }),
  );

/** The R2 reads the scan bundle store makes: an `R2Bucket`'s `get`. */
export interface ContentBucket {
  readonly get: (key: string) => Promise<{ readonly arrayBuffer: () => Promise<ArrayBuffer> } | null>;
}

/**
 * The scan bundle store over a bucket that holds the content-addressed namespace: the object at `cas/<digest>`
 * (`contentObjectKey`), its bytes as read. A failed `get` or body read is `ScanBundleUnreadable`.
 */
export const bucketScanBundleStore = (bucket: ContentBucket): Layer.Layer<ScanBundleStore> =>
  Layer.succeed(ScanBundleStore, {
    read: (digest) =>
      Effect.tryPromise({
        try: async () => {
          const object = await bucket.get(contentObjectKey(digest));
          return object === null ? null : new Uint8Array(await object.arrayBuffer());
        },
        catch: (e) => new ScanBundleUnreadable({ digest, detail: String(e) }),
      }),
  });
