// The executor values an agentic or scan lease carries in its input, from which the Container pool's runner builds the
// run's per-lease Layers (specs/runs/agentic.md § Model, specs/runs/gate.md § Security gate).
import { AgentLease, PrReviewInput } from "@fractalboxdev/flare-dispatch-agentic";
import {
  lookupRun,
  SecurityRescanInput,
  type CatalogEntry,
} from "@fractalboxdev/flare-dispatch-catalog";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { ADVISORY_SNAPSHOTS_MIGRATION, recordSnapshot } from "@fractalboxdev/flare-dispatch-ops";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  agentLeaseOf,
  leaseCloudValues,
  withCloudLease,
  type CloudLeaseEnv,
  type PresignRead,
} from "../src/cloud-lease.ts";

const ORIGIN = "https://ci.example.com";
const NOW = Date.UTC(2026, 10, 15, 12);
const DEADLINE = NOW + 30 * 60_000;
const PIN = "b".repeat(64);
const NPM = "c".repeat(64);

const entry = (run: string): CatalogEntry => {
  const found = lookupRun("production", run);
  if (found._tag !== "Available") throw new Error(run);
  return found.entry;
};

/** A presigner that signs every read on the bucket's endpoint, recording each key and expiry. */
const presigner = () => {
  const signed: { readonly key: string; readonly expiresAt: number }[] = [];
  const presign: PresignRead = async (key, expiresAt) => {
    signed.push({ key, expiresAt });
    return { url: `https://acct.r2.cloudflarestorage.com/cache/${key}?X-Amz-Signature=s` };
  };
  return { signed, presign };
};

const scanEnv = async (extra: Partial<CloudLeaseEnv> = {}): Promise<CloudLeaseEnv> => {
  const db = await migratedD1();
  await db.prepare(ADVISORY_SNAPSHOTS_MIGRATION).run();
  await recordSnapshot(
    db,
    "npm",
    { digest: NPM, lastModified: NOW - 3_600_000, size: 10 },
    NOW - 60_000,
  );
  return {
    DB: db,
    SCAN_BUNDLE_DIGEST: PIN,
    ADVISORY_ECOSYSTEMS: '["npm","PyPI"]',
    ADVISORY_MAX_AGE_HOURS: "24",
    ...extra,
  };
};

const prReview = {
  repo: { owner: "acme", name: "app" },
  number: 7,
  baseSha: "a".repeat(40),
  headSha: "d".repeat(40),
  draft: false,
  labels: [],
  authorLogin: "dev",
  authorAssociation: "MEMBER",
  forkHead: false,
  maxDiffChars: 100_000,
};
const rescan = {
  repo: "https://github.com/acme/app.git",
  sha: "e".repeat(40),
  ref: "refs/heads/main",
  scope: "acme/app",
};

describe("an agentic lease's executor values", () => {
  it("[FD-AGT-010] carry the dispatcher's model route and origin, which the run's input keeps, and replace any value the request recorded", async () => {
    const values = await leaseCloudValues(
      { PUBLIC_ORIGIN: `${ORIGIN}/`, DB: await migratedD1() },
      entry("pr-review"),
      { deadlineAt: DEADLINE, now: NOW },
      presigner().presign,
    );
    expect(values).toEqual({
      modelGatewayUrl: `${ORIGIN}/v1/model/completions`,
      controlPlaneUrl: ORIGIN,
    });
    const forged = {
      ...prReview,
      cloudLease: { modelGatewayUrl: "https://evil.example/v1/model/x", controlPlaneUrl: "x" },
    };
    const inputs = withCloudLease(entry("pr-review"), forged, values);
    expect(inputs).toEqual({ ...prReview, cloudLease: values });
    // The run's input schema keeps the values, so the run's per-lease Layers read them.
    expect(Schema.decodeUnknownSync(PrReviewInput)(inputs).cloudLease).toEqual(values);
    expect(Schema.decodeUnknownSync(AgentLease)(values)).toEqual(values);
  });

  it("[FD-AGT-010] are absent on a deploy without a public origin, which drops the recorded value too, so the run fails closed", () => {
    for (const origin of [undefined, "", "  "]) {
      const none = agentLeaseOf({ PUBLIC_ORIGIN: origin });
      expect(none).toBeNull();
      expect(
        withCloudLease(entry("triage-issues"), { repo: prReview.repo, cloudLease: {} }, none),
      ).toEqual({ repo: prReview.repo });
    }
  });
});

describe("a scan lease's executor values", () => {
  it("[FD-GATE-100] [FD-GATE-110] carry the pinned bundle and each recorded advisory snapshot as presigned reads that never outlive the lease, and replace any value the request recorded", async () => {
    const { signed, presign } = presigner();
    const values = await leaseCloudValues(
      await scanEnv(),
      entry("security-rescan"),
      { deadlineAt: DEADLINE, now: NOW },
      presign,
    );
    expect(values).toEqual({
      bundleDigest: PIN,
      bundleUrl: `https://acct.r2.cloudflarestorage.com/cache/cas/${PIN}?X-Amz-Signature=s`,
      advisoryMaxAgeHours: 24,
      advisories: [
        {
          ecosystem: "npm",
          digest: NPM,
          lastModified: NOW - 3_600_000,
          url: `https://acct.r2.cloudflarestorage.com/cache/cas/${NPM}?X-Amz-Signature=s`,
        },
      ],
    });
    // The presigner's URL lifetime, 15 minutes, never past the deadline.
    expect(signed.map((s) => s.expiresAt)).toEqual([NOW + 15 * 60_000, NOW + 15 * 60_000]);
    const short = presigner();
    await leaseCloudValues(
      await scanEnv(),
      entry("security-gate"),
      { deadlineAt: NOW + 60_000, now: NOW },
      short.presign,
    );
    expect(short.signed.every((s) => s.expiresAt === NOW + 60_000)).toBe(true);

    const forged = {
      ...rescan,
      cloudLease: { bundleDigest: "f".repeat(64), advisoryMaxAgeHours: 100_000, advisories: [] },
    };
    const inputs = withCloudLease(entry("security-rescan"), forged, values);
    expect(inputs).toEqual({ ...rescan, cloudLease: values });
    expect(Schema.decodeUnknownSync(SecurityRescanInput)(inputs).cloudLease).toEqual(values);
  });

  it("[FD-GATE-101] [FD-GATE-102] carry no bundle digest where the overlay pins none, no reads where the deploy signs none, and none at all for a malformed max age", async () => {
    const unpinned = await leaseCloudValues(
      await scanEnv({ SCAN_BUNDLE_DIGEST: "" }),
      entry("security-gate"),
      { deadlineAt: DEADLINE, now: NOW },
      presigner().presign,
    );
    expect(unpinned).toMatchObject({ advisoryMaxAgeHours: 24 });
    expect(unpinned).not.toHaveProperty("bundleDigest");
    expect(unpinned).not.toHaveProperty("bundleUrl");
    const unsigned = await leaseCloudValues(
      await scanEnv(),
      entry("security-gate"),
      { deadlineAt: DEADLINE, now: NOW },
      async () => null,
    );
    expect(unsigned).toEqual({ bundleDigest: PIN, advisoryMaxAgeHours: 24, advisories: [] });
    const malformed = await leaseCloudValues(
      await scanEnv({ ADVISORY_MAX_AGE_HOURS: "0.5" }),
      entry("security-gate"),
      { deadlineAt: DEADLINE, now: NOW },
      presigner().presign,
    );
    expect(malformed).toBeNull();
    expect(
      withCloudLease(entry("security-gate"), { ...rescan, cloudLease: {} }, malformed),
    ).toEqual(rescan);
  });

  it("are none for a run that is neither agentic nor a scan, whose input stays as recorded", async () => {
    const env = await scanEnv({ PUBLIC_ORIGIN: ORIGIN });
    for (const run of ["worker-deploy", "sandbox-image", "deploy-smoke"]) {
      expect(
        await leaseCloudValues(
          env,
          entry(run),
          { deadlineAt: DEADLINE, now: NOW },
          presigner().presign,
        ),
        run,
      ).toBeNull();
      const recorded = { cloudLease: "kept" };
      expect(withCloudLease(entry(run), recorded, null)).toBe(recorded);
    }
  });
});
