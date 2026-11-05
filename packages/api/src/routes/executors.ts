// `POST /v1/executors/register`: an operator enrolls one device key through mameko's `registerDevice` (FD-IFC-086 to
// FD-IFC-088). The surface admits only identities in `operators`.
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { FlareDispatchApi } from "../declaration.ts";
import { DeviceRegistry } from "../ports.ts";

export const ExecutorsHandlers = HttpApiBuilder.group(FlareDispatchApi, "executors", (handlers) =>
  handlers.handle("register", ({ payload }) =>
    Effect.gen(function* () {
      const registry = yield* DeviceRegistry;
      const { executorId, postureTier } = yield* registry.register(payload);
      return { executor_id: executorId, posture_tier: postureTier };
    }),
  ),
);
