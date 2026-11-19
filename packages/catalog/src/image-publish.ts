// The `image-publish` run (FD-GATE-116 to FD-GATE-132): stage the release assets the build reads, run the build in the
// entry's CodeBuild project under a role the control plane assumes, read the image digests it exported, and start each
// stack's `stack-deploy` on success. This module imports no process or file API.
import { Intents } from "@fractalboxdev/mameko-run";
import { Effect, Option, Schema } from "effect";
import { ReleaseAssets, type AwsTarget } from "./aws.ts";
import { awsFailure, buildSummaryText, runBuild, type BuildEnd } from "./aws-build.ts";
import { ExecutionLease } from "./execution-lease.ts";
import { ImageDigests, type ImagePublishInput } from "./inputs.ts";
import type { ImagePublishEntry, StackDeployEntry } from "./manifest.ts";
import { Outcome, isSuccess } from "./reasons.ts";

/** The exported variable that carries the image digests (FD-GATE-131). */
export const IMAGE_DIGESTS_VARIABLE = "FD_IMAGE_DIGESTS";

const REGION = /^[a-z]{2}(-gov|-iso[a-z]*)?-[a-z]+-[0-9]$/;
const ROLE_ARN = /^arn:aws[a-z-]*:iam::[0-9]{12}:role\/[\w+=,.@/-]{1,512}$/;
const ASSET_KEY = /^[A-Z0-9_]{1,32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The first invalid AWS field of an entry as its `config: <field>` reason (FD-GATE-127), or `undefined`. */
export const awsConfigProblem = (
  entry: Pick<ImagePublishEntry | StackDeployEntry, "region" | "roleArn" | "project">,
): Outcome | undefined => {
  if (!REGION.test(entry.region)) return Outcome.failure("config: region");
  if (!ROLE_ARN.test(entry.roleArn)) return Outcome.failure("config: roleArn");
  if (entry.project.trim() === "") return Outcome.failure("config: project");
  return undefined;
};

/** The overrides every build receives (FD-GATE-120); none carries a credential. */
export const buildEnv = (
  input: { readonly scope: string; readonly sha: string; readonly ref: string },
  executionId: string,
): Record<string, string> => ({
  FD_REPO: input.scope,
  FD_SHA: input.sha,
  FD_REF: input.ref,
  FD_EXECUTION_ID: executionId,
});

/**
 * The image digests a build exported (FD-GATE-131): a non-empty JSON object from image name to an image by digest,
 * each under one of `registries`. `undefined` for anything else.
 */
export const imageDigestsOf = (
  exported: Readonly<Record<string, string>>,
  registries: readonly string[],
): ImageDigests | undefined => {
  const raw = exported[IMAGE_DIGESTS_VARIABLE];
  if (raw === undefined) return undefined;
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ImageDigests))(raw);
  if (Option.isNone(decoded)) return undefined;
  const images = decoded.value;
  const refs = Object.values(images);
  if (refs.length === 0) return undefined;
  const prefixes = registries.map((r) => r.replace(/\/+$/, ""));
  const allowed = (ref: string) => {
    const repository = ref.slice(0, ref.indexOf("@"));
    return prefixes.some((p) => repository === p || repository.startsWith(`${p}/`));
  };
  return refs.every(allowed) ? images : undefined;
};

/** The ledger key and audience target of a publish: `image-publish` or `image-publish:<label>` (FD-GATE-117). */
export const publishTarget = (entry: ImagePublishEntry): string =>
  entry.label === undefined ? "image-publish" : `image-publish:${entry.label}`;

export const imagePublishCheckName = (entry: ImagePublishEntry): string =>
  `flare-dispatch/${publishTarget(entry)}`;

const summaryOf = (entry: ImagePublishEntry, sha: string, end: BuildEnd, images?: ImageDigests) => {
  const lines = [buildSummaryText(end.state)];
  if (images !== undefined) {
    lines.push("", "| Image | Digest |", "| --- | --- |");
    for (const [name, ref] of Object.entries(images)) lines.push(`| ${name} | \`${ref}\` |`);
  }
  return {
    kind: "check.summary",
    payload: {
      name: imagePublishCheckName(entry),
      head_sha: sha,
      title: isSuccess(end.outcome) ? "Images published" : "Image build did not succeed",
      markdown: lines.join("\n"),
    },
  };
};

export const runImagePublish = (input: ImagePublishInput) =>
  Effect.gen(function* () {
    const entry = input.entry;
    const bad = awsConfigProblem(entry);
    if (bad !== undefined) return bad;
    for (const asset of entry.assets ?? []) {
      if (!ASSET_KEY.test(asset.key)) return Outcome.failure("config: assets.key");
      if (!REPO.test(asset.repo)) return Outcome.failure("config: assets.repo");
      if (!SHA256.test(asset.sha256)) return Outcome.failure("config: assets.sha256");
    }
    if (entry.registries.length === 0) return Outcome.failure("config: registries");
    const lease = yield* ExecutionLease;
    const env = buildEnv(input, lease.executionId);
    const assets = yield* ReleaseAssets;
    for (const asset of entry.assets ?? []) {
      const staged = yield* Effect.result(assets.stage(asset));
      if (staged._tag === "Failure") {
        const e = staged.failure;
        return e.kind === "unavailable"
          ? Outcome.failure(`infra: asset ${e.key}`)
          : Outcome.failure(`asset: ${e.key} ${e.kind}`);
      }
      env[`FD_ASSET_${asset.key}_URL`] = staged.success.url;
      env[`FD_ASSET_${asset.key}_SHA256`] = staged.success.sha256;
    }
    const key = publishTarget(entry);
    const target: AwsTarget = {
      region: entry.region,
      roleArn: entry.roleArn,
      target: key,
    };
    const end = yield* runBuild({
      key,
      target,
      project: entry.project,
      sha: input.sha,
      env,
      executionId: lease.executionId,
      deadlineAt: lease.deadlineAt,
    });
    const intents = yield* Intents;
    if (!isSuccess(end.outcome)) {
      yield* intents.emit("summary", summaryOf(entry, input.sha, end));
      return end.outcome;
    }
    const images = imageDigestsOf(end.state?.exported ?? {}, entry.registries);
    if (images === undefined) {
      yield* intents.emit("summary", summaryOf(entry, input.sha, end));
      return Outcome.failure("image: digests");
    }
    yield* intents.emit("summary", summaryOf(entry, input.sha, end, images));
    for (const stack of entry.stacks ?? [])
      yield* intents.emit(`stack-deploy:${stack}`, {
        kind: "dispatch.followOn",
        // Intake takes the stack's entry from the manifest at this commit; only the digests travel (FD-GATE-133).
        payload: { run: "stack-deploy", label: stack, inputs: { images } },
      });
    return Outcome.success();
  }).pipe(
    Effect.catchTags({
      AwsAssumeRoleFailed: (e) => Effect.succeed(awsFailure(e)),
      AwsCallFailed: (e) => Effect.succeed(awsFailure(e)),
      LedgerUnavailable: () => Effect.succeed(Outcome.failure("infra: LedgerUnavailable")),
      DuplicateIntentKey: () => Effect.succeed(Outcome.failure("infra: DuplicateIntentKey")),
      IntentLimitExceeded: () => Effect.succeed(Outcome.failure("infra: IntentLimitExceeded")),
    }),
  );
