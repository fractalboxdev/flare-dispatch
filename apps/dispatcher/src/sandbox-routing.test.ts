// Tests for `selectSandboxNs` — the pure run → Container-binding routing.
// Sentinels stand in for the real `DurableObjectNamespace<Sandbox>` values.

import { describe, expect, it } from "vitest";
import { selectSandboxNs } from "./sandbox-routing";

const lean = "LEAN" as const;
const browser = "BROWSER" as const;
const agent = "AGENT" as const;

describe("selectSandboxNs", () => {
  it("routes a browser run to the browser binding when it is bound", () => {
    expect(selectSandboxNs("browser", { lean, browser })).toBe(browser);
  });

  it("degrades a browser run to lean when no browser binding is deployed", () => {
    expect(selectSandboxNs("browser", { lean, browser: undefined })).toBe(lean);
  });

  it("routes an agent run to the agent binding when it is bound", () => {
    expect(selectSandboxNs("agent", { lean, browser, agent })).toBe(agent);
  });

  it("degrades an agent run to lean when no agent binding is deployed", () => {
    expect(selectSandboxNs("agent", { lean, browser })).toBe(lean);
  });

  it("routes an explicit lean run to the lean binding", () => {
    expect(selectSandboxNs("lean", { lean, browser, agent })).toBe(lean);
  });

  it("defaults to lean when the run declares no sandboxImage", () => {
    expect(selectSandboxNs(undefined, { lean, browser, agent })).toBe(lean);
  });
});
