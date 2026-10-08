import { Effect } from "effect";
import { admitNativeReadBinding, admitNativeRequest, NativeReceiptRefused } from "@fractalboxdev/flare-dispatch-core";
import { streamNativeWindowsArchive } from "@fractalboxdev/flare-dispatch-github-app";
import { makeNativeDispatchD1 } from "./native-dispatch-d1";
import { makeNativeGithubProvider } from "./native-github-provider";
import { makeNativeArchiveDownload } from "./native-archive-download";
import { makeNativeArchiveR2 } from "./native-archive-r2";
import { makeNativeResultR2, nativeResultKey } from "./native-result-r2";

type Options = {
  readonly db: D1Database; readonly bucket: R2Bucket;
  readonly controller: { readonly appId: number; readonly actorLogin: string };
  readonly client: Parameters<typeof makeNativeGithubProvider>[0];
  readonly now?: () => number;
};
const refused = (reason: string) => new NativeReceiptRefused({ reason });

/** An authenticated caller owns ephemeral credentials; durable dispatch alone owns the POST claim. */
export const makeNativeController = ({ db, bucket, controller, client, now: clock = () => Math.floor(Date.now() / 1000) }: Options) => {
  const provider = makeNativeGithubProvider(client);
  const dispatch = makeNativeDispatchD1(db, controller, provider);
  const results = makeNativeResultR2(bucket, controller.actorLogin);
  const advance = (rawRequest: unknown) => Effect.gen(function* () {
    const request = yield* admitNativeRequest(rawRequest);
    if (request.repo !== client.repo || client.token.length === 0)
      return yield* Effect.fail(refused("native controller credential scope invalid"));
    yield* dispatch.start(request);
    const state = yield* dispatch.reconcile(request);
    if (state.state !== "bound" || state.runId === null || state.runAttempt === null)
      return { _tag: "WaitingForRun" as const };
    const now = clock();
    const binding = yield* admitNativeReadBinding({ version: 1, repo: request.repo, head: request.head, base: request.base,
      nonce: request.nonce, target: request.target, command_sha256: request.command_sha256,
      executor_ref: request.executor_ref, expires_at: now + 600 }, now);
    const existing = yield* Effect.tryPromise({ try: () => bucket.head(nativeResultKey(binding)), catch: () => refused("native publication observation unavailable") });
    if (existing !== null) {
      const result = yield* results.read(binding, now);
      if (result.receipt.run_id !== String(state.runId) || result.receipt.run_attempt !== String(state.runAttempt))
        return yield* Effect.fail(refused("native publication conflicts with durable run"));
      return { _tag: "Published" as const, result };
    }
    const run = { runId: state.runId, runAttempt: state.runAttempt };
    const observed = yield* provider.observeRun(request, run, controller.actorLogin);
    if (observed._tag === "Pending") return { ...observed, _tag: "Running" as const };
    if (observed.conclusion !== "success") return { ...observed, _tag: "Failed" as const };
    const evidence = yield* provider.collect(request, run, controller.actorLogin);
    const response = yield* Effect.tryPromise({ try: () => streamNativeWindowsArchive({ ...client, artifactId: evidence.artifactId }),
      catch: () => refused("native authenticated archive download unavailable") });
    const result = yield* Effect.acquireUseRelease(
      makeNativeArchiveDownload(bucket).stage(response),
      (archive) => Effect.gen(function* () {
        const captured = yield* makeNativeArchiveR2(bucket).verify({ request, api: evidence.api, controllerLogin: controller.actorLogin }, archive.key);
        return yield* results.publish({ request, api: evidence.api, ...captured, verifiedAt: clock() }, clock());
      }),
      (archive) => Effect.tryPromise({ try: () => bucket.delete(archive.key), catch: () => refused("native temporary archive disposal unavailable") }).pipe(Effect.orDie),
    );
    return { _tag: "Published" as const, result };
  });
  return { advance };
};
