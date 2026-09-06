#!/usr/bin/env bun

/**
 * Prepare the Droid action by checking trigger conditions, verifying human actor,
 * and creating the initial tracking comment
 */

import * as core from "@actions/core";
import { setupGitHubToken } from "../github/token";
import { checkWritePermissions } from "../github/validation/permissions";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { shouldTriggerTag } from "../tag";
import { prepare } from "../prepare";
import { collectActionInputsPresence } from "./collect-inputs";

async function run() {
  try {
    collectActionInputsPresence();

    // Preserve the caller's immutable review identity for all later composite
    // steps. This is written through GITHUB_ENV by @actions/core rather than
    // re-reading mutable pull-request metadata after the model run.
    core.exportVariable(
      "EXPECTED_HEAD_SHA",
      process.env.EXPECTED_HEAD_SHA?.trim().toLowerCase() ?? "",
    );

    // Parse GitHub context first to enable mode detection
    const context = parseGitHubContext();

    // Setup GitHub token
    const githubToken = await setupGitHubToken();
    const octokit = createOctokit(githubToken);

    // Step 3: Check write permissions (only for entity contexts)
    if (isEntityContext(context)) {
      const githubTokenProvided = !!process.env.OVERRIDE_GITHUB_TOKEN;
      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        githubTokenProvided,
      );
      if (!hasWritePermissions) {
        throw new Error(
          "Actor does not have write permissions to the repository",
        );
      }
    }

    // Check trigger conditions
    const containsTrigger = shouldTriggerTag(context);

    console.log(`Trigger result: ${containsTrigger}`);
    core.setOutput("contains_trigger", containsTrigger.toString());

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      core.setOutput("github_token", githubToken);
      return;
    }

    const result = await prepare({
      context,
      octokit,
      githubToken,
    });

    core.setOutput("github_token", githubToken);

    if (result?.mcpTools) {
      core.setOutput("mcp_tools", result.mcpTools);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Prepare step failed with error: ${errorMessage}`);
    core.setOutput("prepare_error", errorMessage);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
