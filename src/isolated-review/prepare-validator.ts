#!/usr/bin/env bun

import * as core from "@actions/core";
import { readFile, writeFile } from "fs/promises";
import { CandidateDocumentSchema, ReviewStateSchema } from "./schemas";
import { validateCandidateDocument } from "./io";
import { validatorPrompt } from "./prompts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const statePath = required("REVIEW_STATE_PATH");
  const state = ReviewStateSchema.parse(
    JSON.parse(await readFile(statePath, "utf8")),
  );
  const candidates = CandidateDocumentSchema.parse(
    JSON.parse(await readFile(state.candidatesPath, "utf8")),
  );
  validateCandidateDocument(state, candidates);

  await writeFile(state.validatorPromptPath, validatorPrompt(state), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  core.setOutput("validator_prompt_path", state.validatorPromptPath);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(`isolated validator preparation failed: ${message}`);
  process.exitCode = 1;
});
