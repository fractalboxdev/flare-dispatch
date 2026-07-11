// FlareDispatch Dispatcher — signal a paused Workflow (`step.waitForEvent`).
//
// The one place that turns `RUNS_WORKFLOW.get(id).sendEvent(...)` into a typed
// outcome. Both signalling surfaces share it: the operator-facing
// `POST /v1/admin/events/:wf_id` route (admin-events.ts) and the GitHub-native
// release-PR approval path (webhook.ts → release-approval.ts).

import type { Env } from "./env";

/** The outcome of a `sendEvent` attempt. */
export type SignalOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `platform_not_supported` — old Workflow binding without `sendEvent`;
       *  `wf_not_found` — no running instance for this id (terminal/unknown);
       *  `send_event_failed` — any other delivery failure. */
      readonly reason:
        | "platform_not_supported"
        | "wf_not_found"
        | "send_event_failed";
      readonly message: string;
    };

/**
 * Deliver `{ type, payload }` to the Workflow instance `wfId`. `.get()` returns
 * a handle even for an unknown id; `sendEvent` rejects when the id isn't a
 * running instance — surfaced here as `wf_not_found` (not retryable).
 */
export const signalWorkflow = async (
  workflow: Env["RUNS_WORKFLOW"],
  wfId: string,
  type: string,
  payload: unknown,
): Promise<SignalOutcome> => {
  try {
    const handle = workflow.get(wfId);
    // `sendEvent` isn't on the older Workflow binding types; the cast keeps the
    // runtime call typed once CF's types catch up.
    const sendEvent = (
      handle as unknown as {
        sendEvent?: (e: { type: string; payload: unknown }) => Promise<void>;
      }
    ).sendEvent;
    if (typeof sendEvent !== "function") {
      return {
        ok: false,
        reason: "platform_not_supported",
        message:
          "this Workflow binding does not expose `sendEvent` — upgrade wrangler / compatibility_date",
      };
    }
    await sendEvent.call(handle, { type, payload });
    return { ok: true };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // CF Workflows raises distinct errors for unknown vs. terminated; the
    // signature is unstable across versions, so we keep this narrow.
    if (/not.?found|unknown.?instance/i.test(message)) {
      return { ok: false, reason: "wf_not_found", message };
    }
    return { ok: false, reason: "send_event_failed", message };
  }
};
