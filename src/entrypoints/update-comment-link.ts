#!/usr/bin/env bun

import { createOctokit } from "../github/api/client";
import * as fs from "fs/promises";
import {
  updateCommentBody,
  type CommentUpdateInput,
} from "../github/operations/comment-logic";
import {
  parseGitHubContext,
  isPullRequestReviewCommentEvent,
  isEntityContext,
} from "../github/context";
import { GITHUB_SERVER_URL } from "../github/api/config";

import { updateDroidComment } from "../github/operations/comments/update-droid-comment";
import { fetchDroidComment } from "../github/operations/comments/fetch-droid-comment";

async function run() {
  try {
    const commentId = parseInt(process.env.DROID_COMMENT_ID!);
    const githubToken = process.env.GITHUB_TOKEN!;
    const triggerUsername = process.env.TRIGGER_USERNAME;

    const context = parseGitHubContext();

    if (!isEntityContext(context)) {
      throw new Error("update-comment-link requires an entity context");
    }

    const { owner, repo } = context.repository;
    const octokit = createOctokit(githubToken);
    const serverUrl = GITHUB_SERVER_URL;
    const jobUrl = `${serverUrl}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;

    let comment;
    let isPRReviewComment = false;

    try {
      const result = await fetchDroidComment(octokit, {
        owner,
        repo,
        commentId,
        isPullRequestReviewCommentEvent:
          isPullRequestReviewCommentEvent(context),
      });
      comment = result.comment;
      isPRReviewComment = result.isPRReviewComment;
    } catch (finalError) {
      const is404 =
        finalError instanceof Error &&
        "status" in finalError &&
        (finalError as { status: number }).status === 404;

      if (is404) {
        console.log(
          `⚠️ Comment ${commentId} no longer exists (404). Skipping update.`,
        );
        console.log(
          "This can happen if the comment was deleted by a user, spam filter, or another automation.",
        );
        process.exit(0);
      }

      console.error("Failed to fetch comment. Debug info:");
      console.error(`Comment ID: ${commentId}`);
      console.error(`Event name: ${context.eventName}`);
      console.error(`Entity number: ${context.entityNumber}`);
      console.error(`Repository: ${context.repository.full_name}`);

      try {
        const { data: pr } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: context.entityNumber,
        });
        console.log(`PR state: ${pr.state}`);
        console.log(`PR comments count: ${pr.comments}`);
        console.log(`PR review comments count: ${pr.review_comments}`);
      } catch {
        console.error("Could not fetch PR info for debugging");
      }

      throw finalError;
    }

    const currentBody = comment.body ?? "";
    const branchLink = "";
    const prLink = "";

    let executionDetails: {
      cost_usd?: number;
      duration_ms?: number;
      duration_api_ms?: number;
    } | null = null;
    let actionFailed = false;
    let errorDetails: string | undefined;

    const prepareSuccess = process.env.PREPARE_SUCCESS !== "false";
    const prepareError = process.env.PREPARE_ERROR;

    if (!prepareSuccess && prepareError) {
      actionFailed = true;
      errorDetails = prepareError;
    } else {
      try {
        const outputFile = process.env.OUTPUT_FILE;
        if (outputFile) {
          const fileContent = await fs.readFile(outputFile, "utf8");
          const outputData = JSON.parse(fileContent);

          if (Array.isArray(outputData) && outputData.length > 0) {
            const lastElement = outputData[outputData.length - 1];
            if (
              lastElement.type === "result" &&
              "cost_usd" in lastElement &&
              "duration_ms" in lastElement
            ) {
              executionDetails = {
                cost_usd: lastElement.cost_usd,
                duration_ms: lastElement.duration_ms,
                duration_api_ms: lastElement.duration_api_ms,
              };
            }
          }
        }

        const droidSuccess = process.env.DROID_SUCCESS !== "false";
        actionFailed = !droidSuccess;
      } catch (error) {
        console.error("Error reading output file:", error);
        actionFailed = process.env.DROID_SUCCESS === "false";
      }
    }

    // A security completion marker is evidence, so write it only after the
    // requested security path completed successfully. Do not infer completion
    // merely because automatic_security_review was configured on the caller.
    const securityReviewRan =
      !actionFailed && process.env.RUN_SECURITY_REVIEW === "true";

    const commentInput: CommentUpdateInput = {
      currentBody,
      actionFailed,
      executionDetails,
      jobUrl,
      branchLink,
      prLink,
      branchName: undefined,
      triggerUsername,
      errorDetails,
      securityReviewRan,
      securityReviewHeadSha: securityReviewRan
        ? process.env.EXPECTED_HEAD_SHA
        : undefined,
    };

    const updatedBody = updateCommentBody(commentInput);

    try {
      await updateDroidComment(octokit.rest, {
        owner,
        repo,
        commentId,
        body: updatedBody,
        isPullRequestReviewComment: isPRReviewComment,
      });
      console.log(
        `✅ Updated ${isPRReviewComment ? "PR review" : "issue"} comment ${commentId} with job link`,
      );
    } catch (updateError) {
      console.error(
        `Failed to update ${isPRReviewComment ? "PR review" : "issue"} comment:`,
        updateError,
      );
      throw updateError;
    }

    process.exit(0);
  } catch (error) {
    console.error("Error updating comment with job link:", error);
    process.exit(1);
  }
}

run();
