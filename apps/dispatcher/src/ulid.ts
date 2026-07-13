// FlareDispatch Dispatcher — ULID generation for execution ids.
//
// An execution id is a ULID: a 26-char Crockford-base32 string, lexically
// sortable by creation time (48-bit ms timestamp + 80 bits of crypto-random).
// V0 does not pull a `ulid` npm dependency — a ULID is ~30 lines and adding a
// dep would churn the lockfile and the `--frozen-lockfile` CI install for no
// real benefit. This generator uses `crypto.getRandomValues`, which is on the
// Workers runtime.
//
// The id doubles as the CF Workflow `instanceId` (`RUNS_WORKFLOW.create({ id
// }))`) and namespaces D1 rows + R2 keys downstream.

/** Crockford base32 alphabet — excludes I, L, O, U to avoid ambiguity. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = ENCODING.length; // 32
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Encode a non-negative integer as `len` Crockford-base32 chars. */
const encodeTime = (now: number, len: number): string => {
  let mod: number;
  let str = "";
  let value = now;
  for (let i = len - 1; i >= 0; i--) {
    mod = value % ENCODING_LEN;
    str = ENCODING[mod] + str;
    value = (value - mod) / ENCODING_LEN;
  }
  return str;
};

/** `RANDOM_LEN` Crockford-base32 chars from CSPRNG bytes. */
const encodeRandom = (len: number): string => {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let str = "";
  for (let i = 0; i < len; i++) {
    // Map each random byte into the 32-char alphabet (byte & 0x1f).
    str += ENCODING[bytes[i]! & (ENCODING_LEN - 1)];
  }
  return str;
};

/**
 * Generate a ULID. Optionally pass an explicit `seedTime` (ms epoch) — used by
 * tests for determinism; defaults to `Date.now()`.
 */
export const ulid = (seedTime: number = Date.now()): string =>
  encodeTime(seedTime, TIME_LEN) + encodeRandom(RANDOM_LEN);
