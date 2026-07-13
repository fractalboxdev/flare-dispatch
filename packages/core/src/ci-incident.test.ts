// Tests for the offload-test (CI failure) → `incident/v1` adapter.
//
// What this mapper must guarantee:
//   1. ONLY a non-zero exit with a command emits an incident (a pass, or a
//      missing command → null; nothing to heal).
//   2. The produced pack is a VALID `ci`-class incident with a `command` repro
//      (so self-heal-pr can re-run it) and a high-confidence, non-advisory
//      suspectRef (CI failed on THIS commit).
//   3. The fingerprint keys off (repo, sha) only — the UNTRUSTED log can't mint
//      a fresh identity, so dedup/cooldown hold. The log rides `ciFailures`,
//      never the trusted `diagnosis`.

import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { commandFailureToIncident, type CiIncidentContext } from "./ci-incident";
import { Incident, MAX_INCIDENT_LOGTAIL_CHARS } from "./incident";

const ctx = (over: Partial<CiIncidentContext>): CiIncidentContext => ({
  repo: "acme/widget",
  sha: "a".repeat(40),
  command: "pnpm test",
  exitCode: 1,
  ...over,
});

const decodeIncident = Schema.decodeUnknownEither(Incident);

describe("commandFailureToIncident", () => {
  it("returns null when the command passed (exit 0)", () => {
    expect(commandFailureToIncident(ctx({ exitCode: 0 }))).toBeNull();
  });

  it("returns null when there is no command repro", () => {
    expect(commandFailureToIncident(ctx({ command: "" }))).toBeNull();
    expect(commandFailureToIncident(ctx({ command: "   " }))).toBeNull();
  });

  it("produces a valid ci-class incident with a command repro", () => {
    const inc = commandFailureToIncident(ctx({}))!;
    expect(inc).not.toBeNull();
    const r = decodeIncident(inc);
    expect(Either.isRight(r)).toBe(true);
    if (Either.isRight(r)) {
      expect(r.right.class).toBe("ci");
      expect(r.right.repo).toBe("acme/widget");
      expect(r.right.repro?.kind).toBe("command");
      expect(r.right.repro?.command).toBe("pnpm test");
      // CI failed on this exact commit → non-advisory, full-confidence ref.
      expect(r.right.suspectRef?.head).toBe("a".repeat(40));
      expect(r.right.suspectRef?.confidence).toBe(1);
      expect(r.right.suspectRef?.advisory).toBeUndefined();
    }
  });

  it("fingerprints on (repo, sha) only — the untrusted log can't change identity", () => {
    const a = commandFailureToIncident(ctx({ logTail: "boom A" }))!;
    const b = commandFailureToIncident(ctx({ logTail: "boom B" }))!;
    expect(a.incidentId).toBe(b.incidentId);
    expect(a.incidentId).toBe(`ci:acme/widget:${"a".repeat(40)}`);
  });

  it("carries the log on ciFailures (fenced), never in the trusted diagnosis", () => {
    const inc = commandFailureToIncident(
      ctx({ logTail: "SECRET-INJECTION-PAYLOAD", logUri: "https://r2.example/log" }),
    )!;
    expect(inc.ciFailures?.[0]?.logTail).toContain("SECRET-INJECTION-PAYLOAD");
    expect(inc.ciFailures?.[0]?.url).toBe("https://r2.example/log");
    expect(JSON.stringify(inc.diagnosis)).not.toContain("SECRET-INJECTION-PAYLOAD");
  });

  it("clamps an oversized log tail and still decodes", () => {
    const inc = commandFailureToIncident(ctx({ logTail: "x".repeat(99_999) }))!;
    expect(inc.ciFailures?.[0]?.logTail?.length).toBe(MAX_INCIDENT_LOGTAIL_CHARS);
    expect(Either.isRight(decodeIncident(inc))).toBe(true);
  });
});
