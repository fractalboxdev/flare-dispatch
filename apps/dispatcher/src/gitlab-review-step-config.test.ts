// Unit tests for the shared GitLab review-step retry/timeout constants —
// mostly a guard against the two derived values drifting apart from the
// retry limit they come from.

import { describe, expect, it } from "vitest";
import {
  REVIEW_STEP_ATTEMPTS,
  REVIEW_STEP_RETRY_LIMIT,
  REVIEW_STEP_TIMEOUT,
} from "./gitlab-review-step-config";

describe("gitlab-review-step-config", () => {
  it("REVIEW_STEP_ATTEMPTS is the retry limit plus the first try", () => {
    expect(REVIEW_STEP_ATTEMPTS).toBe(REVIEW_STEP_RETRY_LIMIT + 1);
  });

  it("REVIEW_STEP_RETRY_LIMIT is 1 (one retry, then announce)", () => {
    expect(REVIEW_STEP_RETRY_LIMIT).toBe(1);
  });

  it("REVIEW_STEP_TIMEOUT is a CF Workflows duration literal", () => {
    expect(REVIEW_STEP_TIMEOUT).toBe("25 minutes");
  });
});
