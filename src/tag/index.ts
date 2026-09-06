import * as core from "@actions/core";
import { checkContainsTrigger } from "../github/validation/trigger";
import { checkHumanActor } from "../github/validation/actor";
import { createInitialComment } from "../github/operations/comments/create-initial";
import { isEntityContext, type ParsedGitHubContext } from "../github/context";
import { extractCommandFromContext } from "../github/utils/command-parser";
import { readExpectedHeadSha } from "../github/validation/expected-head";
import { prepareFillMode } from "./commands/fill";
import { prepareReviewMode } from "./commands/review";
import { prepareSecurityReviewMode } from "./commands/security-review";
import { prepareSecurityScanMode } from "./commands/security-scan";
import type { GitHubContext } from "../github/context";
import type { PrepareResult } from "../prepare/types";
import type { Octokits } from "../github/api/client";

const DROID_APP_BOT_ID = 209825114;
const SECURITY_REVIEW_MARKER = "## Security Review Summary";
export const SECURITY_REVIEW_HEAD_MARKER_PREFIX = "<!-- droid-security-head:";

export function securityReviewMarker(
  expectedHeadSha = readExpectedHeadSha(),
): string {
  return expectedHeadSha
    ? `${SECURITY_REVIEW_HEAD_MARKER_PREFIX}${expectedHeadSha} -->`
    : SECURITY_REVIEW_MARKER;
}

function setSecurityReviewDecision(runSecurityReview: boolean): void {
  const value = runSecurityReview.toString();
  core.setOutput("run_security_review", value);
  // Persist the decision to later composite steps. Completion evidence should
  // describe what actually ran, not merely what the caller requested.
  core.exportVariable("RUN_SECURITY_REVIEW", value);
}

export function shouldTriggerTag(context: GitHubContext): boolean {
  if (!isEntityContext(context)) {
    return false;
  }
  if (
    context.inputs.automaticReview ||
    context.inputs.automaticSecurityReview
  ) {
    return context.isPR;
  }
  return checkContainsTrigger(context);
}

/**
 * Checks whether automatic security review has already completed for the
 * invocation's expected PR head. When no expected head is supplied, preserve
 * the historical run-once-per-PR behavior for compatibility.
 */
async function hasExistingSecurityReview(
  octokit: Octokits,
  context: ParsedGitHubContext,
): Promise<boolean> {
  const { owner, repo } = context.repository;
  const marker = securityReviewMarker();

  try {
    const comments = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: context.entityNumber,
      per_page: 100,
    });

    return comments.data.some((comment) => {
      const isOurBot =
        comment.user?.id === DROID_APP_BOT_ID ||
        (comment.user?.type === "Bot" &&
          comment.user?.login.toLowerCase().includes("droid"));
      return isOurBot && comment.body?.includes(marker);
    });
  } catch (error) {
    console.warn("Failed to check for existing security review:", error);
    return false;
  }
}

type PrepareTagOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
};

export async function prepareTagExecution({
  context,
  octokit,
  githubToken,
}: PrepareTagOptions): Promise<PrepareResult> {
  if (!isEntityContext(context)) {
    throw new Error("Tag execution requires entity context");
  }

  await checkHumanActor(octokit.rest, context);

  if (context.inputs.automaticReview && !context.isPR) {
    throw new Error("automatic_review requires a pull request context");
  }

  if (context.inputs.automaticSecurityReview && !context.isPR) {
    throw new Error(
      "automatic_security_review requires a pull request context",
    );
  }

  const commandContext = extractCommandFromContext(context);

  const isDualReview =
    context.inputs.automaticReview && context.inputs.automaticSecurityReview;
  const isSecurityOnly =
    !isDualReview &&
    (context.inputs.automaticSecurityReview ||
      commandContext?.command === "security" ||
      commandContext?.command === "security-full");

  const commentType = isDualReview
    ? "review_and_security"
    : isSecurityOnly
      ? "security"
      : "default";

  const commentData = await createInitialComment(
    octokit.rest,
    context,
    commentType,
  );
  const commentId = commentData.id;

  if (
    context.inputs.automaticReview &&
    context.inputs.automaticSecurityReview
  ) {
    let runSecurityReview = true;

    const hasExisting = await hasExistingSecurityReview(octokit, context);
    if (hasExisting) {
      console.log(
        "Security review already exists for this review scope, skipping security",
      );
      runSecurityReview = false;
    }

    if (runSecurityReview) {
      core.exportVariable("SECURITY_REVIEW_ENABLED", "true");
      core.setOutput("install_security_skills", "true");
    }

    core.setOutput("run_code_review", "true");
    setSecurityReviewDecision(runSecurityReview);

    return prepareReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  if (context.inputs.automaticReview) {
    core.setOutput("run_code_review", "true");
    setSecurityReviewDecision(false);
    return prepareReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  if (context.inputs.automaticSecurityReview) {
    const hasExisting = await hasExistingSecurityReview(octokit, context);
    if (hasExisting) {
      console.log(
        "Security review already exists for this review scope, skipping",
      );
      core.setOutput("run_code_review", "false");
      setSecurityReviewDecision(false);
      return {
        skipped: true,
        reason: "security_review_exists",
        branchInfo: {
          baseBranch: "",
          currentBranch: "",
        },
        mcpTools: "",
      };
    }

    core.setOutput("run_code_review", "true");
    setSecurityReviewDecision(true);
    return prepareSecurityReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  if (commandContext?.command === "fill") {
    setSecurityReviewDecision(false);
    return prepareFillMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  if (commandContext?.command === "security") {
    core.setOutput("run_code_review", "true");
    setSecurityReviewDecision(true);
    return prepareSecurityReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  if (commandContext?.command === "security-full") {
    // Full-repository scan reporting has a separate artifact/report contract;
    // it must not mint a PR-head automatic-review completion marker.
    setSecurityReviewDecision(false);
    return prepareSecurityScanMode({
      context,
      octokit,
      githubToken,
      scanScope: { type: "full" },
    });
  }

  if (
    commandContext?.command === "review" ||
    !commandContext ||
    commandContext.command === "default"
  ) {
    core.setOutput("run_code_review", "true");
    setSecurityReviewDecision(false);
    return prepareReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  setSecurityReviewDecision(false);
  throw new Error(`Unexpected command: ${commandContext?.command}`);
}
