// Unit coverage for `resolveCloneToken` — the credential a private-repo clone
// rides on, and the reason a Schedule-mode run can now reach one.
//
// Mocks `api.github.com` with MSW (plain Node, same shape as the ChecksGithubLive
// suite) and asserts the three properties the Schedule-mode fix rests on:
//
//   * NO installation id on the auth (a cron tick carries no payload) still
//     produces a token — the installation is resolved for the repo being cloned;
//   * the payload's installation id is used ONLY for the payload repo, so an
//     estate sweep resolves per clone target instead of reusing an id that
//     belongs to a different account;
//   * a repo with no installation FAILS, naming the repo — never a quiet
//     degrade to an unauthenticated clone that 404s as a bare git error.
//
// Spec: specs/04-gha-integration.md § Schedule mode.

import {
  __clearRepoInstallationCache,
  __clearTokenCache,
} from "@fractalboxdev/flare-dispatch-github-app";
import { TEST_APP_PRIVATE_KEY } from "@fractalboxdev/flare-dispatch-github-app/testing";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  resolveAppCredentials,
  resolveCloneToken,
  type SandboxGithubAuth,
} from "./sandbox-clone-auth";

/** Which installation each repo resolves to, and what MSW actually saw. */
type Recorded = {
  /** `owner/name` → installation id, for the repos the App is installed on. */
  installations: Map<string, number>;
  /** Every repo an installation lookup was issued for, in order. */
  lookups: string[];
  /** Every installation id a token was minted for, in order. */
  mints: number[];
};
let recorded: Recorded;

const server = setupServer(
  http.get("https://api.github.com/repos/:owner/:repo/installation", ({ params }) => {
    const slug = `${params.owner}/${params.repo}`;
    recorded.lookups.push(slug);
    const id = recorded.installations.get(slug);
    // GitHub's own shape for "the App is not installed on this repo".
    return id === undefined
      ? HttpResponse.json({ message: "Not Found" }, { status: 404 })
      : HttpResponse.json({ id });
  }),
  http.post("https://api.github.com/app/installations/:id/access_tokens", ({ params }) => {
    recorded.mints.push(Number(params.id));
    return HttpResponse.json({
      token: `ghs_token_for_${params.id}`,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  recorded = {
    installations: new Map([
      ["acme/beacon", 111],
      ["acme/flare-dispatch", 111],
      ["other-org/widget", 222],
    ]),
    lookups: [],
    mints: [],
  };
  // Both caches are module-level and shared across the whole isolate — clear
  // them or a test inherits the previous test's resolution.
  __clearTokenCache();
  __clearRepoInstallationCache();
});

/** Schedule mode: App credentials, no installation, no payload repo. */
const SCHEDULED: SandboxGithubAuth = {
  appId: "42",
  privateKeyPem: TEST_APP_PRIVATE_KEY,
};

/** Webhook mode: the dispatch already resolved an installation for its repo. */
const DISPATCHED: SandboxGithubAuth = {
  ...SCHEDULED,
  payload: { installationId: 111, repo: "acme/flare-dispatch" },
};

describe("resolveCloneToken — Schedule mode (no installation id)", () => {
  it("resolves the installation for the repo being cloned and mints its token", async () => {
    const token = await resolveCloneToken(SCHEDULED, "acme/beacon");

    expect(token).toBe("ghs_token_for_111");
    expect(recorded.lookups).toEqual(["acme/beacon"]);
    expect(recorded.mints).toEqual([111]);
  });

  it("resolves per clone target across an estate sweep", async () => {
    // The shape `spec-drift-pr` / an org-wide audit takes: one execution, many
    // repos, and the repos need not share an installation.
    await resolveCloneToken(SCHEDULED, "acme/beacon");
    await resolveCloneToken(SCHEDULED, "other-org/widget");

    expect(recorded.lookups).toEqual(["acme/beacon", "other-org/widget"]);
    expect(recorded.mints).toEqual([111, 222]);
  });

  it("caches the repo→installation lookup — a re-clone of the same repo costs nothing", async () => {
    await resolveCloneToken(SCHEDULED, "acme/beacon");
    await resolveCloneToken(SCHEDULED, "acme/beacon");

    // One lookup, and one mint (the token cache absorbs the second too).
    expect(recorded.lookups).toEqual(["acme/beacon"]);
    expect(recorded.mints).toEqual([111]);
  });

  it("shares one installation's token across two repos that resolve to it", async () => {
    await resolveCloneToken(SCHEDULED, "acme/beacon");
    await resolveCloneToken(SCHEDULED, "acme/flare-dispatch");

    // Two repos → two lookups, but both land on installation 111, so the
    // token cache serves the second mint.
    expect(recorded.lookups).toEqual(["acme/beacon", "acme/flare-dispatch"]);
    expect(recorded.mints).toEqual([111]);
  });
});

describe("resolveCloneToken — dispatch mode (payload installation id)", () => {
  it("uses the payload's installation for the payload repo, with no lookup", async () => {
    const token = await resolveCloneToken(DISPATCHED, "acme/flare-dispatch");

    expect(token).toBe("ghs_token_for_111");
    expect(recorded.lookups).toEqual([]);
    expect(recorded.mints).toEqual([111]);
  });

  it("matches the payload repo case-insensitively", async () => {
    // GitHub preserves the case an owner typed but routes case-insensitively;
    // a run input spelled differently from the payload is the same repo.
    await resolveCloneToken(DISPATCHED, "Acme/Flare-Dispatch");

    expect(recorded.lookups).toEqual([]);
    expect(recorded.mints).toEqual([111]);
  });

  it("resolves its own installation for a repo the payload did not name", async () => {
    // The correctness point: an installation covers ONE account, so reusing the
    // payload's id for another account's repo would mint a token with no access.
    const token = await resolveCloneToken(DISPATCHED, "other-org/widget");

    expect(token).toBe("ghs_token_for_222");
    expect(recorded.lookups).toEqual(["other-org/widget"]);
    expect(recorded.mints).toEqual([222]);
  });

  it("ignores a non-positive payload installation id and resolves instead", async () => {
    // A stray 0 reaches the runtime from the schedule path / a direct Workflow
    // instantiation; minting against it would 404 inside GitHub.
    const repo = (DISPATCHED.payload as { repo: string }).repo;
    await resolveCloneToken({ ...DISPATCHED, payload: { installationId: 0, repo } }, repo);

    expect(recorded.lookups).toEqual(["acme/flare-dispatch"]);
    expect(recorded.mints).toEqual([111]);
  });

  it("keys the repo→installation cache case-insensitively", async () => {
    // The cache lives in `resolveRepoInstallationId`. Keyed on the raw slug,
    // `Acme/Beacon` and `acme/beacon` would be two entries and two round trips
    // for one repo — and could disagree about which installation covers it.
    await resolveCloneToken(SCHEDULED, "acme/beacon");
    await resolveCloneToken(SCHEDULED, "Acme/Beacon");

    expect(recorded.lookups).toEqual(["acme/beacon"]);
  });
});

describe("resolveCloneToken — honest failure", () => {
  it("names the repo when no installation covers it, and mints nothing", async () => {
    await expect(resolveCloneToken(SCHEDULED, "acme/not-installed")).rejects.toThrow(
      "no GitHub App installation for acme/not-installed",
    );
    // The point of the fix: it fails HERE, loudly, rather than returning
    // nothing and letting the clone go out unauthenticated.
    expect(recorded.mints).toEqual([]);
  });

  it("distinguishes a lookup failure from a missing installation", async () => {
    server.use(
      http.get("https://api.github.com/repos/:owner/:repo/installation", () =>
        HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
      ),
    );

    await expect(resolveCloneToken(SCHEDULED, "acme/beacon")).rejects.toThrow(
      "GitHub App installation lookup failed for acme/beacon",
    );
  });
});

// The assembly `makeCFRuntimeLive` performs. This is where the Schedule-mode bug
// lived — the clone was handed the check-run config, which requires an
// installation id a cron tick never has — and it was untestable through the
// Layer, so it is pure and asserted directly.
describe("resolveAppCredentials", () => {
  const APP = { appId: "42", privateKeyPem: TEST_APP_PRIVATE_KEY };

  it("Schedule mode — App secrets, no dispatch installation, clone still credentialed", () => {
    // The regression guard: the clone must get credentials even though there is
    // no `checks` config at all. Reverting to `cloneAuth = opts.checks` makes
    // this `undefined` — an unauthenticated clone, i.e. the original bug.
    const { app, clone } = resolveAppCredentials({
      githubApp: APP,
      payloadRepo: "acme/flare-dispatch",
    });

    expect(app).toEqual(APP);
    expect(clone).toEqual(APP);
    expect(clone?.payload).toBeUndefined();
  });

  it("dispatch mode — the payload installation is tagged with the repo it covers", () => {
    const { app, clone } = resolveAppCredentials({
      githubApp: APP,
      checks: { ...APP, installationId: 111 },
      payloadRepo: "acme/flare-dispatch",
    });

    expect(app).toEqual(APP);
    // Tagged, never bare: an installation covers one account, so an estate
    // sweep must not reuse it for a repo the dispatch never named.
    expect(clone?.payload).toEqual({ installationId: 111, repo: "acme/flare-dispatch" });
  });

  it("falls back to the check-run config's credentials when `githubApp` is absent", () => {
    const { app, clone } = resolveAppCredentials({
      checks: { ...APP, installationId: 111 },
      payloadRepo: "acme/flare-dispatch",
    });

    expect(app).toEqual(APP);
    expect(clone?.payload).toEqual({ installationId: 111, repo: "acme/flare-dispatch" });
  });

  it("no App secrets at all → both undefined (public repos, unauthenticated)", () => {
    expect(resolveAppCredentials({ payloadRepo: "acme/flare-dispatch" })).toEqual({
      app: undefined,
      clone: undefined,
    });
  });
});
