import { describe, expect, test } from "bun:test";
import {
  securityReviewHeadMarker,
  updateCommentBody,
} from "../src/github/operations/comment-logic";
import { securityReviewMarker } from "../src/tag";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function completedBody(headSha?: string, securityReviewRan = true): string {
  return updateCommentBody({
    currentBody: "Droid is working…\n\nreview output",
    actionFailed: false,
    executionDetails: null,
    jobUrl: "https://github.com/acme/repo/actions/runs/1",
    triggerUsername: "maintainer",
    securityReviewRan,
    securityReviewHeadSha: headSha,
  });
}

describe("security review head markers", () => {
  test("expected head selects a per-head completion marker", () => {
    expect(securityReviewMarker(HEAD_A)).toBe(
      `<!-- droid-security-head:${HEAD_A} -->`,
    );
    expect(securityReviewMarker(HEAD_B)).not.toBe(securityReviewMarker(HEAD_A));
  });

  test("no expected head preserves the legacy run-once marker", () => {
    expect(securityReviewMarker(undefined)).toBe("## Security Review Summary");
  });

  test("successful security completion records the exact reviewed head", () => {
    const body = completedBody(HEAD_A);
    expect(body).toContain(securityReviewHeadMarker(HEAD_A));
    expect(body).toContain("security%20review-ran");
    expect(body).not.toContain(securityReviewHeadMarker(HEAD_B));
  });

  test("a non-security completion does not mint review evidence", () => {
    const body = completedBody(HEAD_A, false);
    expect(body).not.toContain(securityReviewHeadMarker(HEAD_A));
    expect(body).not.toContain("security%20review-ran");
  });

  test("malformed head values do not create completion markers", () => {
    expect(securityReviewHeadMarker("abc123")).toBe("");
  });
});
