// The one `EffectApplier` the control plane runs: it selects a handler by
// `row.kind`, the check-run kinds to the check-run applier and every other
// declared kind to the side-output applier (specs/github-output.md § Scope).
import { EffectApplier, type IntentRow } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { makeCheckRunApplier, Payloads } from "./applier.ts";
import { isSideKind, makeSideOutputApplier } from "./side-applier.ts";

const isCheckKind = (kind: string) => Object.hasOwn(Payloads, kind);

export const GithubApplierLive = Layer.effect(
  EffectApplier,
  Effect.gen(function* () {
    const checks = yield* makeCheckRunApplier;
    const sides = yield* makeSideOutputApplier;
    const pick = (row: IntentRow) =>
      isCheckKind(row.kind) ? checks : isSideKind(row.kind) ? sides : null;
    const unserved = (row: IntentRow) => `applier: no handler for kind ${row.kind}`;
    return {
      apply: (row) =>
        pick(row)?.apply(row) ?? Effect.succeed({ _tag: "refused", reason: unserved(row) }),
      lookup: (row) =>
        pick(row)?.lookup(row) ?? Effect.succeed({ _tag: "undetermined", reason: unserved(row) }),
      reconcile: (row) =>
        pick(row)?.reconcile(row) ??
        Effect.succeed({ _tag: "undetermined", reason: unserved(row) }),
    };
  }),
);
