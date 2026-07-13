// Contract tests for `signals/v1`.
//
//   1. The Effect schema decodes/rejects per the documented caps.
//   2. The committed JSON Schema artifact (`schemas/signals.v1.schema.json`)
//      mirrors the EXPORTED cap constants — so the language-agnostic artifact
//      a non-TS consumer validates against can't silently drift from the
//      canonical TypeScript contract. (`scripts/emit-signals-schema.mjs`
//      restates the caps in plain JS to stay bare-node runnable; this test is
//      the latch that keeps that restatement honest.)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MAX_SIGNAL_DETAIL_CHARS,
  MAX_SIGNAL_SOURCE_CHARS,
  MAX_SIGNAL_TITLE_CHARS,
  MAX_SIGNAL_URL_CHARS,
  MAX_SIGNALS,
  SIGNALS_CONTRACT_VERSION,
  Signal,
  SignalArray,
} from "./signals";

const decode = Schema.decodeUnknownEither(SignalArray);
const valid = {
  source: "workers-observability:my-api",
  title: "Unhandled exception",
  detail: "TypeError: cannot read properties of undefined",
} as const;

describe("Signal schema (signals/v1)", () => {
  it("accepts a minimal signal (source/title/detail only)", () => {
    expect(Either.isRight(Schema.decodeUnknownEither(Signal)(valid))).toBe(true);
  });

  it("accepts the optional url + count", () => {
    const full = { ...valid, url: "https://dash.example.com", count: 12 };
    expect(Either.isRight(Schema.decodeUnknownEither(Signal)(full))).toBe(true);
  });

  it.each([
    ["source", { ...valid, source: "x".repeat(MAX_SIGNAL_SOURCE_CHARS + 1) }],
    ["title", { ...valid, title: "x".repeat(MAX_SIGNAL_TITLE_CHARS + 1) }],
    ["detail", { ...valid, detail: "x".repeat(MAX_SIGNAL_DETAIL_CHARS + 1) }],
    ["url", { ...valid, url: "x".repeat(MAX_SIGNAL_URL_CHARS + 1) }],
  ])("rejects an over-long %s", (_field, signal) => {
    expect(Either.isLeft(Schema.decodeUnknownEither(Signal)(signal))).toBe(true);
  });

  it("accepts up to MAX_SIGNALS items", () => {
    const arr = Array.from({ length: MAX_SIGNALS }, () => valid);
    expect(Either.isRight(decode(arr))).toBe(true);
  });

  it("rejects more than MAX_SIGNALS items", () => {
    const arr = Array.from({ length: MAX_SIGNALS + 1 }, () => valid);
    expect(Either.isLeft(decode(arr))).toBe(true);
  });
});

describe("schemas/signals.v1.schema.json mirrors the TS caps", () => {
  // repo root = packages/core/src → ../../..
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const artifact = JSON.parse(
    readFileSync(resolve(root, "schemas/signals.v1.schema.json"), "utf8"),
  );

  it("carries the contract version", () => {
    expect(artifact["x-flare-dispatch-contract-version"]).toBe(
      SIGNALS_CONTRACT_VERSION,
    );
  });

  it("array cap equals MAX_SIGNALS", () => {
    expect(artifact.maxItems).toBe(MAX_SIGNALS);
  });

  it("per-field maxLength caps equal the TS constants", () => {
    const props = artifact.items.properties;
    expect(props.source.maxLength).toBe(MAX_SIGNAL_SOURCE_CHARS);
    expect(props.title.maxLength).toBe(MAX_SIGNAL_TITLE_CHARS);
    expect(props.detail.maxLength).toBe(MAX_SIGNAL_DETAIL_CHARS);
    expect(props.url.maxLength).toBe(MAX_SIGNAL_URL_CHARS);
  });

  it("requires exactly source/title/detail", () => {
    expect([...artifact.items.required].sort()).toEqual(
      ["detail", "source", "title"].sort(),
    );
  });
});
