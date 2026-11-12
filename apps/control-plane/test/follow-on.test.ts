// The `dispatch.followOn` applier of a deploy with the App, over the isolate's services as the composition builds them:
// the row reaches intake's admission, keyed by the `follow-on` recipe.
import { Actuators } from "@fractalboxdev/mameko-ports";
import { Context, Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  appDeploy,
  followOnRow,
  INTENT_KEY,
  PARENT,
  SMOKE_INPUTS,
} from "./follow-on.test-support.ts";

describe("the dispatch.followOn applier of a deploy with the App", () => {
  it("[FD-GH-088] submits one request to admission keyed <execution_id>/<intent_key>, and a repeated apply starts no second execution", async () => {
    const deploy = await appDeploy();
    const followOn = Context.get(deploy.services, Actuators).get("followOn")!;
    const first = await Effect.runPromise(followOn.apply(followOnRow()));
    const again = await Effect.runPromise(followOn.apply(followOnRow({ attempts: 1 })));
    expect(first).toMatchObject({ _tag: "applied" });
    expect(again).toEqual(first);
    const children = deploy.children();
    expect(children).toEqual([
      {
        execution_id: (first as { externalRef: string }).externalRef,
        run: "deploy-smoke",
        sha: SMOKE_INPUTS.sha,
      },
    ]);
    expect(deploy.db.sqlite.prepare("select canonical from dedup_keys").all()).toEqual([
      { canonical: `${PARENT}/${INTENT_KEY}` },
    ]);
    expect(deploy.starts.map((p) => p.executionId)).toEqual([children[0]!.execution_id]);
  });
});
