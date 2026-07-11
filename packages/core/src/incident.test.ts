// Contract tests for `incident/v1`.
//
//   1. The Effect schema decodes/rejects per the documented caps and applies
//      the `contractVersion` / array defaults.
//   2. The committed JSON Schema artifact (`schemas/incident.v1.schema.json`)
//      mirrors the EXPORTED cap constants — so the language-agnostic artifact
//      can't silently drift from the canonical TypeScript contract.
//      (`scripts/emit-incident-schema.mjs` restates the caps in plain JS to stay
//      bare-node runnable; this test is the latch that keeps it honest.)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  Incident,
  INCIDENT_CONTRACT_VERSION,
  MAX_INCIDENT_CI_FAILURES,
  MAX_INCIDENT_DEMO_CHAPTERS,
  MAX_INCIDENT_LOGTAIL_CHARS,
  MAX_INCIDENT_PATH_CHARS,
  MAX_INCIDENT_SHORT_CHARS,
  MAX_INCIDENT_SUSPECT_FILES,
  MAX_INCIDENT_TEXT_CHARS,
  MAX_INCIDENT_URL_CHARS,
} from "./incident";

const decode = Schema.decodeUnknownEither(Incident);
const minimal = { incidentId: "abc123", class: "ci", repo: "owner/name" } as const;

describe("Incident schema (incident/v1)", () => {
  it("accepts a minimal incident and defaults version + arrays", () => {
    const r = decode(minimal);
    expect(Either.isRight(r)).toBe(true);
    if (Either.isRight(r)) {
      expect(r.right.contractVersion).toBe(INCIDENT_CONTRACT_VERSION);
      expect(r.right.signals).toEqual([]);
      expect(r.right.ciFailures).toEqual([]);
      expect(r.right.suspectFiles).toEqual([]);
    }
  });

  it("accepts a full CI-class incident", () => {
    const full = {
      ...minimal,
      class: "ci",
      suspectRef: { base: "a".repeat(40), head: "b".repeat(40), confidence: 0.9 },
      diagnosis: { title: "t", area: "github-actions", diagnosis: "d", suggestedFix: "f" },
      ciFailures: [
        { kind: "run-step", name: "test", conclusion: "failure", command: "pnpm test", logTail: "boom" },
      ],
      suspectFiles: ["src/handler.ts"],
      repro: { kind: "command", command: "pnpm test -- handler.test.ts" },
    };
    expect(Either.isRight(decode(full))).toBe(true);
  });

  it("rejects an unknown class", () => {
    expect(Either.isLeft(decode({ ...minimal, class: "infra" }))).toBe(true);
  });

  it("accepts a demo-class incident with chapters + a command (test) repro", () => {
    const inc = {
      ...minimal,
      class: "demo",
      demoChapters: [
        { name: "Sign in", narrative: "dashboard never rendered", replayUri: "https://r/1" },
      ],
      repro: { kind: "command", command: "pnpm test", note: "write a regression test" },
      suspectRef: { base: "a".repeat(40), head: "a".repeat(40), advisory: true, confidence: 0.3 },
    };
    expect(Either.isRight(decode(inc))).toBe(true);
  });

  it("rejects more than MAX_INCIDENT_DEMO_CHAPTERS chapters", () => {
    const one = { name: "c" } as const;
    const inc = { ...minimal, class: "demo", demoChapters: Array.from({ length: MAX_INCIDENT_DEMO_CHAPTERS + 1 }, () => one) };
    expect(Either.isLeft(decode(inc))).toBe(true);
  });

  it("rejects an over-long demoChapters narrative", () => {
    const inc = {
      ...minimal,
      class: "demo",
      demoChapters: [{ name: "c", narrative: "x".repeat(MAX_INCIDENT_LOGTAIL_CHARS + 1) }],
    };
    expect(Either.isLeft(decode(inc))).toBe(true);
  });

  it.each([
    ["incidentId", { ...minimal, incidentId: "x".repeat(MAX_INCIDENT_SHORT_CHARS + 1) }],
    ["repo", { ...minimal, repo: "x".repeat(MAX_INCIDENT_SHORT_CHARS + 1) }],
  ])("rejects an over-long %s", (_f, inc) => {
    expect(Either.isLeft(decode(inc))).toBe(true);
  });

  it("rejects an over-long ciFailures logTail", () => {
    const inc = {
      ...minimal,
      ciFailures: [{ kind: "run-step", name: "t", conclusion: "failure", logTail: "x".repeat(MAX_INCIDENT_LOGTAIL_CHARS + 1) }],
    };
    expect(Either.isLeft(decode(inc))).toBe(true);
  });

  it("rejects more than MAX_INCIDENT_CI_FAILURES failures", () => {
    const one = { kind: "actions", name: "n", conclusion: "failure" } as const;
    const inc = { ...minimal, ciFailures: Array.from({ length: MAX_INCIDENT_CI_FAILURES + 1 }, () => one) };
    expect(Either.isLeft(decode(inc))).toBe(true);
  });

  it("rejects more than MAX_INCIDENT_SUSPECT_FILES suspect files", () => {
    const inc = { ...minimal, suspectFiles: Array.from({ length: MAX_INCIDENT_SUSPECT_FILES + 1 }, () => "x") };
    expect(Either.isLeft(decode(inc))).toBe(true);
  });
});

describe("schemas/incident.v1.schema.json mirrors the TS caps", () => {
  // repo root = packages/core/src → ../../..
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const artifact = JSON.parse(
    readFileSync(resolve(root, "schemas/incident.v1.schema.json"), "utf8"),
  );
  const props = artifact.properties;

  it("carries the contract version", () => {
    expect(artifact["x-flare-dispatch-contract-version"]).toBe(INCIDENT_CONTRACT_VERSION);
    expect(props.contractVersion.const).toBe(INCIDENT_CONTRACT_VERSION);
  });

  it("requires exactly incidentId/class/repo", () => {
    expect([...artifact.required].sort()).toEqual(["class", "incidentId", "repo"].sort());
  });

  it("array caps equal the TS constants", () => {
    expect(props.ciFailures.maxItems).toBe(MAX_INCIDENT_CI_FAILURES);
    expect(props.demoChapters.maxItems).toBe(MAX_INCIDENT_DEMO_CHAPTERS);
    expect(props.suspectFiles.maxItems).toBe(MAX_INCIDENT_SUSPECT_FILES);
  });

  it("per-field maxLength caps equal the TS constants", () => {
    expect(props.incidentId.maxLength).toBe(MAX_INCIDENT_SHORT_CHARS);
    expect(props.repo.maxLength).toBe(MAX_INCIDENT_SHORT_CHARS);
    expect(props.suspectFiles.items.maxLength).toBe(MAX_INCIDENT_PATH_CHARS);
    expect(props.ciFailures.items.properties.logTail.maxLength).toBe(MAX_INCIDENT_LOGTAIL_CHARS);
    expect(props.ciFailures.items.properties.command.maxLength).toBe(MAX_INCIDENT_TEXT_CHARS);
    expect(props.ciFailures.items.properties.url.maxLength).toBe(MAX_INCIDENT_URL_CHARS);
    expect(props.diagnosis.properties.title.maxLength).toBe(MAX_INCIDENT_TEXT_CHARS);
    expect(props.demoChapters.items.properties.name.maxLength).toBe(MAX_INCIDENT_SHORT_CHARS);
    expect(props.demoChapters.items.properties.narrative.maxLength).toBe(MAX_INCIDENT_LOGTAIL_CHARS);
  });

  it("the class enum matches", () => {
    expect([...props.class.enum].sort()).toEqual(["application", "ci", "demo"].sort());
  });
});
