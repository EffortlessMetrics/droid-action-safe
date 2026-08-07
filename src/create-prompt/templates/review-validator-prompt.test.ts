import { describe, expect, test } from "bun:test";
import { generateReviewValidatorPrompt } from "./review-validator-prompt";

const context = {
  repository: "EffortlessMetrics/example",
  eventData: {
    isPR: true,
    prNumber: 42,
    baseBranch: "main",
  },
  prBranchData: {
    headRefName: "fix/example",
    headRefOid: "0123456789abcdef",
  },
  reviewArtifacts: {
    diffPath: "/tmp/pr.diff",
    commentsPath: "/tmp/comments.json",
    descriptionPath: "/tmp/description.md",
  },
  includeSuggestions: true,
} as any;

describe("review validator prompt", () => {
  test("requires independent review when pass 1 has no candidates", () => {
    const prompt = generateReviewValidatorPrompt(context);

    expect(prompt).toContain("NOT limited to validating Phase 1 output");
    expect(prompt).toContain("even when the candidate list is empty");
    expect(prompt).toContain("Independent cumulative review");
    expect(prompt).toContain("A zero-candidate input still requires");
    expect(prompt).toContain("material findings that Pass 1 missed");
    expect(prompt).toContain('"independentFindings"');
    expect(prompt).toContain('"summaryFindings"');
    expect(prompt).toContain("without a safe inline location");
  });

  test("requires a useful durable review body for clean results", () => {
    const prompt = generateReviewValidatorPrompt(context);

    expect(prompt).toContain("A clean review is valid");
    expect(prompt).toContain("reviewSummary.body");
    expect(prompt).toContain("required for every result, including `clean`");
    expect(prompt).toContain("## Review scope");
    expect(prompt).toContain("## Evidence and falsifiers");
    expect(prompt).toContain("## No material findings");
    expect(prompt).toContain("## Prior finding dispositions");
    expect(prompt).toContain("fixed | refuted | superseded | follow-up");
    expect(prompt).toContain("## What this establishes");
    expect(prompt).toContain("## Residual risk / not proved");
    expect(prompt).toContain("## Next action");
    expect(prompt).toContain("Include `reviewSummary.body` as the review `body`");
  });

  test("separates advisory review truth from pull-request approval", () => {
    const prompt = generateReviewValidatorPrompt(context);

    expect(prompt).toContain("Never use `approved` as the overall result");
    expect(prompt).toContain("does not approve the pull request or authorize merge");
    expect(prompt).toContain("clean | findings | not_proven | stale");
    expect(prompt).toContain("Use `not_proven` rather than clean");
    expect(prompt).toContain("do not publish findings against a different candidate");
    expect(prompt).toContain("is `clean` only when all three finding sets are empty");
  });
});