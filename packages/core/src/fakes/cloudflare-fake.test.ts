// Cloudflare fake unit tests — the read-only deployments simulator.

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { cloudflare, type DeploymentRef } from "../services/cloudflare";
import { makeCloudflareFake } from "./cloudflare-fake";

const NOW = 1_700_000_000_000;

const dep = (over: Partial<DeploymentRef> & Pick<DeploymentRef, "project">): DeploymentRef => ({
  id: "d1",
  environment: "production",
  status: "success",
  url: "https://x.pages.dev",
  branch: "main",
  createdAt: NOW,
  ...over,
});

describe("makeCloudflareFake", () => {
  it("filters by project allow-list, status and environment", async () => {
    const { layer, state } = makeCloudflareFake({
      now: NOW,
      deployments: [
        dep({ project: "site-a", status: "failure" }),
        dep({ project: "site-a", status: "success" }),
        dep({ project: "site-b", status: "failure" }),
      ],
    });
    const got = await Effect.runPromise(
      cloudflare
        .deployments({ projects: ["site-a"], status: "failure" })
        .pipe(Effect.provide(layer)),
    );
    expect(got).toHaveLength(1);
    expect(got[0]!.project).toBe("site-a");
    expect(state.deploymentsCalls).toHaveLength(1);
  });

  it("drops deployments older than createdWithinHours", async () => {
    const { layer } = makeCloudflareFake({
      now: NOW,
      deployments: [
        dep({ project: "p", createdAt: NOW - 48 * 3_600_000 }),
        dep({ project: "p", id: "fresh", createdAt: NOW - 1 * 3_600_000 }),
      ],
    });
    const got = await Effect.runPromise(
      cloudflare
        .deployments({ createdWithinHours: 24 })
        .pipe(Effect.provide(layer)),
    );
    expect(got.map((d) => d.id)).toEqual(["fresh"]);
  });
});
