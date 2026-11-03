// The declaration's groups as mountable units, each endpoint with the surface specs/interfaces.md assigns it.
import {
  DispatchGroup,
  ExecutionsGroup,
  ExecutorsGroup,
  OpsGroup,
  WellKnownGroup,
} from "./declaration.ts";
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
  surfaces: { list: member, get: member, failureSummary: member, cancel: member },
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

/** Every group of the declaration, in the order the Worker mounts them. */
export const declaredGroups = [
  wellKnownGroup,
  dispatchGroup,
  executionsGroup,
  opsGroup,
  executorsGroup,
] as const;
