#!/usr/bin/env bun

import * as core from "@actions/core";
import { execFileSync } from "child_process";
import { chmod, mkdir, writeFile } from "fs/promises";
import path from "path";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { fetchPRBranchData } from "../github/data/pr-fetcher";
import { computeReviewArtifacts } from "../github/data/review-artifacts";
import { createInitialComment } from "../github/operations/comments/create-initial";
import { checkWritePermissions } from "../github/validation/permissions";
import { extractCommandFromContext } from "../github/utils/command-parser";
import { candidatePrompt } from "./prompts";
import { ReviewStateSchema, type ReviewState } from "./schemas";

const FULL_SHA = /^[0-9a-f]{40}$/;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function main(): Promise<void> {
  const token = required("GITHUB_TOKEN");
  const expectedHead = required("EXPECTED_HEAD_SHA").toLowerCase();
  if (!FULL_SHA.test(expectedHead)) {
    throw new Error("EXPECTED_HEAD_SHA must be a full lowercase commit SHA");
  }
  core.setSecret(token);

  const context = parseGitHubContext();
  if (!isEntityContext(context) || !context.isPR) {
    throw new Error("isolated review requires a pull-request event context");
  }
  const sender = (context.payload as { sender?: { type?: string } }).sender;
  if (sender?.type !== "User" || context.actor.endsWith("[bot]")) {
    throw new Error("isolated review accepts explicit human requests only");
  }
  const command = extractCommandFromContext(context);
  if (!command || !["review", "default"].includes(command.command)) {
    throw new Error(
      "the isolated lane supports only bare @droid and @droid review",
    );
  }

  const clients = createOctokit(token);
  const authorized = await checkWritePermissions(
    clients.rest,
    context,
    "",
    true,
  );
  if (!authorized) {
    throw new Error("actor does not currently have write permission");
  }

  const { owner, repo } = context.repository;
  const response = await clients.rest.rest.pulls.get({
    owner,
    repo,
    pull_number: context.entityNumber,
  });
  const pull = response.data;
  if (pull.state !== "open") {
    throw new Error("isolated review requires an open pull request");
  }
  if (pull.head.repo?.full_name !== `${owner}/${repo}`) {
    throw new Error("isolated review refuses fork pull requests");
  }
  if (pull.head.sha.toLowerCase() !== expectedHead) {
    throw new Error(
      `PR head changed: expected ${expectedHead}, current ${pull.head.sha}`,
    );
  }

  const workspace = required("GITHUB_WORKSPACE");
  const localHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  })
    .trim()
    .toLowerCase();
  if (localHead !== expectedHead) {
    throw new Error(
      `checkout mismatch: expected ${expectedHead}, current ${localHead}`,
    );
  }

  const prData = await fetchPRBranchData({
    octokits: clients,
    repository: context.repository,
    prNumber: context.entityNumber,
  });
  if (prData.headRefOid.toLowerCase() !== expectedHead) {
    throw new Error("GraphQL PR head does not match the authorized head");
  }

  const trackingComment = await createInitialComment(clients.rest, context);
  const runnerTemp = required("RUNNER_TEMP");
  const root = path.join(runnerTemp, "droid-isolated-review");
  const promptsDir = path.join(root, "artifacts");
  const isolatedCwd = path.join(root, "empty-cwd");
  await mkdir(promptsDir, { recursive: true, mode: 0o700 });
  await mkdir(isolatedCwd, { recursive: true, mode: 0o700 });

  const artifacts = await computeReviewArtifacts({
    baseRef: prData.baseRefName,
    tempDir: root,
    octokit: clients,
    owner,
    repo,
    prNumber: context.entityNumber,
    title: prData.title,
    body: prData.body,
    githubToken: token,
  });

  const actionPath = required("GITHUB_ACTION_PATH");
  const actionRoot = path.resolve(actionPath, "..");
  const statePath = path.join(root, "state.json");
  const candidatesPath = path.join(promptsDir, "review-candidates.json");
  const validatedPath = path.join(promptsDir, "review-validated.json");
  const candidatePromptPath = path.join(promptsDir, "candidate-prompt.md");
  const validatorPromptPath = path.join(promptsDir, "validator-prompt.md");

  const state: ReviewState = ReviewStateSchema.parse({
    repository: `${owner}/${repo}`,
    owner,
    repo,
    prNumber: context.entityNumber,
    headSha: expectedHead,
    headRef: prData.headRefName,
    baseRef: prData.baseRefName,
    workspace,
    promptsDir,
    isolatedCwd,
    descriptionPath: artifacts.descriptionPath,
    diffPath: artifacts.diffPath,
    commentsPath: artifacts.commentsPath,
    candidatesPath,
    validatedPath,
    candidatePromptPath,
    validatorPromptPath,
    trackingCommentId: trackingComment.id,
    eventName: context.eventName,
  });

  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(candidatePromptPath, candidatePrompt(state), {
    mode: 0o600,
  });

  const wrapperPath = path.join(root, "review-io.sh");
  const serverPath = path.join(
    actionRoot,
    "src",
    "isolated-review",
    "review-io-server.ts",
  );
  const safePath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const wrapper = `#!/usr/bin/env bash\nset -euo pipefail\nexec env -i PATH=${shellQuote(safePath)} HOME=${shellQuote(isolatedCwd)} REVIEW_STATE_PATH=${shellQuote(statePath)} bun run ${shellQuote(serverPath)}\n`;
  await writeFile(wrapperPath, wrapper, { mode: 0o700 });
  await chmod(wrapperPath, 0o700);

  core.setOutput("state_path", statePath);
  core.setOutput("wrapper_path", wrapperPath);
  core.setOutput("tracking_comment_id", trackingComment.id.toString());
  core.setOutput("candidate_prompt_path", candidatePromptPath);
  core.setOutput("validator_prompt_path", validatorPromptPath);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(`isolated review preparation failed: ${message}`);
  process.exitCode = 1;
});
