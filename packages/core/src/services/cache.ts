// @fractalboxdev/flare-dispatch-core — the `cache` capability (R2-backed restore/save).
//
// `restoreOr` is the canonical pattern: try to restore a content-addressed
// key; on a miss run `onMiss` (which populates the paths), then save.
// Idempotent across step replay. The `installCached` primitive wraps it.
//
// `restoreOr` resolves to `void`, not the `onMiss` value: on a cache HIT
// `onMiss` never runs, so there is genuinely no `A` to hand back. The work
// `restoreOr` does — files restored into the container, or `onMiss` populating
// them — is a side effect; callers do not consume a return value.
//
// Spec: specs/03-dsl.md § cache.

import { Context, Effect } from "effect";
import type { CacheError } from "../errors";
import type { Container } from "./sandbox";

export interface CacheService {
  readonly restoreOr: <A, E, R>(opts: {
    key: string;
    paths: readonly string[];
    container: Container;
    /**
     * Directory the `paths` are relative to — the checkout dir. Cached
     * archives are packed/extracted with this as the working directory, so
     * `paths` stay portable (`node_modules`, not `/workspace/repo/node_modules`).
     * Optional: omit to treat `paths` as relative to the container's default cwd.
     */
    dir?: string;
    onMiss: () => Effect.Effect<A, E, R>;
  }) => Effect.Effect<void, E | CacheError, R>;
  readonly save: (opts: {
    key: string;
    paths: readonly string[];
    container: Container;
    /** Directory the `paths` are relative to — see `restoreOr`. */
    dir?: string;
  }) => Effect.Effect<void, CacheError>;
}

export class Cache extends Context.Tag("@fractalboxdev/flare-dispatch-core/Cache")<
  Cache,
  CacheService
>() {}

export const cache = {
  restoreOr: <A, E, R>(opts: {
    key: string;
    paths: readonly string[];
    container: Container;
    dir?: string;
    onMiss: () => Effect.Effect<A, E, R>;
  }) => Effect.flatMap(Cache, (c) => c.restoreOr(opts)),
  save: (opts: {
    key: string;
    paths: readonly string[];
    container: Container;
    dir?: string;
  }) => Effect.flatMap(Cache, (c) => c.save(opts)),
} as const;
