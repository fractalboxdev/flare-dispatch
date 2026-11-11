import { describe, expect, it } from "vitest";
import { parseArtifacts } from "./main.ts";

describe("parseArtifacts", () => {
  it("takes each executable from cargo's JSON messages, wherever cargo wrote it", () => {
    const messages = [
      '{"reason":"compiler-artifact","target":{"name":"mameko_protocol"},"executable":null}',
      '{"reason":"compiler-artifact","target":{"name":"mameko-cli"},"executable":"/pool/slot-1/debug/mameko-cli"}',
      '{"reason":"build-finished","success":true}',
    ].join("\n");
    expect(parseArtifacts(messages)).toEqual(
      new Map([["mameko-cli", "/pool/slot-1/debug/mameko-cli"]]),
    );
  });
});
