// Admission tickets (specs/adr/0004-admission-enforced-by-ticket.md).
//
// The substrate mints a ticket on admit — HMAC-SHA256 over the claims, TTL'd —
// and the container class refuses to boot without a valid one. Enforcement is
// at the container, not in the caller: the facade stores the ticket into the
// sandbox DO at admit, and the DO re-verifies it before any boot. Consumers
// never see a ticket; it is not part of the facade contract.
//
// Format: `v1.<base64url(claims JSON)>.<hex MAC>`. The MAC is computed over
// the exact encoded-claims bytes, so there is no canonicalization to disagree
// on. Verification is constant-time via `crypto.subtle.verify` (Workers'
// only supported primitive for it — never a hex-string compare).
import type { PoolName } from "@fractalboxdev/flare-dispatch-substrate-contract";

export type TicketClaims = {
  consumer: string;
  /** The consumer's sandbox key (un-namespaced). */
  key: string;
  pool: PoolName;
  /** ms-epoch. Refreshed by re-mint on heartbeat, never extended in place. */
  expiresAt: number;
};

/** Matches the admitted-slot heartbeat decay — one liveness story. */
export const TICKET_TTL_MS = 10 * 60_000;

const VERSION = "v1";
const encoder = new TextEncoder();

const importKey = (secret: string, usages: ("sign" | "verify")[]): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );

const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
};

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const b64urlDecode = (text: string): Uint8Array | null => {
  try {
    const padded = text.replaceAll("-", "+").replaceAll("_", "/");
    const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

export async function mintTicket(secret: string, claims: TicketClaims): Promise<string> {
  const payload = encoder.encode(JSON.stringify(claims));
  const key = await importKey(secret, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, payload as BufferSource);
  return `${VERSION}.${b64url(payload)}.${bytesToHex(mac)}`;
}

export type TicketVerdict =
  | { ok: true; claims: TicketClaims }
  | { ok: false; reason: string };

/**
 * Verify a ticket against what the boot path expects. Every mismatch fails
 * closed with a reason fit for a typed `ticket-rejected` refusal — never
 * echoing the MAC, and never treating a malformed ticket as unsigned-allow.
 */
export async function verifyTicket(
  secret: string,
  ticket: string | undefined,
  expect: { consumer: string; key: string },
  now: number,
): Promise<TicketVerdict> {
  if (!ticket) return { ok: false, reason: "no admission ticket" };
  const parts = ticket.split(".");
  const [version, payloadText, macText] = parts;
  if (parts.length !== 3 || version !== VERSION || !payloadText || !macText)
    return { ok: false, reason: "malformed admission ticket" };

  const payload = b64urlDecode(payloadText);
  const mac = hexToBytes(macText);
  if (payload === null || mac === null || mac.length !== 32)
    return { ok: false, reason: "malformed admission ticket" };

  const key = await importKey(secret, ["verify"]);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    mac as BufferSource,
    payload as BufferSource,
  );
  if (!valid) return { ok: false, reason: "admission ticket failed verification" };

  let claims: TicketClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(payload)) as TicketClaims;
  } catch {
    return { ok: false, reason: "malformed admission ticket" };
  }

  if (claims.consumer !== expect.consumer || claims.key !== expect.key)
    return { ok: false, reason: "admission ticket was minted for a different execution" };
  if (typeof claims.expiresAt !== "number" || now >= claims.expiresAt)
    return { ok: false, reason: "admission ticket expired" };

  return { ok: true, claims };
}
