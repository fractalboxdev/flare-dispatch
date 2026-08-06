import { describe, expect, it } from "vitest";
import { fencedKillSet, fenceKillMode } from "./detached";

const tracked = (...ids: string[]) => ids.map((id) => ({ id }));

describe("fenceKillMode — the common path must not change (ADR-0012)", () => {
  it("keeps the pre-ADR teardown when nothing was declared detached", () => {
    // Not an optimisation. `kill-all` means the fence calls the same SDK method
    // it always did, so an execution with no detached process gains no extra
    // round trip and no new way to fail.
    expect(fenceKillMode([])).toBe("kill-all");
  });

  it("switches to the selective walk as soon as one process is declared", () => {
    expect(fenceKillMode(["sub-detached-1"])).toBe("kill-listed");
  });
});

describe("fencedKillSet — what survives a grant revoke", () => {
  it("kills everything the execution did not declare", () => {
    expect(
      fencedKillSet(["sub-detached-dev-server"], tracked("exec-1", "sub-detached-dev-server")),
    ).toEqual(["exec-1"]);
  });

  it("kills a process the workload backgrounded itself", () => {
    // The whole point of the fence: a `&` in a command string is not a
    // declaration, and it holds the grant that is about to be revoked.
    expect(fencedKillSet(["sub-detached-1"], tracked("sub-detached-1", "nohup-child"))).toEqual([
      "nohup-child",
    ]);
  });

  it("kills nothing when every tracked process was declared", () => {
    expect(fencedKillSet(["a", "b"], tracked("a", "b"))).toEqual([]);
  });

  it("ignores a declared id the container no longer tracks", () => {
    // A process that exited between the declaration and the teardown needs no
    // special case — it cannot hold a grant.
    expect(fencedKillSet(["gone", "alive"], tracked("alive", "exec-1"))).toEqual(["exec-1"]);
  });

  it("matches ids exactly, never by prefix", () => {
    // Ids are substrate-assigned UUIDs. A prefix match would let a process
    // named `sub-detached-1-child` inherit a sparing decision made about
    // `sub-detached-1`, which is the shape of every id-confusion bug.
    expect(fencedKillSet(["sub-detached-1"], tracked("sub-detached-1-child"))).toEqual([
      "sub-detached-1-child",
    ]);
  });

  it("spares nothing when the declared set is empty", () => {
    // `fenceKillMode` routes this case to `killAllProcesses` before the set is
    // ever built; asserted anyway, so the two answers can never disagree about
    // what an empty declaration means.
    expect(fencedKillSet([], tracked("a", "b"))).toEqual(["a", "b"]);
  });
});
