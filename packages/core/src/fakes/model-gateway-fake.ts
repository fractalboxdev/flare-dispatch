// @fractalbox/flare-dispatch-core — ModelGateway fake.
//
// `RunContext` is the union of *all* capability services, so a test runtime
// needs a Layer for `ModelGateway` even when the run under test never calls a
// model. The fake records every `complete` request (inspectable via the state
// handle) and answers from a caller-supplied script:
//
//   * `responses: [...]` — a queue consumed one per call (the Nth `complete`
//     returns the Nth response). The last entry repeats once exhausted. This is
//     how the engine's tools→json auto-fallback is exercised: response 0 has
//     empty `toolCalls`, response 1 carries the text.
//   * a response may be a `ModelGatewayError` to drive the failure path.
//
// Absent a script, every call returns an empty result (no tool calls, no text)
// — enough to satisfy the Tag for a run that never asks a model.

import { Effect, Layer } from "effect";
import {
  ModelGateway,
  type ModelCompletionRequest,
  type ModelCompletionResult,
  ModelGatewayError,
  type ModelGatewayService,
} from "../services/model-gateway";

/** A scripted answer: a successful result or a backend failure. */
export type ModelGatewayFakeResponse =
  | ModelCompletionResult
  | ModelGatewayError;

export type ModelGatewayFakeOptions = {
  /**
   * Scripted answers consumed one per `complete` call (the last repeats once
   * the queue is drained). Absent → every call returns an empty result.
   */
  readonly responses?: ReadonlyArray<ModelGatewayFakeResponse>;
};

/** Inspectable record of every ModelGateway fake call. */
export type ModelGatewayFakeState = {
  /** Every `complete` request, in order. */
  readonly requests: ModelCompletionRequest[];
};

const EMPTY_RESULT: ModelCompletionResult = { toolCalls: [], text: "" };

const isError = (r: ModelGatewayFakeResponse): r is ModelGatewayError =>
  r instanceof ModelGatewayError;

/**
 * Build a ModelGateway fake plus an inspectable state handle. `complete`
 * records the request and answers from the script (or an empty result).
 */
export const makeModelGatewayFake = (
  opts: ModelGatewayFakeOptions = {},
): { layer: Layer.Layer<ModelGateway>; state: ModelGatewayFakeState } => {
  const state: ModelGatewayFakeState = { requests: [] };
  const responses = opts.responses ?? [];

  const service: ModelGatewayService = {
    complete: (req) =>
      Effect.suspend(() => {
        const i = state.requests.length;
        state.requests.push(req);
        const r =
          responses.length === 0
            ? EMPTY_RESULT
            : (responses[Math.min(i, responses.length - 1)] as
                ModelGatewayFakeResponse);
        return isError(r) ? Effect.fail(r) : Effect.succeed(r);
      }),
  };

  return { layer: Layer.succeed(ModelGateway, service), state };
};

/** A ready-to-use ModelGateway fake Layer — empty results, records calls. */
export const ModelGatewayFake: Layer.Layer<ModelGateway> =
  makeModelGatewayFake().layer;
