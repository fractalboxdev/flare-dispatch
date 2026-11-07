// The webhook signature: HMAC-SHA256 over the raw request bytes, compared in
// constant time before any JSON is parsed (FD-INT-024, FD-IFC-022).
import { Effect } from "effect";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** `sha256=<hex>` of the body under the secret, the form GitHub sends in `X-Hub-Signature-256`. */
export const signBody = (secret: string, body: Uint8Array): Effect.Effect<string> =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, body.slice().buffer);
    return `sha256=${hex(new Uint8Array(mac))}`;
  });

/** Compares the SHA-256 digests of both strings, so the comparison takes the same time for every input length. */
export const constantTimeEquals = (a: string, b: string): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const digest = async (s: string) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
    const [x, y] = await Promise.all([digest(a), digest(b)]);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
    return diff === 0;
  });

/** Whether `header` is the body's signature under `secret`; a missing header never verifies. */
export const verifySignature = (
  secret: string,
  header: string | null,
  body: Uint8Array,
): Effect.Effect<boolean> =>
  header === null
    ? Effect.succeed(false)
    : Effect.flatMap(signBody(secret, body), (expected) => constantTimeEquals(header, expected));
