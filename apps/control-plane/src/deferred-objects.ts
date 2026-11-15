// The component specs/architecture.md § Components names whose behaviour this deploy cannot supply yet. It is bound,
// so the configuration carries every component (FD-ARCH-001), and it answers every request `501 not_implemented`
// naming what it waits on, so nothing mistakes it for a working component.
import { DurableObject } from "cloudflare:workers";

/**
 * The `control` pool: a `cloudflare` executor whose runner runs each run program inside a Durable Object with no
 * Container (MAMEKO-EXEC-056), which host-cloudflare does not provide yet. No pool declaration names it, so nothing
 * claims for it.
 */
export class ControlPool extends DurableObject {
  override async fetch(): Promise<Response> {
    return Response.json(
      {
        error: "not_implemented",
        message: "ControlPool waits on host-cloudflare's control pool (MAMEKO-EXEC-056)",
      },
      { status: 501 },
    );
  }
}
