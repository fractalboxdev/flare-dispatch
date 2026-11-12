// The intake route group, mount-agnostic: the router passes the request and the
// path below its `/v1/` mount, and gets a response, or null for a path this
// group does not serve. Every error answers the error model with a request id;
// a defect answers `500 internal` and is logged under that id (FD-INT-064,
// FD-INT-065, FD-IFC-008).
import type { GithubRead } from "@fractalboxdev/flare-dispatch-github";
import { Cause, Effect } from "effect";
import type { Admission, ClassResolver, IntakeConfig } from "./config.ts";
import { intakeError, type IntakeError } from "./config.ts";
import { errorResponse, json } from "./http.ts";
import type { ManifestSource } from "./manifest.ts";
import type { HeldCheckReporter, InstallationEviction, ManifestReporter } from "./ports.ts";
import type { ProtectionSnapshots } from "./protection.ts";
import type { IntakeStore, ShedRecorder, StoreUnavailable } from "./store.ts";
import { handleWebhook } from "./webhook.ts";

/** Every service the intake routes call. */
export type IntakeEnv =
  | IntakeConfig
  | Admission
  | ClassResolver
  | IntakeStore
  | ShedRecorder
  | ManifestSource
  | ManifestReporter
  | HeldCheckReporter
  | GithubRead
  | InstallationEviction
  | ProtectionSnapshots;

/** The paths this group serves, below the `/v1/` mount, and the one method each takes. */
export const INTAKE_PATHS = [{ method: "POST", pattern: "webhooks/github" }] as const;

const matchPath = (path: string) => {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length === 2 && parts[0] === "webhooks" && parts[1] === "github")
    return { route: "webhook" as const };
  return null;
};

/**
 * `request` at `path`, the part of the URL path below `/v1/` (`webhooks/github`). Null when the group serves no such
 * path, so the router answers `404 not_found`.
 */
export const handleIntake = (
  request: Request,
  path: string,
): Effect.Effect<Response | null, never, IntakeEnv> => {
  const matched = matchPath(path);
  if (matched === null) return Effect.succeed(null);
  const requestId = crypto.randomUUID();
  const handled: Effect.Effect<Response, IntakeError | StoreUnavailable, IntakeEnv> =
    request.method !== "POST"
      ? Effect.fail(
          intakeError(405, "method_not_allowed", `${request.method} is not served on this path`),
        )
      : handleWebhook(request);
  return handled.pipe(
    Effect.catchTags({
      IntakeError: (e) => Effect.succeed(errorResponse(e, requestId)),
      StoreUnavailable: () =>
        Effect.succeed(
          errorResponse(
            intakeError(503, "unavailable", "the intake store did not answer"),
            requestId,
          ),
        ),
    }),
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logError("intake defect", { request_id: requestId, cause: Cause.pretty(cause) }),
        json({ error: "internal", message: "internal error", request_id: requestId }, 500),
      ),
    ),
  );
};
