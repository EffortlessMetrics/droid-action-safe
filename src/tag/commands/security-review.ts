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
import { generateSecurityCandidatesPrompt } from "../../create-prompt/templates/security-review-prompt";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";
import {
  buildReviewTools,
  isReadOnlyReviewEnabled,
} from "./review-tools";

type SecurityReviewCommandOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  trackingCommentId?: number;
};

export async function prepareSecurityReviewMode({
  context,
  octokit,
  githubToken,
  trackingCommentId,
}: SecurityReviewCommandOptions): Promise<PrepareResult> {
  if (!isEntityContext(context)) {
    throw new Error("Security review command requires an entity event context");
  }

  if (!context.isPR) {
    throw new Error(
      "Security review command is only supported on pull requests",
    );
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
    console.log(`Checked out security-review head: ${checkedOutHead}`);
  } catch (error) {
    console.error(`Failed to checkout PR head: ${error}`);
    throw new Error(
      `Failed to checkout PR #${context.entityNumber} head for security review`,
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

  await createPrompt({
    githubContext: context,
    commentId,
    baseBranch: branchInfo.baseBranch,
    droidBranch: branchInfo.droidBranch,
    prBranchData: {
      headRefName: prData.headRefName,
      headRefOid: prData.headRefOid,
    },
    generatePrompt: generateSecurityCandidatesPrompt,
    reviewArtifacts,
  });
  core.exportVariable("DROID_EXEC_RUN_TYPE", "droid-security-review");
  core.setOutput("install_security_skills", "true");

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

  const securityModel =
    process.env.SECURITY_MODEL?.trim() || process.env.REVIEW_MODEL?.trim();
  if (securityModel) {
    droidArgParts.push(`--model "${securityModel}"`);
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
