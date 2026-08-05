// @fractalboxdev/flare-dispatch-core — the `artifact` capability (R2 artifact upload).
//
// Uploads a file or directory to R2 and returns a signed URL embedded in the
// check-run summary. Directories tar to .tar.zst. The `r2-artifacts` building
// block of specs/02-runs.md.
//
// Spec: specs/03-dsl.md § artifact.

import { Context, type Duration, Effect } from "effect";
import type { ArtifactUploadFailed } from "../errors";
import type { Container } from "./sandbox";

export type ArtifactInfo = {
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly url: string;
};

export interface ArtifactService {
  readonly upload: (opts: {
    name: string;
    path: string;
    contentType?: string;
    signedUrlTTL?: Duration.Duration | string;
    container?: Container;
  }) => Effect.Effect<string, ArtifactUploadFailed>;
  readonly list: (opts: { executionId: string }) => Effect.Effect<readonly ArtifactInfo[]>;
}

export class Artifact extends Context.Tag("@fractalboxdev/flare-dispatch-core/Artifact")<
  Artifact,
  ArtifactService
>() {}

export const artifact = {
  upload: (opts: {
    name: string;
    path: string;
    contentType?: string;
    signedUrlTTL?: Duration.Duration | string;
    container?: Container;
  }) => Effect.flatMap(Artifact, (a) => a.upload(opts)),
  list: (opts: { executionId: string }) => Effect.flatMap(Artifact, (a) => a.list(opts)),
} as const;
