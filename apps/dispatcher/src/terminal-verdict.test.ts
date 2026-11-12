import { describe, expect, it } from "vitest";
import { checkConclusion } from "./terminal-verdict";

describe("checkConclusion", () => {
  it("maps a recorded verdict to its check-run conclusion", () => {
    expect(checkConclusion("success", true)).toBe("success");
    expect(checkConclusion("failure", true)).toBe("failure");
    expect(checkConclusion("skipped", true)).toBe("neutral");
  });

  it("concludes failure whenever the terminal record was not written", () => {
    expect(checkConclusion("success", false)).toBe("failure");
    expect(checkConclusion("skipped", false)).toBe("failure");
    expect(checkConclusion("failure", false)).toBe("failure");
  });
});
