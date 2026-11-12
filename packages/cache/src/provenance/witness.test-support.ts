// Test support: a C2SP tlog-cosignature witness, its Ed25519 key, its note verifier key and the cosignature lines it
// signs.
import { hex, utf8 } from "../crypto.ts";
import { toBase64 } from "./merkle.ts";

export const witnessOf = async (name: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const key = new Uint8Array([0x04, ...raw]);
  const keyId = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array([...utf8(`${name}\n`), ...key])),
  ).subarray(0, 4);
  return {
    name,
    vkey: `${name}+${hex(keyId)}+${toBase64(key)}`,
    cosign: async (body: string, time: number) => {
      const ts = new Uint8Array(8);
      new DataView(ts.buffer).setBigUint64(0, BigInt(time));
      const sig = new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          pair.privateKey,
          utf8(`cosignature/v1\ntime ${time}\n${body}`),
        ),
      );
      return `— ${name} ${toBase64(new Uint8Array([...keyId, ...ts, ...sig]))}`;
    },
  };
};
export type Witness = Awaited<ReturnType<typeof witnessOf>>;
