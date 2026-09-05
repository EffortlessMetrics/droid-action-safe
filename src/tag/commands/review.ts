import * as core from "@actions/core";
import { checkoutPullRequestHead } from "../../github/validation/expected-head";
import type { GitHubContext } from "../../github/context";
import { fetchPRBranchData } from "../../github/data/pr-fetcher";
import { computeReviewArtifacts } from "../../github/data/review-artifacts";
import { createPrompt } from "../../create-prompt";
import { prepareMcpTools } from "../../mcp/install-mcp-server";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { normalizeDroidArgs, parseAllowedTools } from "../../utils/parse-tools";
import { isEntityContext } from "../../github/context";
import { generateReviewCandidatesPrompt } from "../../create-prompt/templates/review-candidates-prompt";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";
import { resolveReviewConfig } from "../../utils/review-depth";
import {
  buildReviewTools,
  isReadOnlyReviewEnabled,
} from "./review-tools";

type ReviewCommandOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  trackingCommentId?: number;
};

export async function prepareReviewMode({
  context,
  octokit,
  githubToken,
  trackingCommentId,
}: ReviewCommandOptions): Promise<PrepareResult> {
  if (!isEntityContext(context)) {
    throw new Error("Review command requires an entity event context");
  }

  if (!context.isPR) {
    throw new Error("Review command is only supported on pull requests");
  }

  const commentId =
    trackingCommentId ?? (await createInitialComment(octokit.rest, context)).id;

  const prData = await fetchPRBranchData({
    octokits: octokit,
    repository: context.repository,
    prNumber: context.entityNumber,
  });

  const branchInfo = {
    baseBranch: prData.baseRefName,
    droidBranch: undefined,
    currentBranch: prData.headRefName,
  };

  console.log(
    `Checking out PR #${context.entityNumber} head for diff computation...`,
  );
  try {
    const checkedOutHead = checkoutPullRequestHead({
      prData,
      prNumber: context.entityNumber,
      githubToken,
    });
    console.log(`Checked out review head: ${checkedOutHead}`);
  } catch (error) {
    console.error(`Failed to checkout PR head: ${error}`);
    throw new Error(
      `Failed to checkout PR #${context.entityNumber} head for review`,
    );
  }

  const tempDir = process.env.RUNNER_TEMP || "/tmp";
  const reviewArtifacts = await computeReviewArtifacts({
    baseRef: prData.baseRefName,
    tempDir,
    octokit,
    owner: context.repository.owner,
    repo: context.repository.repo,
    prNumber: context.entityNumber,
    title: prData.title,
    body: prData.body,
    githubToken,
  });

  const includeSuggestions = process.env.INCLUDE_SUGGESTIONS !== "false";

  await createPrompt({
    githubContext: context,
    commentId,
    baseBranch: branchInfo.baseBranch,
    droidBranch: branchInfo.droidBranch,
    prBranchData: {
      headRefName: prData.headRefName,
      headRefOid: prData.headRefOid,
    },
    generatePrompt: generateReviewCandidatesPrompt,
    reviewArtifacts,
    includeSuggestions,
  });
  core.exportVariable("DROID_EXEC_RUN_TYPE", "droid-review");

  const rawUserArgs = process.env.DROID_ARGS || "";
  const normalizedUserArgs = normalizeDroidArgs(rawUserArgs);
  const userAllowedMCPTools = parseAllowedTools(normalizedUserArgs).filter(
    (tool) => tool.startsWith("github_") && tool.includes("___"),
  );
  const readOnly = isReadOnlyReviewEnabled();
  const allowedTools = buildReviewTools({
    phase: "candidate",
    normalizedUserArgs,
    userAllowedMCPTools,
    readOnly,
  });

  const mcpTools = await prepareMcpTools({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    droidCommentId: commentId.toString(),
    allowedTools,
    mode: "tag",
    context,
  });

  const droidArgParts: string[] = [];
  droidArgParts.push(`--enabled-tools "${allowedTools.join(",")}"`);
  droidArgParts.push('--tag "code-review"');

  const { model, reasoningEffort } = resolveReviewConfig({
    reviewModel: process.env.REVIEW_MODEL?.trim(),
    reasoningEffort: process.env.REASONING_EFFORT?.trim(),
    reviewDepth: process.env.REVIEW_DEPTH?.trim(),
  });

  if (model) {
    droidArgParts.push(`--model "${model}"`);
  }
  if (reasoningEffort) {
    droidArgParts.push(`--reasoning-effort "${reasoningEffort}"`);
  }

  if (normalizedUserArgs && !readOnly) {
    droidArgParts.push(normalizedUserArgs);
  }

  core.setOutput("droid_args", droidArgParts.join(" ").trim());
  core.setOutput("mcp_tools", mcpTools);
  core.setOutput("review_pr_number", context.entityNumber.toString());
  core.setOutput("droid_comment_id", commentId.toString());

  return {
    commentId,
    branchInfo,
    mcpTools,
  };
}
