// The reproduction submitter over intake's admission with the phase-4 profile, whose `reproduction` constraint removes
// `cloudflare`, `aws` and `gha` and requires the `attested-dedicated` posture tier.
import {
  reproductionRequestFor,
  ReproductionSubmitter,
  type ReleaseExecution,
} from "@fractalboxdev/flare-dispatch-cache/reproduction-request";
import { buildProfile, eligibleKinds } from "@fractalboxdev/flare-dispatch-profile";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { harness, HEAD, REPO, type Harness } from "./harness.test-support.ts";
import { reproductionSubmitterLayer } from "./reproduction.ts";
import { IntakeStore, type IntakeRecord } from "./store.ts";
import { OTHER_CACHE_TRIGGER } from "./event.ts";

const RELEASE_ID = "01RELEASEEXECUTION000000000";
const sha = (c: string) => `sha256:${c.repeat(64)}`;

const releaseRecord: IntakeRecord = {
  executionId: RELEASE_ID,
  trigger: "webhook",
  run: "check",
  label: "ci",
  repo: REPO,
  sha: HEAD,
  ref: "refs/tags/v1.2.3",
  inputs: { sha: HEAD },
  className: "release",
  labels: [],
  attempt: 1,
  familyRoot: RELEASE_ID,
  installation: 7,
  caller: null,
  notBefore: null,
  spendLine: null,
  placementConstraint: null,
  cacheTrigger: { _tag: "Push", ref: "refs/tags/v1.2.3", protected: true },
  eligibleKinds: ["cloudflare"],
  repositoryPublic: false,
  inputAssociations: [],
  createdAt: 1,
};

const release: ReleaseExecution = {
  executionId: RELEASE_ID,
  repository: REPO,
  ref: "refs/tags/v1.2.3",
  run: "check",
  commit: HEAD,
  definitionDigest: sha("c"),
  imageDigest: sha("f"),
  inputs: { sha: HEAD },
};

const submitReproduction = (h: Harness, over: Partial<ReleaseExecution> = {}) =>
  h.run(
    ReproductionSubmitter.use((s) => s.submit(reproductionRequestFor({ reproduce: true }, { ...release, ...over })!)).pipe(
      Effect.provide(reproductionSubmitterLayer),
    ),
  );

describe("the reproduction submitter", () => {
  it("[FD-PROV-064] a release rule with reproduce: true creates one interactive reproduction execution of the release's run, commit and inputs under the reproduction constraint, off cloudflare, aws and gha", async () => {
    const profile = buildProfile("production", 4);
    const h = await harness({ settings: { profile } });
    await h.run(IntakeStore.use((s) => s.put(releaseRecord)));

    const first = await submitReproduction(h);
    expect(first).toMatchObject({ _tag: "admitted" });
    const id = (first as { executionId: string }).executionId;
    // A repeated submit answers the same execution: one reproduction per release.
    expect(await submitReproduction(h)).toEqual(first);

    const [record] = h.rows("select * from intake_records where execution_id = ?", id);
    expect(record).toMatchObject({
      run: "check",
      repo: REPO,
      sha: HEAD,
      ref: "refs/tags/v1.2.3",
      class: "interactive",
      placement_constraint: "reproduction",
    });
    expect(JSON.parse(record!["inputs_json"] as string)).toEqual({ sha: HEAD });
    expect(JSON.parse(record!["labels_json"] as string)).toContain("reproduction");
    // The release's cache trigger is not carried: a reproduction reads no protected tier as a tag push would.
    expect(JSON.parse(record!["cache_trigger_json"] as string)).toEqual(OTHER_CACHE_TRIGGER);
    expect(h.rows("select canonical from dedup_keys where canonical like ?", `${RELEASE_ID}/%`)).toEqual([
      { canonical: `${RELEASE_ID}/reproduction` },
    ]);

    // Admission placed it on devices alone, and the profile's constraint asks the attested-dedicated tier of them.
    const [placement] = h.rows("select eligible_kinds from placements where execution_id = ?", id);
    const kinds = JSON.parse(placement!["eligible_kinds"] as string) as string[];
    expect(kinds).toEqual(["device"]);
    expect(
      eligibleKinds(profile, {
        class: "interactive",
        labels: JSON.parse(record!["labels_json"] as string) as string[],
      }),
    ).toMatchObject({ kinds: ["device"], constraints: expect.arrayContaining(["reproduction"]), requiresPosture: "attested-dedicated" });

    // A release rule without reproduce creates nothing.
    expect(reproductionRequestFor({}, release)).toBeNull();
    expect(reproductionRequestFor({ reproduce: false }, release)).toBeNull();
    // A request that names another commit than the release's is refused, and admits nothing.
    expect(await submitReproduction(h, { commit: "c".repeat(40) })).toMatchObject({ _tag: "refused" });
    expect(h.rows("select count(*) as n from intake_records where placement_constraint = 'reproduction'")).toEqual([
      { n: 1 },
    ]);
  });
});
