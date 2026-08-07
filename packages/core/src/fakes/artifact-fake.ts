// @fractalboxdev/flare-dispatch-core — Artifact fake.
//
// In-memory name → fake-signed-URL map. `upload` records the call and returns
// a deterministic `https://fake-r2.local/<name>` URL; `list` returns what was
// uploaded.
//
// Spec: specs/pm/plan.md § 3 (fakes/), specs/03-dsl.md § artifact.

import { Effect, Layer } from "effect";
import { Artifact, type ArtifactInfo, type ArtifactService } from "../services/artifact";

/** Inspectable in-memory artifact store. */
export type ArtifactFakeState = {
  /** uploaded artifact name → its fake signed URL. */
  readonly urls: Map<string, string>;
  /** every `upload` call, in order — `contentType` lets tests assert the
   * served type (a video artifact must say `video/webm` to stream);
   * `container` (the handle's id, absent for R2-source-key mode) lets tests
   * pin WHICH upload mode a run used — container mode throws on the facade
   * backend, so a run that must work on both backends asserts its absence. */
  readonly uploads: { name: string; path: string; contentType?: string; container?: string }[];
};

/** Build an Artifact fake plus an inspectable handle. */
export const makeArtifactFake = (): {
  layer: Layer.Layer<Artifact>;
  state: ArtifactFakeState;
} => {
  const state: ArtifactFakeState = { urls: new Map(), uploads: [] };

  const service: ArtifactService = {
    upload: ({ name, path, contentType, container }) =>
      Effect.sync(() => {
        state.uploads.push({
          name,
          path,
          ...(contentType !== undefined ? { contentType } : {}),
          ...(container !== undefined ? { container: container.id } : {}),
        });
        const url = `https://fake-r2.local/${encodeURIComponent(name)}`;
        state.urls.set(name, url);
        return url;
      }),

    list: () =>
      Effect.sync(() =>
        Array.from(state.urls.entries()).map(([name, url]): ArtifactInfo => ({
          name,
          url,
          size: 0,
          contentType: "application/octet-stream",
        })),
      ),
  };

  return { layer: Layer.succeed(Artifact, service), state };
};

/** A ready-to-use Artifact fake Layer. */
export const ArtifactFake: Layer.Layer<Artifact> = makeArtifactFake().layer;
