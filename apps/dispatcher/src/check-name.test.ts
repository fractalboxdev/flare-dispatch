// Unit tests for check-run naming (`checkRunNameFor`).
//
// The two properties that matter: every existing run keeps its exact historical
// name (no deployed required check may silently change), and a valid
// `checkLabel` produces a distinct, separately-requirable name.

import { describe, expect, it } from "vitest";
import { checkRunNameFor } from "./check-name";

describe("checkRunNameFor", () => {
  it("names a labelless dispatch exactly as before — `flare-dispatch/<run>`", () => {
    expect(checkRunNameFor("offload-test", { repo: "owner/name" })).toBe(
      "flare-dispatch/offload-test",
    );
    expect(checkRunNameFor("pr-review", { repo: "owner/name", pr: 12 })).toBe(
      "flare-dispatch/pr-review",
    );
  });

  it("tolerates inputs that are not objects at all", () => {
    // `RunWorkflow` names the check BEFORE decoding inputs against the run's
    // schema, so anything can arrive here.
    for (const inputs of [undefined, null, "a string", 42, []]) {
      expect(checkRunNameFor("offload-test", inputs)).toBe(
        "flare-dispatch/offload-test",
      );
    }
  });

  it("appends a valid label so each gate is its own required check", () => {
    expect(
      checkRunNameFor("check", { checkLabel: "codegen" }),
    ).toBe("flare-dispatch/check:codegen");
    expect(
      checkRunNameFor("check", { checkLabel: "lint-shell" }),
    ).toBe("flare-dispatch/check:lint-shell");
    // Dots and underscores are in the allowed set.
    expect(
      checkRunNameFor("check", { checkLabel: "tf.fmt_check" }),
    ).toBe("flare-dispatch/check:tf.fmt_check");
  });

  it("ignores a malformed label rather than composing a broken check name", () => {
    // Each of these could produce a name that does not match what an operator
    // typed into branch protection — a check that appears to pass while gating
    // nothing. Falling back to the plain name keeps the failure visible.
    const bad = [
      "has space",
      "has/slash",
      "has:colon",
      "-leading-dash",
      "",
      "a".repeat(33),
      "\nnewline",
      42,
      null,
    ];
    for (const checkLabel of bad) {
      expect(checkRunNameFor("check", { checkLabel })).toBe(
        "flare-dispatch/check",
      );
    }
  });

  it("rejects a TRAILING line terminator, not just a leading one", () => {
    // JS `$` in a non-`m` pattern asserts end-of-input, so these already fail —
    // unlike Python / PCRE, where `$` matches before a final newline. Pinned
    // explicitly so adding an `m` flag to CHECK_LABEL_PATTERN breaks a test
    // rather than silently admitting `flare-dispatch/check:codegen\n`, a name
    // that would never match what an operator typed into branch protection.
    for (const checkLabel of [
      "codegen\n",
      "codegen\r",
      "codegen\r\n",
      "code\ngen",
    ]) {
      expect(checkRunNameFor("check", { checkLabel })).toBe(
        "flare-dispatch/check",
      );
    }
  });

  it("accepts a label exactly at the 32-char ceiling", () => {
    const label = "a".repeat(32);
    expect(checkRunNameFor("check", { checkLabel: label })).toBe(
      `flare-dispatch/check:${label}`,
    );
  });
});
