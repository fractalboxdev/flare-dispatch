// @fractalboxdev/flare-dispatch-core — Notice fake.
//
// `RunContext` is the union of *all* capability services, so `CFRuntimeTest`
// needs a Layer for `Notice` even when the run under test never publishes. The
// fake records every `publish` call (inspectable via the state handle) and
// reports it delivered.
//
// A test that needs a notice to FAIL sets `outcome`: the interesting assertion
// on this capability is not "it posted" but "the run's verdict did not move
// when it didn't", and that needs the failing branch reachable.
//
// Spec: specs/pm/plan.md § 3 (fakes/), specs/03-dsl.md § Layers.

import { Effect, Layer } from "effect";
import {
  Notice,
  type NoticeRequest,
  type NoticeResult,
  type NoticeService,
} from "../services/notice";

/** Inspectable record of every Notice fake call. */
export type NoticeFakeState = {
  /** every `publish` request, in order. */
  readonly published: NoticeRequest[];
};

export type NoticeFakeOptions = {
  /**
   * What every `publish` reports. Default `"delivered"`. `"failed"` and
   * `"skipped"` drive the branches a caller must survive without changing its
   * own result.
   */
  readonly outcome?: "delivered" | "duplicate" | "failed" | "skipped";
};

const resultFor = (outcome: NonNullable<NoticeFakeOptions["outcome"]>): NoticeResult => {
  switch (outcome) {
    case "delivered":
      return { delivered: true, duplicate: false, skipped: false };
    case "duplicate":
      return { delivered: false, duplicate: true, skipped: false };
    case "skipped":
      return { delivered: false, duplicate: false, skipped: true, reason: "no notice backend" };
    case "failed":
      return { delivered: false, duplicate: false, skipped: false, reason: "fake failure" };
  }
};

/**
 * Build a Notice fake plus an inspectable state handle. `publish` records the
 * request and reports the configured outcome — always as DATA, never as an
 * error, because the real service is total too.
 */
export const makeNoticeFake = (
  opts: NoticeFakeOptions = {},
): { layer: Layer.Layer<Notice>; state: NoticeFakeState } => {
  const state: NoticeFakeState = { published: [] };
  const result = resultFor(opts.outcome ?? "delivered");
  const service: NoticeService = {
    publish: (req) =>
      Effect.sync(() => {
        state.published.push(req);
        return result;
      }),
  };
  return { layer: Layer.succeed(Notice, service), state };
};

/** A ready-to-use Notice fake Layer — accepts everything, records calls. */
export const NoticeFake: Layer.Layer<Notice> = makeNoticeFake().layer;
