// FlareDispatch's dedup recipes, the bindings the profile names in declared
// order (specs/profile.md § Dedup recipes and supersession, specs/intake.md
// § Records). mameko stores the SHA-256 of the first string a recipe returns.
import { dedupKey, type DedupRecipe } from "@fractalboxdev/mameko-coordinator";
import { Effect } from "effect";
import { minuteIso } from "./cron.ts";

export interface KeyedRequest {
  readonly run: string;
  readonly label: string | null;
  /** `<owner>/<repo>`. */
  readonly repo: string;
  readonly sha: string;
  /** A validated `Idempotency-Key` header and the dispatch body it covers. */
  readonly idempotency: { readonly key: string; readonly body: unknown } | null;
  /** The intent a `dispatch.followOn` applier submits for (FD-GH-088). */
  readonly followOn: { readonly executionId: string; readonly intentKey: string } | null;
  /** 1 for a first attempt; a check re-run submits *n* ≥ 2. */
  readonly attempt: number;
  /** The cron tick's scheduled minute, epoch ms. */
  readonly cronMinute: number | null;
  readonly local: {
    readonly leaseId: string;
    readonly treeHash: string;
    readonly inputsDigest: string;
  } | null;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

/** Whether a header value is an `Idempotency-Key` FD-INT-010 accepts; FD-INT-011 rejects every other. */
export const validIdempotencyKey = (value: string) => IDEMPOTENCY_KEY.test(value);

/**
 * The runs whose every request keys on the commit, so a push and a dispatch of one commit reach one execution; an
 * `Idempotency-Key` on their dispatch keys nothing (FD-GATE-062).
 */
export const COMMIT_SCOPED_RUNS: ReadonlySet<string> = new Set(["worker-deploy"]);

const runLabel = (r: KeyedRequest) => (r.label === null ? r.run : `${r.run}:${r.label}`);

/** The three recipes in the profile's order; `commit` is total (MAMEKO-ADM-034). */
export const dedupRecipes: readonly DedupRecipe<KeyedRequest>[] = [
  {
    name: "idempotency-key",
    run: (r) =>
      r.idempotency === null || COMMIT_SCOPED_RUNS.has(r.run)
        ? null
        : `idem:${r.repo}:${r.idempotency.key}`,
  },
  {
    name: "follow-on",
    run: (r) => (r.followOn === null ? null : `${r.followOn.executionId}/${r.followOn.intentKey}`),
  },
  {
    name: "commit",
    run: (r) => {
      if (r.local !== null)
        return `local:${r.local.leaseId}:${r.run}:${r.local.treeHash}:${r.local.inputsDigest}`;
      if (r.cronMinute !== null) return `${r.run}:${r.repo}:cron:${minuteIso(r.cronMinute)}`;
      const base = `${runLabel(r)}:${r.repo}:${r.sha}`;
      return r.attempt >= 2 ? `${base}:attempt-${r.attempt}` : base;
    },
  },
];

/** JSON with every object's keys sorted, so equal values serialize to equal bytes. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

const sha256Hex = (text: string) =>
  Effect.promise(async () => {
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    );
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  });

export interface RequestKey {
  readonly recipe: string;
  readonly canonical: string;
  readonly sha256: string;
  /** The SHA-256 of the dispatch body's canonical JSON, for the `idempotency-key` recipe only (MAMEKO-ADM-089). */
  readonly requestDigest: string | null;
  readonly onMismatch: "duplicate" | "conflict";
}

/** The request's key under the first recipe that returns one, and the digest that recipe declares. */
export const requestKey = (request: KeyedRequest): Effect.Effect<RequestKey> =>
  Effect.gen(function* () {
    const key = yield* Effect.promise(() => dedupKey(dedupRecipes, request));
    const idem = key.recipe === "idempotency-key" && request.idempotency !== null;
    return {
      ...key,
      requestDigest: idem ? yield* sha256Hex(canonicalJson(request.idempotency!.body)) : null,
      onMismatch: idem ? "conflict" : "duplicate",
    };
  });
