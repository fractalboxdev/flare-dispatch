// Tests for the live `notice` capability Layer.
//
// Two things are worth asserting about a Layer this thin, and they are the two
// that would be silent failures in production:
//
//   * THE DELIVERY ID IS A FUNCTION OF ITS INPUTS. The receiver dedups on it
//     and a Workflow step can be retried, so an id that moved between attempts
//     would double-post the digest on the day the retry happens — and only on
//     that day, which is the worst way to find out.
//   * NOTHING HERE CAN FAIL A RUN. Every branch, defects included, has to come
//     back as a `NoticeResult`. An announcement that did not land must never
//     retroactively turn work the run actually did into a failure.

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Notice, type NoticeRequest } from "@fractalboxdev/flare-dispatch-core";
import {
  makeNoticeCloudflareLive,
  type NoticeEmission,
  type NoticeEmissionResult,
  noticeDeliveryId,
} from "./notice-cf";

const run = <A>(eff: Effect.Effect<A, never, Notice>, layer: Layer.Layer<Notice>) =>
  Effect.runPromise(eff.pipe(Effect.provide(layer)));

const publish = (req: NoticeRequest) => Effect.flatMap(Notice, (s) => s.publish(req));

const request = (over: Partial<NoticeRequest> = {}): NoticeRequest => ({
  useCase: "org-spec-audit",
  text: "Spec audit — 3 open questions",
  dedupeKey: "2026-08-08",
  ...over,
});

/** A fake emit path: records what it was handed, answers what it was told to. */
const fakeDeliver = (result: NoticeEmissionResult = { outcome: "posted" }) => {
  const seen: NoticeEmission[] = [];
  return {
    seen,
    deliver: (emission: NoticeEmission) => {
      seen.push(emission);
      return Promise.resolve(result);
    },
  };
};

const live = (deliver: (e: NoticeEmission) => Promise<NoticeEmissionResult>) =>
  makeNoticeCloudflareLive({
    run: "org-spec-audit",
    executionId: "01JZ9F3ATBQ2W7X8Y0KDPM4RVH",
    deliver,
  });

describe("noticeDeliveryId", () => {
  it("is a pure function of (run, useCase, dedupeKey) — no clock, no randomness", () => {
    expect(noticeDeliveryId("org-spec-audit", "spec-digest", "2026-08-08")).toBe(
      "org-spec-audit:spec-digest:2026-08-08",
    );
    expect(noticeDeliveryId("org-spec-audit", "spec-digest", "2026-08-08")).toBe(
      noticeDeliveryId("org-spec-audit", "spec-digest", "2026-08-08"),
    );
    expect(noticeDeliveryId("org-spec-audit", "spec-digest", "2026-08-09")).not.toBe(
      noticeDeliveryId("org-spec-audit", "spec-digest", "2026-08-08"),
    );
    // The run name is in the id so two runs announcing on the same day under
    // the same use case cannot silently claim each other's delivery.
    expect(noticeDeliveryId("release-notes", "spec-digest", "2026-08-08")).not.toBe(
      noticeDeliveryId("org-spec-audit", "spec-digest", "2026-08-08"),
    );
  });

  it("keeps ONE run's two use cases apart on the same tick", () => {
    // `dedupeKey` is documented as the run's day string, so a run publishing a
    // digest and an alert on one tick supplies the SAME key twice. Without the
    // use case in the id the second post is answered 409 and read as already
    // delivered — a dropped message reported as fine, with nothing wrong.
    expect(noticeDeliveryId("org-spec-audit", "spec-digest", "2026-08-08")).not.toBe(
      noticeDeliveryId("org-spec-audit", "spec-alert", "2026-08-08"),
    );
  });

  it("coerces into the receiver's charset rather than refusing", () => {
    // A silence nobody notices is this capability's worst failure mode, so a
    // dedupe key that grew a slash is repaired, not rejected.
    expect(noticeDeliveryId("org-spec-audit", "spec-digest", "2026/08/08 12:00")).toMatch(
      /^org-spec-audit:spec-digest:2026-08-08-12:00-[0-9a-f]{8}$/,
    );
    expect(noticeDeliveryId("_odd", "uc", "x")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    expect(noticeDeliveryId("r", "uc", "y".repeat(400)).length).toBe(128);
  });

  it("does not let coercion or truncation merge two distinct notices", () => {
    // Both repairs are many-to-one, and a collision here is the same silence
    // arriving by another road — so a lossy id carries a hash of the original.
    expect(noticeDeliveryId("r", "uc", "2026/08/08")).not.toBe(
      noticeDeliveryId("r", "uc", "2026-08-08"),
    );
    expect(noticeDeliveryId("r", "uc", `${"y".repeat(200)}a`)).not.toBe(
      noticeDeliveryId("r", "uc", `${"y".repeat(200)}b`),
    );
    // Still deterministic — a replayed Workflow step must rebuild it exactly.
    expect(noticeDeliveryId("r", "uc", "2026/08/08")).toBe(
      noticeDeliveryId("r", "uc", "2026/08/08"),
    );
    // And still inside the receiver's charset after the tag is appended.
    expect(noticeDeliveryId("r", "uc", "2026/08/08")).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
    );
    expect(noticeDeliveryId("r", "uc", "y".repeat(400))).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
    );
  });
});

describe("makeNoticeCloudflareLive", () => {
  it("hands the emit path a message and a derived id, and nothing else", async () => {
    const { seen, deliver } = fakeDeliver();

    const result = await run(
      publish(request({ links: [{ url: "https://gh.test/pr/9", label: "the questions PR" }] })),
      live(deliver),
    );

    expect(result).toEqual({ delivered: true, duplicate: false, skipped: false });
    expect(seen[0]).toEqual({
      useCase: "org-spec-audit",
      // `<run>:<useCase>:<dedupeKey>` — this run's name and its use case happen
      // to be the same word, which is why both halves read alike here.
      deliveryId: "org-spec-audit:org-spec-audit:2026-08-08",
      text: "Spec audit — 3 open questions",
      links: [{ url: "https://gh.test/pr/9", label: "the questions PR" }],
      run: "org-spec-audit",
      executionId: "01JZ9F3ATBQ2W7X8Y0KDPM4RVH",
    });
  });

  it("mints the same id for a repeated publish — the retry case, exactly", async () => {
    const { seen, deliver } = fakeDeliver();
    const layer = live(deliver);

    await run(publish(request()), layer);
    await run(publish(request()), layer);

    expect(seen.map((e) => e.deliveryId)).toEqual([
      "org-spec-audit:org-spec-audit:2026-08-08",
      "org-spec-audit:org-spec-audit:2026-08-08",
    ]);
  });

  it("reads `duplicate` as the message already being out there", async () => {
    const { deliver } = fakeDeliver({ outcome: "duplicate" });

    expect(await run(publish(request()), live(deliver))).toEqual({
      delivered: false,
      duplicate: true,
      skipped: false,
    });
  });

  it("reports a failure as data — a run's verdict is not a notice's to move", async () => {
    const { deliver } = fakeDeliver({ outcome: "failed", reason: "ingress answered 502" });

    expect(await run(publish(request()), live(deliver))).toEqual({
      delivered: false,
      duplicate: false,
      skipped: false,
      reason: "ingress answered 502",
    });
  });

  it("survives a defect from the emit path rather than propagating it", async () => {
    // The closure is contracted never to throw. If it does anyway, that is a
    // notify bug turning a green run red at the very last step — the same guard
    // the completion-notify email carries.
    const layer = live(() => Promise.reject(new Error("boom")));

    expect(await run(publish(request()), layer)).toMatchObject({
      delivered: false,
      skipped: false,
      reason: "boom",
    });
  });

  it("survives a SYNCHRONOUS throw from the emit path too", async () => {
    // A different path from a rejected promise: this one throws before any
    // promise exists, so `Effect.promise`'s own thunk is what raises.
    const layer = live(() => {
      throw new Error("sync boom");
    });

    expect(await run(publish(request()), layer)).toMatchObject({
      delivered: false,
      skipped: false,
      reason: "sync boom",
    });
  });

  it("degrades to a logged no-op when the deploy has no notice backend", async () => {
    const result = await run(publish(request()), makeNoticeCloudflareLive(undefined));

    expect(result.skipped).toBe(true);
    expect(result.delivered).toBe(false);
  });
});
