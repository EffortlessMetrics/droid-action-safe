const TRACKING_COMMENT_TOOL = "github_comment___update_droid_comment";
const SUBMIT_REVIEW_TOOL = "github_pr___submit_review";

type ReviewPhase = "candidate" | "validator";

export function isReadOnlyReviewEnabled(
  raw = process.env.READ_ONLY_REVIEW,
): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized || normalized === "false") {
    return false;
  }
  if (normalized === "true") {
    return true;
  }
  throw new Error("READ_ONLY_REVIEW must be 'true' or 'false'");
}

export function buildReviewTools({
  phase,
  normalizedUserArgs,
  userAllowedMCPTools,
  readOnly = isReadOnlyReviewEnabled(),
}: {
  phase: ReviewPhase;
  normalizedUserArgs: string;
  userAllowedMCPTools: string[];
  readOnly?: boolean;
}): string[] {
  if (readOnly && normalizedUserArgs.trim()) {
    throw new Error(
      "DROID_ARGS are not accepted when READ_ONLY_REVIEW=true; use the dedicated review model and reasoning inputs",
    );
  }

  const baseTools = readOnly
    ? ["Read", "Grep", "Glob", "LS", TRACKING_COMMENT_TOOL]
    : [
        "Read",
        "Grep",
        "Glob",
        "LS",
        "Execute",
        "Edit",
        "Create",
        "ApplyPatch",
        TRACKING_COMMENT_TOOL,
      ];

  const phaseTools =
    phase === "validator"
      ? [SUBMIT_REVIEW_TOOL]
      : readOnly
        ? ["Task", "Skill"]
        : ["Task", "FetchUrl", "Skill"];

  const safeUserAllowedMCPTools = readOnly
    ? userAllowedMCPTools.filter((tool) => tool === TRACKING_COMMENT_TOOL)
    : phase === "candidate"
      ? userAllowedMCPTools.filter(
          (tool) =>
            tool === TRACKING_COMMENT_TOOL ||
            (!tool.startsWith("github_pr___") &&
              tool !== "github_inline_comment___create_inline_comment"),
        )
      : userAllowedMCPTools;

  return Array.from(
    new Set([...baseTools, ...phaseTools, ...safeUserAllowedMCPTools]),
  );
}
