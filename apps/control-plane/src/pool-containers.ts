// One Container class per Container pool (FD-ARCH-001), each mameko's `PoolContainer` with the gate image that
// `wrangler.jsonc` names: `enableInternet` false, no allowed host and HTTPS interception, so every request a Container
// makes reaches the outbound handler under its lease's grants (MAMEKO-ISO-018, MAMEKO-ISO-021). The Worker exports the
// Containers runtime's `ContainerProxy`, through which the runtime calls the outbound handler (MAMEKO-HOST-062).
import { PoolContainer } from "@fractalboxdev/mameko-host-cloudflare/containers";
import type { ControlPlaneEnv } from "./config.ts";

export { ContainerProxy } from "@fractalboxdev/mameko-host-cloudflare/containers";

export class LeanPool extends PoolContainer<ControlPlaneEnv> {}
export class AgentPool extends PoolContainer<ControlPlaneEnv> {}
export class BrowserPool extends PoolContainer<ControlPlaneEnv> {}
export class ReleasePool extends PoolContainer<ControlPlaneEnv> {}
