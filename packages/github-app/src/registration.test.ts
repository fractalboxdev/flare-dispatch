// Unit tests for App registration read + drift diff.
//
// `fetchPublicAppRegistration` GETs the unauthenticated public App view and
// surfaces a non-2xx as a GithubApiError. `diffRegistration` is pure: it
// classifies permission mismatches + missing events as failing and extra live
// events as a (non-failing) warning.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  appSettingsUrl,
  diffRegistration,
  fetchPublicAppRegistration,
  GithubApiError,
  hasFailingDrift,
  type AppRegistration,
  type DesiredRegistration,
} from "./index";

const PUBLIC_APP = {
  name: "FlareDispatch",
  description: "BYOC CI offload running on Cloudflare",
  owner: { login: "fractalbox", type: "Organization" },
  permissions: {
    checks: "write",
    contents: "read",
    deployments: "read",
    metadata: "read",
    pull_requests: "write",
  },
  events: ["check_run", "check_suite", "deployment_status", "pull_request", "pull_request_review"],
};

let requestedSlugs: string[] = [];

const server = setupServer(
  http.get("https://api.github.com/apps/:slug", ({ params }) => {
    requestedSlugs.push(String(params.slug));
    return HttpResponse.json(PUBLIC_APP, { status: 200 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  requestedSlugs = [];
});
afterAll(() => server.close());

describe("fetchPublicAppRegistration", () => {
  it("reads permissions + events from the public App view with no auth", async () => {
    const reg = await fetchPublicAppRegistration("flaredispatch");
    expect(requestedSlugs).toEqual(["flaredispatch"]);
    expect(reg.permissions.pull_requests).toBe("write");
    expect(reg.events).toContain("pull_request_review");
    expect(reg.name).toBe("FlareDispatch");
    expect(reg.ownerLogin).toBe("fractalbox");
    expect(appSettingsUrl(reg, "flaredispatch")).toBe(
      "https://github.com/organizations/fractalbox/settings/apps/flaredispatch",
    );
  });

  it("builds the personal-App settings URL for a user-owned App", () => {
    expect(appSettingsUrl({ ownerLogin: "octocat", ownerType: "User" }, "my-app")).toBe(
      "https://github.com/settings/apps/my-app",
    );
  });

  it("surfaces a non-2xx (unknown slug) as a GithubApiError", async () => {
    server.use(
      http.get("https://api.github.com/apps/:slug", () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    await expect(fetchPublicAppRegistration("nope")).rejects.toBeInstanceOf(GithubApiError);
  });
});

describe("diffRegistration", () => {
  const desired: DesiredRegistration = {
    default_permissions: {
      checks: "write",
      contents: "read",
      deployments: "read",
      metadata: "read",
      pull_requests: "write",
    },
    default_events: ["check_run", "check_suite", "deployment_status", "pull_request"],
  };

  const live: AppRegistration = {
    permissions: { ...desired.default_permissions },
    events: [...desired.default_events, "pull_request_review"],
    name: "FlareDispatch",
    description: "BYOC CI offload running on Cloudflare",
    ownerLogin: "fractalbox",
    ownerType: "Organization",
  };

  it("flags an extra live event as a non-failing warning", () => {
    const drift = diffRegistration(desired, live);
    expect(drift.extraEvents).toEqual(["pull_request_review"]);
    expect(drift.permissionDrift).toEqual([]);
    expect(drift.missingEvents).toEqual([]);
    expect(hasFailingDrift(drift)).toBe(false);
  });

  it("flags a permission level mismatch as failing", () => {
    const drift = diffRegistration(desired, {
      ...live,
      permissions: { ...live.permissions, pull_requests: "read" },
    });
    expect(drift.permissionDrift).toEqual([
      { permission: "pull_requests", desired: "write", live: "read" },
    ]);
    expect(hasFailingDrift(drift)).toBe(true);
  });

  it("flags an over-privilege (live grants a permission the manifest omits) as failing", () => {
    const drift = diffRegistration(desired, {
      ...live,
      permissions: { ...live.permissions, administration: "write" },
    });
    expect(drift.permissionDrift).toEqual([
      { permission: "administration", desired: undefined, live: "write" },
    ]);
    expect(hasFailingDrift(drift)).toBe(true);
  });

  it("flags an event the manifest declares but the App lacks as failing", () => {
    const drift = diffRegistration(desired, {
      ...live,
      events: ["check_run", "check_suite", "deployment_status"],
    });
    expect(drift.missingEvents).toEqual(["pull_request"]);
    expect(hasFailingDrift(drift)).toBe(true);
  });
});
