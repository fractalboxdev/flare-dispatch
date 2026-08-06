import { describe, expect, it } from "vitest";
import { clampTailBytes, nonceLogPath, sandboxDoName, shellQuote } from "./policy";

// No mocks, by design. These are the assertions worth running on every commit —
// the id that keeps one consumer's container out of another's, the quote that
// keeps a redirect intact around a hostile command — so they run against the
// real module rather than behind a fake of an SDK surface that moves.

describe("sandboxDoName", () => {
  const KEY = "T0BHKNCKUH0:C09ABCDEFGH:1754280000:7";

  it("namespaces per consumer so two consumers' keys can never collide", () => {
    expect(sandboxDoName("fractalbot", KEY)).toBe(`fractalbot:${KEY}`);
    expect(sandboxDoName("dispatcher", KEY)).not.toBe(sandboxDoName("fractalbot", KEY));
  });

  it("leaves a realistic fractalbot task key under the SDK's cap", () => {
    // Canary: `sanitizeSandboxId` throws above 63 characters, at container
    // start, where a user would see an unexplained broken turn.
    expect(sandboxDoName("fractalbot", KEY).length).toBeLessThanOrEqual(63);
  });

  it("fails legibly rather than at container start when a key is too long", () => {
    expect(() => sandboxDoName("fractalbot", "T".repeat(70))).toThrow(/over the SDK's 63/);
  });
});

describe("shellQuote", () => {
  it("wraps a path so a shell sees one literal argument", () => {
    expect(shellQuote("/artifacts/tasks/7/000-test.log")).toBe(
      "'/artifacts/tasks/7/000-test.log'",
    );
  });

  it("neutralises the expansions a shell would otherwise perform", () => {
    // These reach a shell as part of a redirect the sandbox builds around a
    // workload's command; unquoted, `$(...)` would execute.
    for (const hostile of ["a b", "$(whoami)", "`id`", "a;rm -rf /", "*", "a\nb"]) {
      const quoted = shellQuote(hostile);
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
      expect(quoted.slice(1, -1)).not.toContain("'");
    }
  });

  it("survives a literal single quote, which is the only hard case", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("clampTailBytes", () => {
  it("passes short output through untouched", () => {
    expect(clampTailBytes("suite green", 64)).toEqual({
      tail: "suite green",
      truncated: false,
    });
  });

  it("keeps the END of the output, which is where the failure is", () => {
    const clamped = clampTailBytes("a".repeat(100) + "FAILED", 16);
    expect(clamped.tail.endsWith("FAILED")).toBe(true);
    expect(clamped.truncated).toBe(true);
  });

  it("clamps by bytes, not characters", () => {
    // Two-byte characters, cut at an odd offset so the slice starts
    // mid-codepoint. An orphaned lead byte decodes to U+FFFD; a consumer
    // should not be handed a replacement character as if it were output.
    const clamped = clampTailBytes("é".repeat(4000), 101);
    expect(new TextEncoder().encode(clamped.tail).length).toBeLessThanOrEqual(101);
    expect(clamped.tail.startsWith("�")).toBe(false);
    expect(clamped.truncated).toBe(true);
  });
});

describe("nonceLogPath", () => {
  it("keeps the caller's shape recognisable", () => {
    expect(nonceLogPath("tasks/7/000-test.log", "abcdef01-2345-6789-abcd-ef0123456789")).toBe(
      "tasks/7/000-test.abcdef012345.log",
    );
  });

  it("makes the name unguessable from what the workload knows", () => {
    // The artifacts mount is writable and a consumer's logPath is derivable
    // inside the container. Two runs of one step must not land on one name.
    const a = nonceLogPath("tasks/7/000-test.log", crypto.randomUUID());
    const b = nonceLogPath("tasks/7/000-test.log", crypto.randomUUID());
    expect(a).not.toBe(b);
    expect(a).not.toBe("tasks/7/000-test.log");
  });

  it("handles a path with no extension", () => {
    expect(nonceLogPath("tasks/7/log", "abcdef01-2345-6789-abcd-ef0123456789")).toBe(
      "tasks/7/log.abcdef012345",
    );
  });

  it("does not mistake a dot in a directory for an extension", () => {
    expect(nonceLogPath("tasks/v1.2/run", "abcdef01-2345-6789-abcd-ef0123456789")).toBe(
      "tasks/v1.2/run.abcdef012345",
    );
  });
});
