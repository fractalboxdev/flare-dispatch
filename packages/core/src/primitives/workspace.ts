// Primitive: workspace — acquire a container and clone a repo into it
//
// The opening move of nearly every recipe: get a container, clone the repo at
// the target SHA, and (optionally) run a cached dependency install. Returns
// the container handle and the checkout directory together, so the rest of
// the run threads one value instead of two.
//
// `spec` rides the checkpoint so `execInWorkspace` can redo the clone when the
// container lost it. specs/adr/0001-cloudflare-workflows-scope.md rule 3.
//
// Rides on the `sandbox` capability and the `installCached` primitive.
// Layer: 03-dsl § Primitives.

import { Effect } from "effect";
import { sandbox, type Container } from "../services/sandbox";
import { installCached } from "./install-cached";

/** Everything needed to rebuild the checkout. JSON, so it survives a checkpoint. */
export type WorkspaceSpec = {
  readonly repo: string;
  readonly sha: string;
  readonly image?: string;
  readonly install?: boolean;
};

export type Workspace = {
  container: Container;
  dir: string;
  spec: WorkspaceSpec;
};

/** Clone into an acquired container, optionally installing dependencies. */
export const hydrateWorkspace = (container: Container, spec: WorkspaceSpec) =>
  Effect.gen(function* () {
    const dir = yield* sandbox.git.clone({
      repo: spec.repo,
      sha: spec.sha,
      container,
    });
    if (spec.install) {
      yield* installCached({ container, dir });
    }
    return dir;
  });

export const workspace = (opts: {
  repo: string;
  sha: string;
  image?: string; // container image override
  install?: boolean; // run installCached after the clone
}) =>
  Effect.gen(function* () {
    const container = yield* sandbox.acquire({ image: opts.image });
    const spec: WorkspaceSpec = {
      repo: opts.repo,
      sha: opts.sha,
      image: opts.image,
      install: opts.install,
    };
    const dir = yield* hydrateWorkspace(container, spec);
    return { container, dir, spec };
  });
