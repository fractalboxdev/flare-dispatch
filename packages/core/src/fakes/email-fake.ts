// @fractalbox/flare-dispatch-core — Email fake.
//
// `RunContext` is the union of *all* capability services, so `CFRuntimeTest`
// needs a Layer for `Email` even when the run under test never sends mail. The
// fake records every `send` call (inspectable via the state handle) and accepts
// all recipients — a test that needs a recipient *rejected* builds its own
// failing Layer.
//
// Spec: specs/pm/plan.md § 3 (fakes/), specs/03-dsl.md § Layers.

import { Effect, Layer } from "effect";
import {
  Email,
  type EmailSendRequest,
  type EmailService,
} from "../services/email";

/** Inspectable record of every Email fake call. */
export type EmailFakeState = {
  /** every `send` request, in order. */
  readonly sent: EmailSendRequest[];
};

/**
 * Build an Email fake plus an inspectable state handle. `send` records the
 * request and accepts every recipient, returning a deterministic message id.
 */
export const makeEmailFake = (): {
  layer: Layer.Layer<Email>;
  state: EmailFakeState;
} => {
  const state: EmailFakeState = { sent: [] };
  const service: EmailService = {
    send: (req) =>
      Effect.sync(() => {
        state.sent.push(req);
        return {
          accepted: req.to,
          rejected: [],
          messageId: `fake-message-${state.sent.length}`,
          skipped: false,
        };
      }),
  };
  return { layer: Layer.succeed(Email, service), state };
};

/** A ready-to-use Email fake Layer — accepts every recipient, records calls. */
export const EmailFake: Layer.Layer<Email> = makeEmailFake().layer;
