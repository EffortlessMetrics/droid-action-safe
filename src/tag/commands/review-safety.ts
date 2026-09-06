import * as core from "@actions/core";
import { resolveReviewConfig } from "../../utils/review-depth";

/** Built-in tools exposed to model-bearing automatic review passes. */
export const RESTRICTED_REVIEW_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "LS",
  "Create",
  "Skill",
] as const;

/**
 * Configure a model-bearing review pass as analysis-only except for writing its
 * bounded JSON artifact. User-supplied Droid arguments are intentionally not
 * appended: an arbitrary argument must not widen a secrets-backed review job.
 */
export function buildRestrictedReviewArgs(options: {
  reviewModel?: string;
  reasoningEffort?: string;
  reviewDepth?: string;
}): string {
  const { model, reasoningEffort } = resolveReviewConfig({
    reviewModel: options.reviewModel?.trim(),
    reasoningEffort: options.reasoningEffort?.trim(),
    reviewDepth: options.reviewDepth?.trim(),
  });

  const parts = [
    '--auto low',
    `--restrict-tools "${RESTRICTED_REVIEW_TOOLS.join(",")}"`,
    '--tag "code-review"',
  ];

  if (model) {
    parts.push(`--model "${model}"`);
  }
  if (reasoningEffort) {
    parts.push(`--reasoning-effort "${reasoningEffort}"`);
  }

  return parts.join(" ");
}

/** Persist the deterministic boundary for both candidate and validator passes. */
export function enableRestrictedReviewMode(): void {
  core.exportVariable("DROID_SAFE_REVIEW_MODE", "true");
  core.setOutput("mcp_tools", "");
}
