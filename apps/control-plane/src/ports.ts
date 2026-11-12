// The mameko application ports the composition supplies a Layer for, by port id, which configuration validation reads
// (MAMEKO-HOST-046). The ops package's `composedPorts` names the Layer `composition.ts` builds for each entry, and the
// deploy stage reads the same function over the rendered vars and the Worker's secrets (FD-ARCH-039), so the Worker
// and the deploy check agree on one list.
import { composedPorts } from "@fractalboxdev/flare-dispatch-ops";
import type { ControlPlaneEnv } from "./config.ts";

export const suppliedPorts = (env: ControlPlaneEnv): readonly string[] =>
  composedPorts(env as unknown as Readonly<Record<string, unknown>>);
