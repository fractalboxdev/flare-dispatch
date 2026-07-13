// Deploy-console page renderer — pure string tests.

import { describe, expect, it } from "vitest";
import { renderDeployPage, type DeployPageData } from "./deploy-page";

const base = (over: Partial<DeployPageData> = {}): DeployPageData => ({
  email: "dev@example.com",
  idp: "github",
  groups: ["fractalboxdev/devs"],
  envs: [
    { name: "staging", requiresApproval: false },
    { name: "production", requiresApproval: true },
  ],
  repoDefault: "fractalboxdev/flare-dispatch",
  refDefault: "refs/heads/main",
  ...over,
});

describe("renderDeployPage", () => {
  it("renders a deploy button per authorized environment", () => {
    const html = renderDeployPage(base());
    expect(html).toContain('name="env" value="staging"');
    expect(html).toContain('name="env" value="production"');
    expect(html).toContain('action="/deploy"');
    expect(html).toContain("dev@example.com");
  });

  it("labels an approval-gated environment", () => {
    const html = renderDeployPage(base());
    expect(html).toContain("approval + cooldown");
    expect(html).toContain('class="prod"');
  });

  it("shows the resolved groups so policy setup is debuggable", () => {
    expect(renderDeployPage(base())).toContain("fractalboxdev/devs");
    expect(renderDeployPage(base({ groups: [] }))).toContain("groups: (none)");
  });

  it("shows a legible message when authorized for nothing", () => {
    const html = renderDeployPage(base({ envs: [] }));
    expect(html).toContain("isn't authorized to deploy");
    expect(html).not.toContain('name="env"');
  });

  it("surfaces a notice when present", () => {
    const html = renderDeployPage(base({ notice: "Deploy queued: abc123" }));
    expect(html).toContain("Deploy queued: abc123");
  });

  it("escapes identity + group values (no HTML injection)", () => {
    const html = renderDeployPage(
      base({ email: "<script>@x", groups: ['a"><b'] }),
    );
    expect(html).not.toContain("<script>@x");
    expect(html).toContain("&lt;script&gt;@x");
    expect(html).not.toContain('a"><b');
  });
});
