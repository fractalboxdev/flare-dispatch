// FlareDispatch's device extension: the plane's process beside mameko's device executor, answering the extension
// interface on file descriptor 3 (MAMEKO-EXEC-152). It holds L1 per cache namespace — the cache package's L1, which
// reads through to L2 on a miss and uploads to L2 after a put — and `LocalContent` per tenant scope, and restores a
// cache entry only for a namespace a lease it was handed may read (FD-EXEC-007). Its `statement` operation answers the
// unsigned DSSE envelope the statement builder writes (specs/provenance.md § Statement flow). Peer cache is not an
// operation of this interface: its endpoint is served to other devices over the tailnet (`peer-cache.ts`).
import { createHash } from "node:crypto";
import type { L1Cache, L2Client } from "@fractalboxdev/flare-dispatch-cache/device";
import { decodeExtensionLine, type ExtensionMessage } from "@fractalboxdev/mameko-protocol";
import { Cause, Effect, Exit, Schema } from "effect";
import { buildEnvelope } from "./statement.ts";

/** The extension's protocol version. */
export const EXTENSION_VERSION = 1;

/** The default share of the free disk measured at start that L1 may hold (FD-CACHE-009). */
export const DEFAULT_L1_SHARE = 0.2;

/** The operations this extension serves. */
export const OPERATIONS = [
  "cache.get",
  "cache.put",
  "cache.evict",
  "content.put",
  "content.get",
  "proxies",
  "statement",
] as const;

/** The cache namespace forms of the profile's `cache_namespaces` binding (specs/README.md § Glossary). */
const REPO = String.raw`[\w.-]+/[\w.-]+`;
const NAMESPACE = new RegExp(
  String.raw`^(protected/${REPO}/(cloud|device)|pr/${REPO}/[1-9]\d*|exec/${REPO}/[0-9A-HJKMNP-TV-Z]{26}|cas/[0-9a-f]{64})$`,
);

export const namespaceWellFormed = (namespace: string): boolean => NAMESPACE.test(namespace);

/** A cache key: the SHA-256 of the key fields, lowercase hex (specs/cache-artifacts.md § Cache keys). */
const KEY = /^[0-9a-f]{64}$/;

/**
 * L2 on a deploy whose device extension has no presigned-URL transport: every read is a miss and every upload is
 * skipped, so L1 alone serves the device executor.
 */
export const absentL2: L2Client = {
  fetch: async () => null,
  upload: async () => {},
};

/** The cache namespaces of one lease, as the lease names them. */
const LeaseNamespaces = Schema.Struct({
  execution_id: Schema.String,
  cache_namespaces: Schema.Struct({
    read: Schema.Array(Schema.String),
    write: Schema.NullOr(Schema.String),
  }),
});
const decodeLease = Schema.decodeUnknownExit(LeaseNamespaces);

export interface ExtensionState {
  readonly planeId: string;
  readonly l1: L1Cache;
  /** `LocalContent` per tenant scope, held in memory for the extension's lifetime. */
  readonly content: Map<string, Uint8Array>;
  /** The namespaces the leases handed to the extension may read and write. */
  readonly readable: Set<string>;
  readonly writable: Set<string>;
}

export const hello = (planeId: string) => ({
  type: "extension.hello" as const,
  id: "hello",
  plane_id: planeId,
  version: EXTENSION_VERSION,
  operations: [...OPERATIONS],
});

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

type Reply = Record<string, unknown> & {
  readonly type: string;
  readonly id: string;
  readonly ref: string;
};

const error = (
  ref: string,
  code: "unavailable" | "invalid" | "unsupported",
  message: string,
): Reply => ({
  type: "extension.error",
  id: `error-${ref}`,
  ref,
  code,
  message,
});

/**
 * Whether a workspace may restore from a namespace: only an entry of a well-formed namespace that a lease handed to
 * this extension names as readable (FD-EXEC-007).
 */
export const restoreAdmitted = (
  state: Pick<ExtensionState, "readable">,
  namespace: string,
): boolean => namespaceWellFormed(namespace) && state.readable.has(namespace);

/**
 * One request answered; `null` for a message that takes no answer. A `cache.get` that L1 lacks reads through to L2
 * and returns the entry only once every object digest verifies against its manifest (FD-CACHE-006); a `cache.put`
 * writes L1 and then uploads to L2 (FD-CACHE-007).
 */
export const answer = (state: ExtensionState, m: ExtensionMessage): Effect.Effect<Reply | null> => {
  const ok = (type: string, fields: Record<string, unknown>): Reply => ({
    type,
    id: `${type}-${m.id}`,
    ref: m.id,
    ...fields,
  });
  return Effect.gen(function* () {
    switch (m.type) {
      case "proxies": {
        const lease = decodeLease(m.lease);
        if (Exit.isSuccess(lease)) {
          for (const ns of lease.value.cache_namespaces.read) state.readable.add(ns);
          if (lease.value.cache_namespaces.write !== null)
            state.writable.add(lease.value.cache_namespaces.write);
        }
        return ok("proxies.ok", { proxies: [] });
      }
      case "cache.get": {
        if (!restoreAdmitted(state, m.namespace)) return ok("cache.get.ok", { bytes: null });
        const bytes = yield* state.l1.get(m.namespace, m.key);
        return ok("cache.get.ok", { bytes: bytes === null ? null : b64(bytes) });
      }
      case "cache.put":
        if (!namespaceWellFormed(m.namespace) || !state.writable.has(m.namespace))
          return error(m.id, "invalid", `namespace ${m.namespace} is not writable by any lease`);
        if (!KEY.test(m.key)) return error(m.id, "invalid", `key ${m.key} is not a cache key`);
        return ok("cache.put.ok", {
          digest: `sha256:${yield* state.l1.put(m.namespace, m.key, unb64(m.bytes))}`,
        });
      case "cache.evict":
        return ok("cache.evict.ok", { freed_bytes: yield* state.l1.evict(m.target_bytes) });
      case "content.put": {
        const bytes = unb64(m.bytes);
        const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        state.content.set(`${m.scope_id}/${digest}`, bytes);
        return ok("content.put.ok", { digest });
      }
      case "content.get": {
        const bytes = state.content.get(`${m.scope_id}/${m.digest}`);
        return ok("content.get.ok", { bytes: bytes === undefined ? null : b64(bytes) });
      }
      case "statement":
        return yield* buildEnvelope(m.input).pipe(
          Effect.map((envelope) =>
            ok("statement.ok", { bytes: b64(new TextEncoder().encode(JSON.stringify(envelope))) }),
          ),
          Effect.catchTag("StatementInputInvalid", (e) =>
            Effect.succeed(error(m.id, "invalid", e.message)),
          ),
        );
      case "extension.welcome":
      case "extension.error":
        return null;
      default:
        return error(m.id, "unsupported", `${m.type} is not an operation of this extension`);
    }
  }).pipe(
    Effect.catchCause((cause) => {
      const failure = Cause.squash(cause);
      return Effect.succeed(
        error(m.id, "unavailable", failure instanceof Error ? failure.message : String(failure)),
      );
    }),
  );
};

/** One line of the socket answered, or an `extension.error` for a malformed or oversized line. */
export const answerLine = (state: ExtensionState, line: string): Effect.Effect<Reply | null> => {
  const decoded = decodeExtensionLine(line);
  switch (decoded._tag) {
    case "Message":
      return answer(state, decoded.message);
    case "Malformed":
      return Effect.succeed(
        error("malformed", "invalid", "the line is not a message of the extension schema"),
      );
    case "TooLarge":
      return Effect.succeed(error("too-large", "invalid", "the line exceeds 1 MiB"));
  }
};
