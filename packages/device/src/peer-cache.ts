// Peer cache over the tailnet (specs/cache-artifacts.md FD-CACHE-014): the device extension serves its L1 entries,
// each with the manifest it was verified under, to the devices of its own member, and fetches a missed entry from
// them. The fetching side verifies the manifest signature and every object digest before L1 places the entry; the
// serving side answers only a connection that Tailscale's WhoIs names as a device of the same member.
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodePeerEntry,
  encodePeerManifest,
  type L1Cache,
  type Peer,
} from "@fractalboxdev/flare-dispatch-cache/device";
import { Effect, Option, Schema } from "effect";
import { namespaceWellFormed } from "./extension.ts";

/** The peer endpoint's one route: `GET /v1/peer-cache?namespace=<namespace>&key=<key>`. */
export const PEER_CACHE_PATH = "/v1/peer-cache";
/** The response header that carries the entry's manifest, base64url JSON; the body is the entry's one object. */
export const PEER_MANIFEST_HEADER = "fd-cache-manifest";
/** How long a fetch from one peer may take before it is a miss there. */
export const PEER_FETCH_TIMEOUT_MS = 10_000;

const KEY = /^[0-9a-f]{64}$/;

/** The member a connection's remote address belongs to, or null when it cannot be identified as one. */
export type Identify = (remoteAddress: string) => Promise<string | null>;

export interface PeerServerOptions {
  readonly l1: L1Cache;
  /** This device's member: the only member whose devices are answered. */
  readonly member: string;
  readonly identify: Identify;
}

/**
 * The peer endpoint's request handler. A connection whose remote address identifies as no member is closed; one of
 * another member is answered `403`; an entry L1 lacks, or holds without a manifest, is `404`.
 */
export const peerHandler =
  (options: PeerServerOptions) =>
  async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const member = await options.identify(request.socket.remoteAddress ?? "").catch(() => null);
    if (member === null) {
      request.socket.destroy();
      return;
    }
    if (member !== options.member) {
      response.writeHead(403).end();
      return;
    }
    // An absolute-form target with an invalid port parses in Node's HTTP parser but not as a URL.
    const url = URL.parse(request.url ?? "/", "http://peer");
    if (url === null) {
      response.writeHead(400).end();
      return;
    }
    if (request.method !== "GET" || url.pathname !== PEER_CACHE_PATH) {
      response.writeHead(404).end();
      return;
    }
    const namespace = url.searchParams.get("namespace") ?? "";
    const key = url.searchParams.get("key") ?? "";
    if (!namespaceWellFormed(namespace) || !KEY.test(key)) {
      response.writeHead(400).end();
      return;
    }
    const entry = await Effect.runPromise(options.l1.serve(namespace, key));
    const object = entry?.manifest.objects[0];
    const bytes = object === undefined ? undefined : entry?.objects.get(object.path);
    if (entry === null || bytes === undefined) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": bytes.byteLength,
        [PEER_MANIFEST_HEADER]: encodePeerManifest(entry.manifest),
      })
      .end(bytes);
  };

export interface PeerServer {
  readonly port: number;
  readonly close: () => Promise<void>;
}

/** Starts the peer endpoint on `host`, which is the device's Tailscale address outside a test. */
export const startPeerServer = (
  options: PeerServerOptions & { readonly host: string; readonly port: number },
): Promise<PeerServer> =>
  new Promise((ok, fail) => {
    const handle = peerHandler(options);
    // A throw in the handler answers 500 on that request; it never reaches the process as an unhandled rejection.
    const server = http.createServer((request, response) => {
      handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    server.once("error", fail);
    server.listen(options.port, options.host, () => {
      server.off("error", fail);
      ok({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });

/**
 * Another device's peer endpoint at `url`. Any failure, a non-`200` answer, a manifest that does not decode or a body
 * whose length differs from the manifest's object is a miss at that peer (FD-CACHE-011).
 */
export const httpPeer = (
  member: string,
  url: string,
  timeoutMs: number = PEER_FETCH_TIMEOUT_MS,
): Peer => ({
  member,
  fetch: async (namespace, key) => {
    const target = new URL(PEER_CACHE_PATH, url);
    target.searchParams.set("namespace", namespace);
    target.searchParams.set("key", key);
    const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
    const manifest = response.headers.get(PEER_MANIFEST_HEADER);
    if (response.status !== 200 || manifest === null) {
      await response.body?.cancel();
      return null;
    }
    const entry = decodePeerEntry(manifest, new Uint8Array(await response.arrayBuffer()));
    const object = entry?.manifest.objects[0];
    return object !== undefined && entry?.objects.get(object.path)?.byteLength === object.size ? entry : null;
  },
});

/** The fields of Tailscale's WhoIs answer that name a connection's owner. */
const WhoIs = Schema.Struct({
  Node: Schema.Struct({ Tags: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))) }),
  UserProfile: Schema.Struct({ LoginName: Schema.String }),
});
const decodeWhoIs = Schema.decodeUnknownOption(Schema.fromJsonString(WhoIs));

/** Tailscale's WhoIs command; the remote address is appended as its last argument. */
export const TAILSCALE_WHOIS = ["tailscale", "whois", "--json"] as const;

/**
 * Identifies a connection by Tailscale's WhoIs for its remote address: the login of the user who owns the node. A
 * tagged node, an address WhoIs does not know, or a failed command identifies as no member.
 */
export const tailscaleWhois =
  (command: readonly string[] = TAILSCALE_WHOIS): Identify =>
  (remoteAddress) =>
    new Promise((ok) => {
      const [program, ...args] = command;
      if (program === undefined || remoteAddress === "") return ok(null);
      execFile(
        program,
        [...args, remoteAddress.replace(/^::ffff:/, "")],
        { timeout: 5_000 },
        (failure, stdout) => {
          const whois = failure === null ? Option.getOrNull(decodeWhoIs(stdout)) : null;
          ok(whois === null || (whois.Node.Tags ?? []).length > 0 ? null : whois.UserProfile.LoginName);
        },
      );
    });

/** The control plane's cache-signing public key, an ES256 JWK. */
const PublicJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
});

/**
 * The peer-cache setting, read from the JSON file `FD_PEER_CACHE` names. `listen` is the device's Tailscale address
 * and port; `peers` are the other devices of the member; `keys` are the keys a fetched manifest is verified against.
 */
export const PeerCacheConfig = Schema.Struct({
  enabled: Schema.Boolean,
  member: Schema.String,
  listen: Schema.Struct({ host: Schema.String, port: Schema.Number }),
  peers: Schema.Array(Schema.Struct({ member: Schema.String, url: Schema.String })),
  keys: Schema.Struct({
    control_plane: PublicJwk,
    /** Each device's registered `cache-entry` public key, base64 SPKI, by executor id. */
    devices: Schema.Record(Schema.String, Schema.String),
  }),
  /** The WhoIs command, default `tailscale whois --json`. */
  whois: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type PeerCacheConfig = typeof PeerCacheConfig.Type;

export const decodePeerCacheConfig = Schema.decodeUnknownOption(Schema.fromJsonString(PeerCacheConfig));
