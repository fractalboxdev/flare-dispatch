// @fractalboxdev/flare-dispatch-core — Scm fake (provider-neutral source control).
//
// In-memory fake of the `scm` capability, mirroring `makeModelGatewayFake`:
// `fetchDiff` returns a canned diff and records the `ChangeRef`; `postReview`
// records the note, returns a canned `noteId`, and succeeds; `updateReview`
// records the call and succeeds. A test asserts on the recorded calls to prove
// the review fetched the diff and posted/updated exactly the notes it expects.
//
// A test that wants `scm` to FAIL with `ScmError` constructs its own failing
// `Scm` Layer — the fake is the green-path simulator (same posture as the
// Github fake).

import { Effect, Layer } from "effect";
import {
  type ChangeRef,
  type FetchDiffResult,
  type PostReviewResult,
  type ReviewNote,
  Scm,
  type ScmService,
  type UpdateReviewNote,
} from "../services/scm";

/** Inspectable record of every Scm fake call. */
export type ScmFakeState = {
  /** Every `fetchDiff` ref, in order. */
  readonly fetchDiffCalls: ChangeRef[];
  /** Every `postReview` note, in order — lets a test assert a note posted. */
  readonly postReviewCalls: ReviewNote[];
  /** Every `updateReview` call, in order. */
  readonly updateReviewCalls: UpdateReviewNote[];
};

export type ScmFakeOptions = {
  /** Canned diff every `fetchDiff` returns. Default: a tiny one-file diff. */
  readonly diff?: string;
  /** Canned `truncated` flag `fetchDiff` returns (see {@link FetchDiffResult}).
   *  Default `undefined` (omitted — "not truncated"). */
  readonly truncated?: boolean;
  /** Canned `pages` count `fetchDiff` returns. Default `undefined`. */
  readonly pages?: number;
  /**
   * The `noteId` every `postReview` call returns (mirrors a real provider note
   * id). Default `"fake-note-1"`. Pass `null` to simulate a degraded/failed
   * post (no credentials, or the post itself failed).
   */
  readonly noteId?: string | null;
};

/** Default canned diff — a minimal, valid one-file unified diff. */
const DEFAULT_DIFF =
  "diff --git a/src/x.ts b/src/x.ts\n" +
  "--- a/src/x.ts\n" +
  "+++ b/src/x.ts\n" +
  "@@ -1 +1 @@\n" +
  "-const x = 1;\n" +
  "+const x = 2;\n";

/** Default canned note id `postReview` returns. */
const DEFAULT_NOTE_ID = "fake-note-1";

/**
 * Build an Scm fake plus an inspectable state handle. `fetchDiff` records the
 * ref and returns the canned diff; `postReview` records the note and returns
 * the canned `noteId`; `updateReview` records the call and succeeds.
 */
export const makeScmFake = (
  opts: ScmFakeOptions = {},
): { layer: Layer.Layer<Scm>; state: ScmFakeState } => {
  const state: ScmFakeState = { fetchDiffCalls: [], postReviewCalls: [], updateReviewCalls: [] };
  const diff = opts.diff ?? DEFAULT_DIFF;
  const noteId = opts.noteId === undefined ? DEFAULT_NOTE_ID : opts.noteId;

  const service: ScmService = {
    fetchDiff: (ref) =>
      Effect.sync((): FetchDiffResult => {
        state.fetchDiffCalls.push(ref);
        return {
          diff,
          ...(opts.truncated !== undefined ? { truncated: opts.truncated } : {}),
          ...(opts.pages !== undefined ? { pages: opts.pages } : {}),
        };
      }),
    postReview: (note) =>
      Effect.sync((): PostReviewResult => {
        state.postReviewCalls.push(note);
        return { noteId };
      }),
    updateReview: (note) =>
      Effect.sync(() => {
        state.updateReviewCalls.push(note);
      }),
  };

  return { layer: Layer.succeed(Scm, service), state };
};

/** A ready-to-use Scm fake Layer — canned diff, records calls. */
export const ScmFake: Layer.Layer<Scm> = makeScmFake().layer;
