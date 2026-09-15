#!/usr/bin/env bun

import * as core from "@actions/core";
import { readFile } from "fs/promises";
import { createOctokit } from "../github/api/client";
import { updateDroidComment } from "../github/operations/comments/update-droid-comment";
import { sanitizeContent } from "../github/utils/sanitizer";
import {
  CandidateDocumentSchema,
  ReviewStateSchema,
  ValidatedDocumentSchema,
} from "./schemas";
import { validateValidatedDocument } from "./io";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safePublishedText(value: string): string {
  const withoutImages = sanitizeContent(value)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image removed]")
    .replace(/<img\b[^>]*>/gi, "[image removed]")
    .trim();
  return withoutImages.replace(/@(?=[A-Za-z0-9_-])/g, "@\u200B");
}

async function main(): Promise<void> {
  const token = required("GITHUB_TOKEN");
  core.setSecret(token);
  const state = ReviewStateSchema.parse(
    JSON.parse(await readFile(required("REVIEW_STATE_PATH"), "utf8")),
  );
  const candidates = CandidateDocumentSchema.parse(
    JSON.parse(await readFile(state.candidatesPath, "utf8")),
  );
  const validated = ValidatedDocumentSchema.parse(
    JSON.parse(await readFile(state.validatedPath, "utf8")),
  );
  validateValidatedDocument(state, candidates, validated);

  const approved = validated.results.flatMap((result, index) => {
    if (result.status !== "approved") return [];

    const body = safePublishedText(result.comment.body);
    if (!/^\[P[0-2]\](?:\s|$)/.test(body)) {
      throw new Error(`approved result ${index} lost its priority tag`);
    }
    return [
      {
        path: result.comment.path,
        body,
        line: result.comment.line,
        side: result.comment.side,
        ...(result.comment.startLine
          ? {
              start_line: result.comment.startLine,
              start_side: result.comment.side,
            }
          : {}),
      },
    ];
  });

  const clients = createOctokit(token);
  const current = await clients.rest.rest.pulls.get({
    owner: state.owner,
    repo: state.repo,
    pull_number: state.prNumber,
  });
  if (
    current.data.state !== "open" ||
    current.data.head.repo?.full_name !== state.repository ||
    current.data.head.sha.toLowerCase() !== state.headSha
  ) {
    throw new Error(
      `refusing publication after PR head changed from ${state.headSha}`,
    );
  }

  const existing = await clients.rest.paginate(
    clients.rest.rest.pulls.listReviewComments,
    {
      owner: state.owner,
      repo: state.repo,
      pull_number: state.prNumber,
      per_page: 100,
    },
  );
  const pending = approved.filter(
    (comment) =>
      !existing.some(
        (prior) =>
          prior.commit_id?.toLowerCase() === state.headSha &&
          prior.path === comment.path &&
          prior.line === comment.line &&
          prior.body === comment.body,
      ),
  );

  if (pending.length > 0) {
    await clients.rest.rest.pulls.createReview({
      owner: state.owner,
      repo: state.repo,
      pull_number: state.prNumber,
      commit_id: state.headSha,
      event: "COMMENT",
      comments: pending,
    });
  }

  const summary = safePublishedText(validated.reviewSummary.body);
  if (!summary) throw new Error("validated review summary became empty");
  const rejected = validated.results.length - approved.length;
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${state.repository}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
  const publication =
    approved.length === 0
      ? "No actionable findings survived independent validation."
      : `${approved.length} actionable finding(s) survived validation; ${pending.length} new inline comment(s) were published.`;
  const trackingBody = [
    "## Droid isolated review",
    "",
    publication,
    "",
    summary,
    "",
    `- Exact head: \`${state.headSha}\``,
    `- Candidates: ${candidates.comments.length}`,
    `- Approved: ${approved.length}`,
    `- Rejected: ${rejected}`,
    `- [Workflow run](${runUrl})`,
  ].join("\n");

  await updateDroidComment(clients.rest, {
    owner: state.owner,
    repo: state.repo,
    commentId: state.trackingCommentId,
    body: trackingBody,
    isPullRequestReviewComment:
      state.eventName === "pull_request_review_comment",
  });

  core.setOutput("approved_comments", approved.length.toString());
  core.setOutput("published_comments", pending.length.toString());
  core.info(
    `Published ${pending.length} new comment(s); ${approved.length} approved, ${rejected} rejected.`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(`isolated review publication failed: ${message}`);
  process.exitCode = 1;
});
