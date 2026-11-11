// The declaration's groups as mountable units, each endpoint with the surface specs/interfaces.md assigns it.
import {
  ArtifactsGroup,
  DispatchGroup,
  ExecutionsGroup,
  ExecutorsGroup,
  LogsGroup,
  OpsGroup,
  WellKnownGroup,
} from "./declaration.ts";
import type { Layer } from "effect";
import type { HttpApiGroup } from "effect/http-api";
import { apiGroup, type Surface } from "./router.ts";
import { DispatchHandlers } from "./routes/dispatch.ts";
import { ExecutionsHandlers } from "./routes/executions.ts";
import { ExecutorsHandlers } from "./routes/executors.ts";
import { OpsHandlers } from "./routes/ops.ts";
import { WellKnownHandlers } from "./routes/well-known.ts";

const member: Surface = { _tag: "Access", group: "any" };
const operator: Surface = { _tag: "Access", group: "operators" };
const pub: Surface = { _tag: "Public" };

export const dispatchGroup = apiGroup({
  group: DispatchGroup,
  surfaces: { dispatch: { _tag: "Dispatch" } },
  handlers: DispatchHandlers,
});

export const executionsGroup = apiGroup({
  group: ExecutionsGroup,
  surfaces: {
    list: member,
    get: { _tag: "AccessOrActions" },
    failureSummary: member,
    cancel: member,
  },
  handlers: ExecutionsHandlers,
});

export const opsGroup = apiGroup({
  group: OpsGroup,
  surfaces: {
    halt: operator,
    quarantine: operator,
    release: operator,
    forceAdmit: operator,
    topUp: operator,
    drain: operator,
    revoke: operator,
    pauseKey: operator,
    resumeKey: operator,
    health: operator,
  },
  handlers: OpsHandlers,
});

export const executorsGroup = apiGroup({
  group: ExecutorsGroup,
  surfaces: { register: operator },
  handlers: ExecutorsHandlers,
});

export const wellKnownGroup = apiGroup({
  group: WellKnownGroup,
  surfaces: { openidConfiguration: pub, jwks: pub, health: pub },
  handlers: WellKnownHandlers,
});

const logLink: Surface = { _tag: "Link", purpose: "logs", param: "id" };

/**
 * The logs group, mounted with the cache-artifacts area's handlers. Its routes serve an Access identity or a link token
 * for that execution (FD-IFC-017).
 */
export const logsGroup = <R>(
  handlers: Layer.Layer<HttpApiGroup.Service<"flare-dispatch", "logs">, never, R>,
) =>
  apiGroup({
    group: LogsGroup,
    surfaces: { aggregate: logLink, file: logLink },
    handlers,
  });

const artifactLink: Surface = { _tag: "Link", purpose: "artifact", param: "artifact_id" };

/**
 * The artifacts group, mounted with the cache-artifacts area's handlers. An artifact and its browse paths serve an
 * Access identity or a link token for that artifact (FD-IFC-017); an execution's listing serves a member.
 */
export const artifactsGroup = <R>(
  handlers: Layer.Layer<HttpApiGroup.Service<"flare-dispatch", "artifacts">, never, R>,
) =>
  apiGroup({
    group: ArtifactsGroup,
    surfaces: { get: artifactLink, list: member },
    handlers,
  });

/** Every group of the declaration this package implements, in the order the Worker mounts them. */
export const declaredGroups = [
  wellKnownGroup,
  dispatchGroup,
  executionsGroup,
  opsGroup,
  executorsGroup,
] as const;
