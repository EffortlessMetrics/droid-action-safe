import { describe, expect, it } from "bun:test";
import {
  buildReviewTools,
  isReadOnlyReviewEnabled,
} from "../../../src/tag/commands/review-tools";

const TRACKING = "github_comment___update_droid_comment";

describe("read-only review tool policy", () => {
  it("parses the switch fail closed", () => {
    expect(isReadOnlyReviewEnabled(undefined)).toBe(false);
    expect(isReadOnlyReviewEnabled(" false ")).toBe(false);
    expect(isReadOnlyReviewEnabled(" TRUE ")).toBe(true);
    expect(() => isReadOnlyReviewEnabled("yes")).toThrow(
      "READ_ONLY_REVIEW must be 'true' or 'false'",
    );
  });

  it("removes execution, mutation, network fetch, and caller MCP expansion", () => {
    const tools = buildReviewTools({
      phase: "candidate",
      normalizedUserArgs: "",
      userAllowedMCPTools: [
        TRACKING,
        "github_issues___create_issue",
        "github_pr___submit_review",
      ],
      readOnly: true,
    });

    expect(tools).toEqual([
      "Read",
      "Grep",
      "Glob",
      "LS",
      TRACKING,
      "Task",
      "Skill",
    ]);
    for (const forbidden of [
      "Execute",
      "Edit",
      "Create",
      "ApplyPatch",
      "FetchUrl",
      "github_issues___create_issue",
      "github_pr___submit_review",
    ]) {
      expect(tools).not.toContain(forbidden);
    }
  });

  it("lets the validator publish a review without mutation tools", () => {
    const tools = buildReviewTools({
      phase: "validator",
      normalizedUserArgs: "",
      userAllowedMCPTools: ["github_issues___create_issue"],
      readOnly: true,
    });

    expect(tools).toContain("github_pr___submit_review");
    expect(tools).toContain(TRACKING);
    expect(tools).not.toContain("Execute");
    expect(tools).not.toContain("FetchUrl");
    expect(tools).not.toContain("github_issues___create_issue");
  });

  it("rejects arbitrary Droid arguments instead of allowing tool overrides", () => {
    expect(() =>
      buildReviewTools({
        phase: "candidate",
        normalizedUserArgs: '--enabled-tools "Execute"',
        userAllowedMCPTools: [],
        readOnly: true,
      }),
    ).toThrow("DROID_ARGS are not accepted");
  });

  it("preserves the legacy candidate tool policy when disabled", () => {
    const tools = buildReviewTools({
      phase: "candidate",
      normalizedUserArgs: "",
      userAllowedMCPTools: [
        TRACKING,
        "github_issues___create_issue",
        "github_pr___submit_review",
      ],
      readOnly: false,
    });

    expect(tools).toContain("Execute");
    expect(tools).toContain("ApplyPatch");
    expect(tools).toContain("FetchUrl");
    expect(tools).toContain("github_issues___create_issue");
    expect(tools).not.toContain("github_pr___submit_review");
  });
});
