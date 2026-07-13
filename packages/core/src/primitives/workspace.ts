// Primitive: workspace — acquire a container and clone a repo into it
//
// The opening move of nearly every recipe: get a container, clone the repo at
// the target SHA, and (optionally) run a cached dependency install. Returns
// the container handle and the checkout directory together, so the rest of
// the run threads one value instead of two.
//
// Rides on the `sandbox` capability and the `installCached` primitive.
// Layer: 03-dsl § Primitives.

import { Effect } from "effect";
import { sandbox, type Container } from "../services/sandbox";
import { installCached } from "./install-cached";

export type Workspace = {
  container: Container;
  dir: string;
};

export const workspace = (opts: {
  repo: string;
  sha: string;
  image?: string; // container image override
  install?: boolean; // run installCached after the clone
}) =>
  Effect.gen(function* () {
    const container = yield* sandbox.acquire({ image: opts.image });
    const dir = yield* sandbox.git.clone({
      repo: opts.repo,
      sha: opts.sha,
      container,
    });
    if (opts.install) {
      yield* installCached({ container, dir });
    }
    return { container, dir };
  });
