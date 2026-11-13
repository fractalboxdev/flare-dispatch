// Scan bundles for the suites: a valid v1 payload, ES256 signing keys and signed envelopes, and the fakes of the scan
// bundle store and the gate image. The ops deploy suites import it too.
import { sha256Hex } from "@fractalboxdev/flare-dispatch-cache/crypto";
import {
  dssePae,
  signPae,
  type AnyDsseEnvelope,
  type ProvenanceKey,
} from "@fractalboxdev/flare-dispatch-cache/dsse";
import { Effect, Layer } from "effect";
import { ScanBundleStore, ScanBundleUnreadable, ScanImage, ScannerVersionUnknown } from "./ports.ts";
import { SCAN_BUNDLE_PAYLOAD_TYPE, type ScanBundleKey } from "./scan-bundle.ts";

/** A v1 payload that passes the schema, with one baseline check run by `semgrep`. */
export const validPayload = () => ({
  version: "2026.11.1",
  gitleaks: { config: "[extend]\nuseDefault = true\n" },
  zizmor: { config: "rules: {}\n" },
  scanners: {
    gitleaks: { versions: "^8.18.0", exitMap: { "0": "clean", "1": "finding" } },
    zizmor: { versions: ">=1.5.0 <2.0.0", exitMap: { "0": "clean", "13": "finding", "14": "finding" } },
    "osv-scanner": { versions: "~1.9.0", exitMap: { "0": "clean", "1": "finding", "128": "nothing-in-scope" } },
  },
  suppression: {
    files: [".gitleaksignore", "osv-scanner.toml"],
    markers: ["\\s*# zizmor: ignore\\[[^\\]]*\\]"],
  },
  baselineChecks: [
    {
      controlId: "SC-28",
      rule: "no plaintext secrets in config",
      tool: "semgrep",
      argv: ["semgrep", "--config", "p/secrets", "--error", "."],
      exitMap: { "0": "clean", "1": "finding" },
    },
  ],
});

/** The versions an image holds that `validPayload` accepts. */
export const IMAGE_VERSIONS = { gitleaks: "8.18.4", zizmor: "1.6.0", "osv-scanner": "1.9.2" } as const;

/** A fresh ES256 key: the private JWK that signs and the public JWK a `scan.bundleKeys` entry carries. */
export const signingKey = async (kid: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as unknown as { readonly privateKey: never };
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as {
    x?: string;
    y?: string;
    d?: string;
  };
  const priv = { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, d: jwk.d!, kid } as ProvenanceKey;
  const publicKey = { kty: "EC" as const, crv: "P-256" as const, x: jwk.x!, y: jwk.y!, kid };
  return { priv, publicKey };
};
export type SigningKey = Awaited<ReturnType<typeof signingKey>>;

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A `scan.bundleKeys` entry for `key` with the window `[notBefore, notAfter)`. */
export const keyEntry = (key: SigningKey, notBefore: number, notAfter: number): ScanBundleKey => ({
  publicKey: key.publicKey,
  notBefore: new Date(notBefore).toISOString(),
  notAfter: new Date(notAfter).toISOString(),
});

/** The envelope of `payload`, signed by each of `signers`, as the bytes a bundle file holds. */
export const envelopeBytes = async (
  payload: unknown,
  signers: readonly SigningKey[],
  payloadType: string = SCAN_BUNDLE_PAYLOAD_TYPE,
): Promise<Uint8Array> => {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const pae = dssePae(payloadType, body);
  const envelope: AnyDsseEnvelope = {
    payloadType,
    payload: base64(body),
    signatures: await Promise.all(signers.map((s) => signPae(s.priv, pae))),
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
};

export const digestOf = (bytes: Uint8Array) => sha256Hex(bytes);

/** What the fake store holds at a digest: bytes, nothing, or a read that fails. */
export type StoredBundle = Uint8Array | "absent" | "unreadable";

/** A scan bundle store over `objects` by digest, counting its reads. */
export const memoryScanBundleStore = (objects: ReadonlyMap<string, StoredBundle>) => {
  const reads: string[] = [];
  const layer = Layer.succeed(ScanBundleStore, {
    read: (digest) =>
      Effect.suspend(() => {
        reads.push(digest);
        const held = objects.get(digest) ?? "absent";
        if (held === "unreadable")
          return Effect.fail(new ScanBundleUnreadable({ digest, detail: "R2 answered 500" }));
        return Effect.succeed(held === "absent" ? null : held);
      }),
  });
  return { layer, reads };
};

/** A gate image whose scanners report `versions` (none for a scanner it lacks) and whose scan-tools file lists `tools`. */
export const fakeScanImage = (
  versions: Readonly<Partial<Record<string, string>>>,
  tools: readonly string[],
) =>
  Layer.succeed(ScanImage, {
    scannerVersion: (scanner) => {
      const version = versions[scanner];
      return version === undefined
        ? Effect.fail(new ScannerVersionUnknown({ scanner, detail: "not installed" }))
        : Effect.succeed(version);
    },
    scanTools: Effect.succeed(tools),
  });
