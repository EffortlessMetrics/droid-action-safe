import * as core from "@actions/core";
import { checkContainsTrigger } from "../github/validation/trigger";
import { checkHumanActor } from "../github/validation/actor";
import { createInitialComment } from "../github/operations/comments/create-initial";
import {
  isEntityContext,
  isAutomationContext,
  type ParsedGitHubContext,
} from "../github/context";
import { readExpectedHeadSha } from "../github/validation/expected-head";
import { extractCommandFromContext } from "../github/utils/command-parser";
import { prepareFillMode } from "./commands/fill";
import { prepareReviewMode } from "./commands/review";
import { prepareSecurityReviewMode } from "./commands/security-review";
import { prepareSecurityScanMode } from "./commands/security-scan";
import type { GitHubContext } from "../github/context";
import type { PrepareResult } from "../prepare/types";
import type { Octokits } from "../github/api/client";

const DROID_APP_BOT_ID = 209825114;
const SECURITY_REVIEW_MARKER = "## Security Review Summary";

export function shouldTriggerTag(context: GitHubContext): boolean {
  if (
    isAutomationContext(context) &&
    context.inputs.securityScanSchedule &&
    (context.eventName === "schedule" ||
      context.eventName === "workflow_dispatch")
  ) {
    console.log(
      `Detected ${context.eventName} security scan schedule, triggering action`,
    );
    return true;
  }

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

export function shouldCheckExistingSecurityReview(
  rawExpectedHead = process.env.EXPECTED_HEAD_SHA,
): boolean {
  return readExpectedHeadSha(rawExpectedHead) === undefined;
}

async function hasExistingSecurityReview(
  octokit: Octokits,
  context: ParsedGitHubContext,
): Promise<boolean> {
  const { owner, repo } = context.repository;

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
      return isOurBot && comment.body?.includes(SECURITY_REVIEW_MARKER);
    });
  } catch (error) {
    console.warn("Failed to check for existing security review:", error);
    return false;
  }
}

async function existingSecurityReviewForLegacyInvocation(
  octokit: Octokits,
  context: ParsedGitHubContext,
): Promise<boolean> {
  if (!shouldCheckExistingSecurityReview()) {
    console.log(
      "Expected PR head supplied; running security review for this exact candidate",
    );
    return false;
  }
  return hasExistingSecurityReview(octokit, context);
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
  if (
    isAutomationContext(context) &&
    context.inputs.securityScanSchedule &&
    (context.eventName === "schedule" ||
      context.eventName === "workflow_dispatch")
  ) {
    return prepareSecurityScanMode({
      context,
      octokit,
      githubToken,
      scanScope: { type: "scheduled", days: context.inputs.securityScanDays },
    });
  }

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

    const hasExisting = await existingSecurityReviewForLegacyInvocation(
      octokit,
      context,
    );
    if (hasExisting) {
      console.log(
        "Security review already exists on this PR, skipping security",
      );
      runSecurityReview = false;
    }

    if (runSecurityReview) {
      core.exportVariable("SECURITY_REVIEW_ENABLED", "true");
      core.setOutput("install_security_skills", "true");
    }

    core.setOutput("run_code_review", "true");
    core.setOutput("run_security_review", runSecurityReview.toString());

    return prepareReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  if (context.inputs.automaticReview) {
    core.setOutput("run_code_review", "true");
    core.setOutput("run_security_review", "false");
    return prepareReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  if (context.inputs.automaticSecurityReview) {
    const hasExisting = await existingSecurityReviewForLegacyInvocation(
      octokit,
      context,
    );
    if (hasExisting) {
      console.log("Security review already exists on this PR, skipping");
      core.setOutput("run_code_review", "false");
      core.setOutput("run_security_review", "false");
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
    core.setOutput("run_security_review", "true");
    return prepareSecurityReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  if (commandContext?.command === "fill") {
    return prepareFillMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  if (commandContext?.command === "security") {
    core.setOutput("run_code_review", "true");
    core.setOutput("run_security_review", "true");
    return prepareSecurityReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  if (commandContext?.command === "security-full") {
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
    core.setOutput("run_security_review", "false");
    return prepareReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  throw new Error(`Unexpected command: ${commandContext?.command}`);
}
