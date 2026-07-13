// Manifest parity — the Worker-bundled `MANIFEST_TEMPLATE` literal MUST equal
// the committed `infra/github-app-manifest.json` mirror.
//
// The Worker can't read files at runtime, so the manifest served at
// `/v1/github/install/new` is an inlined TS literal (github.ts), while the
// committed JSON is what the verify CLI + docs + BYOC operators read. spec 04 §
// Webhook mode calls these two copies "mirrors"; this test is the gate the
// github.ts comment asked for, so the two can't silently drift.
//
// Runs under plain Node (the dispatcher's vitest project), so the file read is
// fine here even though it would fail in the workers pool.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MANIFEST_TEMPLATE } from "./github";

const manifestJson = JSON.parse(
  readFileSync(
    new URL("../../../../infra/github-app-manifest.json", import.meta.url),
    "utf8",
  ),
) as unknown;

describe("GitHub App manifest parity", () => {
  it("the bundled MANIFEST_TEMPLATE literal equals infra/github-app-manifest.json", () => {
    // structuredClone strips the `as const` readonly brands so the deep-equal
    // compares plain values.
    expect(structuredClone(MANIFEST_TEMPLATE)).toEqual(manifestJson);
  });
});
