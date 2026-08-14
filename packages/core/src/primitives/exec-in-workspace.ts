// Primitive: execInWorkspace — run a command against a workspace, rebuilding
// the checkout first if the container lost it.
//
// Container disk does not survive a restart, so a memoized checkout can point
// at a directory that is gone. specs/adr/0001-cloudflare-workflows-scope.md
// rule 3.

import { Effect } from "effect";
import type { ExecFailed, ExecTimeout } from "../errors";
import { sandbox, type ExecResult } from "../services/sandbox";
import { hydrateWorkspace, type Workspace } from "./workspace";

export type ExecInWorkspaceOpts = {
  readonly command: string | readonly string[];
  readonly env?: Record<string, string>;
  readonly timeoutSec?: number;
  readonly redactValues?: readonly string[];
};

export const execInWorkspace = (
  ws: Workspace,
  opts: ExecInWorkspaceOpts,
): Effect.Effect<
  ExecResult,
  ExecFailed | ExecTimeout | Effect.Effect.Error<ReturnType<typeof hydrateWorkspace>>,
  Effect.Effect.Context<ReturnType<typeof hydrateWorkspace>>
> =>
  Effect.gen(function* () {
    const run = (dir: string) =>
      sandbox.exec({ ...opts, cwd: dir, container: ws.container });

    const first = yield* Effect.either(run(ws.dir));
    if (first._tag === "Right") return first.right;
    if (first.left._tag !== "ExecFailed" || first.left.workspaceMissing !== true) {
      return yield* Effect.fail(first.left);
    }

    yield* Effect.logWarning(
      `workspace ${ws.dir} was gone at exec time — rebuilding the checkout and running again`,
    );
    const dir = yield* hydrateWorkspace(ws.container, ws.spec);
    return yield* run(dir);
  });
