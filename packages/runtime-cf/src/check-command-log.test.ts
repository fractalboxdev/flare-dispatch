import { describe, expect, it } from "vitest";
import { scrubLogPrefix } from "./check-command-log";

describe("bounded check command log chunks", () => {
  it("retains a split secret suffix until the following bytes arrive", () => {
    const first = scrubLogPrefix("hello TOPSEC", ["TOPSECRET"], false);
    expect(first.text).not.toContain("TOP");
    const remaining = "hello TOPSEC".slice(first.characters) + "RET world\n";
    const final = scrubLogPrefix(remaining, ["TOPSECRET"], true);
    expect(first.text + final.text).toBe("hello *** world\n");
  });
  it("bounds every upload and preserves Unicode and overlapping secrets", () => {
    const raw = "x".repeat(80000) + "秘密🔒" + "\n";
    const prefix = scrubLogPrefix(raw, ["秘密🔒"], false);
    expect(new TextEncoder().encode(prefix.text).length).toBeLessThanOrEqual(65536);
    let remaining = raw.slice(prefix.characters),
      text = prefix.text;
    while (remaining.length > 0) {
      const rest = scrubLogPrefix(remaining, ["秘密🔒"], true);
      text += rest.text;
      remaining = remaining.slice(rest.characters);
    }
    expect(text).toBe("x".repeat(80000) + "***\n");
    expect(scrubLogPrefix("abcXYZabcd", ["abc", "abcd"], true).text).toBe("***XYZ***");
  });
});
