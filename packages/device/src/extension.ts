// FlareDispatch's device extension: the plane's process beside mameko's device executor, answering the extension
// interface on file descriptor 3 (MAMEKO-EXEC-132). It holds L1 per cache namespace and `LocalContent` per tenant
// scope, and restores a cache entry only for a namespace a lease it was handed may read (FD-EXEC-007).
import { createHash } from "node:crypto";
import { decodeExtensionLine, type ExtensionMessage } from "@fractalboxdev/mameko-protocol";
import { Exit, Schema } from "effect";
import { namespaceWellFormed, type L1 } from "./l1.ts";

/** The extension's protocol version. */
export const EXTENSION_VERSION = 1;

/** The operations this extension serves; `statement` needs a signing operation the device extension lacks. */
export const OPERATIONS = [
  "cache.get",
  "cache.put",
  "cache.evict",
  "content.put",
  "content.get",
  "proxies",
] as const;

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
  readonly l1: L1;
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
 * Whether a workspace may restore from a namespace: only an L1 entry of a well-formed namespace that a lease handed to
 * this extension names as readable (FD-EXEC-007).
 */
export const restoreAdmitted = (
  state: Pick<ExtensionState, "readable">,
  namespace: string,
): boolean => namespaceWellFormed(namespace) && state.readable.has(namespace);

/** One request answered; `null` for a message that takes no answer. */
export const answer = (state: ExtensionState, m: ExtensionMessage): Reply | null => {
  const ok = (type: string, fields: Record<string, unknown>): Reply => ({
    type,
    id: `${type}-${m.id}`,
    ref: m.id,
    ...fields,
  });
  try {
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
      case "cache.get":
        return ok("cache.get.ok", {
          bytes: restoreAdmitted(state, m.namespace)
            ? (() => {
                const bytes = state.l1.get(m.namespace, m.key);
                return bytes === null ? null : b64(bytes);
              })()
            : null,
        });
      case "cache.put":
        if (!namespaceWellFormed(m.namespace) || !state.writable.has(m.namespace))
          return error(m.id, "invalid", `namespace ${m.namespace} is not writable by any lease`);
        return ok("cache.put.ok", { digest: state.l1.put(m.namespace, m.key, unb64(m.bytes)) });
      case "cache.evict":
        return ok("cache.evict.ok", { freed_bytes: state.l1.evict(m.target_bytes) });
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
      case "extension.welcome":
      case "extension.error":
        return null;
      default:
        return error(m.id, "unsupported", `${m.type} is not an operation of this extension`);
    }
  } catch (cause) {
    return error(m.id, "unavailable", cause instanceof Error ? cause.message : String(cause));
  }
};

/** One line of the socket answered, or an `extension.error` for a malformed or oversized line. */
export const answerLine = (state: ExtensionState, line: string): Reply | null => {
  const decoded = decodeExtensionLine(line);
  switch (decoded._tag) {
    case "Message":
      return answer(state, decoded.message);
    case "Malformed":
      return error("malformed", "invalid", "the line is not a message of the extension schema");
    case "TooLarge":
      return error("too-large", "invalid", "the line exceeds 1 MiB");
  }
};
