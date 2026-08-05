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
  repos: ["fractalboxdev/flare-dispatch"],
  refs: [
    { value: "refs/heads/main", label: "main" },
    { value: "refs/heads/alpha", label: "alpha" },
  ],
  commits: [{ sha: "abc1234def", label: "abc1234 · fix things" }],
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

  it("renders repo/ref/commit as select dropdowns, not text inputs", () => {
    const html = renderDeployPage(base());
    expect(html).toContain('<select name="repo">');
    expect(html).toContain('<select name="ref">');
    expect(html).toContain('<select name="sha">');
    expect(html).not.toContain('<input name="repo"');
    // ref options carry the full ref as value, the short name as label
    expect(html).toContain('<option value="refs/heads/main">main</option>');
    // commit dropdown always leads with the resolve-latest option
    expect(html).toContain('<option value="">Latest commit on the selected ref</option>');
    expect(html).toContain('<option value="abc1234def">');
  });

  it("labels an approval-gated environment", () => {
    const html = renderDeployPage(base());
    expect(html).toContain("approval + cooldown");
    expect(html).toContain('class="prod"');
  });

  it("lists the resolved groups one per row so policy setup is debuggable", () => {
    const html = renderDeployPage(
      base({ groups: ["fractalboxdev/devs", "fractalboxdev/friends"] }),
    );
    expect(html).toContain("<li>fractalboxdev/devs</li>");
    expect(html).toContain("<li>fractalboxdev/friends</li>");
    // Never run together on one line — a row is copied verbatim into the policy.
    expect(html).not.toContain("fractalboxdev/devs, fractalboxdev/friends");
  });

  it("says so plainly when the identity carries no groups", () => {
    expect(renderDeployPage(base({ groups: [] }))).toContain('<li class="empty">(none)</li>');
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
    const html = renderDeployPage(base({ email: "<script>@x", groups: ['a"><b'] }));
    expect(html).not.toContain("<script>@x");
    expect(html).toContain("&lt;script&gt;@x");
    expect(html).not.toContain('a"><b');
  });
});
