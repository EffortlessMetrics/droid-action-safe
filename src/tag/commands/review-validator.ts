import * as core from "@actions/core";
import type { GitHubContext } from "../../github/context";
import { isEntityContext } from "../../github/context";
import type { Octokits } from "../../github/api/client";
import { fetchPRBranchData } from "../../github/data/pr-fetcher";
import { createPrompt } from "../../create-prompt";
import type { ReviewArtifacts } from "../../create-prompt/types";
import type { PrepareResult } from "../../prepare/types";
import { generateReviewValidatorPrompt } from "../../create-prompt/templates/review-validator-prompt";
import {
  buildRestrictedReviewArgs,
  enableRestrictedReviewMode,
} from "./review-safety";

export async function prepareReviewValidatorMode({
  context,
  octokit,
  trackingCommentId,
}: {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  trackingCommentId: number;
}): Promise<PrepareResult> {
  if (!isEntityContext(context) || !context.isPR) {
    throw new Error("review validator mode requires pull request context");
  }

  const prData = await fetchPRBranchData({
    octokits: octokit,
    repository: {
      owner: context.repository.owner,
      repo: context.repository.repo,
    },
    prNumber: context.entityNumber,
  });

  const tempDir = process.env.RUNNER_TEMP || "/tmp";
  const promptsDir = `${tempDir}/droid-prompts`;
  const reviewArtifacts: ReviewArtifacts = {
    diffPath: `${promptsDir}/pr.diff`,
    commentsPath: `${promptsDir}/existing_comments.json`,
    descriptionPath: `${promptsDir}/pr_description.txt`,
  };

  const includeSuggestions = process.env.INCLUDE_SUGGESTIONS !== "false";

  await createPrompt({
    githubContext: context,
    commentId: trackingCommentId,
    baseBranch: prData.baseRefName,
    droidBranch: prData.headRefName,
    prBranchData: {
      headRefName: prData.headRefName,
      headRefOid: prData.headRefOid,
    },
    generatePrompt: generateReviewValidatorPrompt,
    reviewArtifacts,
    includeSuggestions,
  });

  core.exportVariable("DROID_EXEC_RUN_TYPE", "droid-review");
  enableRestrictedReviewMode();

  const droidArgs = buildRestrictedReviewArgs({
    reviewModel: process.env.REVIEW_MODEL,
    reasoningEffort: process.env.REASONING_EFFORT,
    reviewDepth: process.env.REVIEW_DEPTH,
  });

  core.setOutput("droid_args", droidArgs);
  core.setOutput("mcp_tools", "");
  core.setOutput("review_pr_number", context.entityNumber.toString());
  core.setOutput("review_head_sha", prData.headRefOid);
  core.setOutput("droid_comment_id", trackingCommentId.toString());

  return {
    commentId: trackingCommentId,
    branchInfo: {
      baseBranch: prData.baseRefName,
      droidBranch: prData.headRefName,
      currentBranch: prData.headRefName,
    },
    mcpTools: "",
  };
}
