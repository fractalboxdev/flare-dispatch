// The Durable Object and Container classes specs/architecture.md § Components names whose behaviour this deploy
// cannot supply yet. Each is bound, so the configuration carries every component (FD-ARCH-001), and each answers every
// request `501 not_implemented` naming what it waits on, so nothing mistakes it for a working component.
import { DurableObject } from "cloudflare:workers";

const notImplemented = (component: string, waitsOn: string) =>
  Response.json(
    { error: "not_implemented", message: `${component} waits on ${waitsOn}` },
    { status: 501 },
  );

/** One per Container pool: mameko's pool controller (MAMEKO-HOST-059), which host-cloudflare does not export yet. */
export class PoolController extends DurableObject {
  override async fetch(): Promise<Response> {
    return notImplemented("PoolController", "host-cloudflare's pool controller class");
  }
}

/** A Container pool of the `cloudflare` executor kind; its launcher and outbound handler are mameko's. */
const pool = (name: string) =>
  class extends DurableObject {
    override async fetch(): Promise<Response> {
      return notImplemented(name, "host-cloudflare's Container launcher and outbound handler");
    }
  };

export const LeanPool = pool("LeanPool");
export const AgentPool = pool("AgentPool");
export const BrowserPool = pool("BrowserPool");
export const ReleasePool = pool("ReleasePool");
export const ControlPool = pool("ControlPool");
