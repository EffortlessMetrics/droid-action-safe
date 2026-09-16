#!/usr/bin/env bun

import { readFile } from "fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CandidateDocumentSchema,
  ReviewStateSchema,
  ValidatedDocumentSchema,
} from "./schemas";
import {
  atomicJsonWrite,
  parseDiffAnchors,
  readLines,
  safeWorkspaceFile,
  validateCandidateDocument,
  validateValidatedDocument,
} from "./io";

const statePath = process.env.REVIEW_STATE_PATH;
if (!statePath) {
  throw new Error("REVIEW_STATE_PATH is required");
}

const state = ReviewStateSchema.parse(
  JSON.parse(await readFile(statePath, "utf8")),
);
const diffAnchors = parseDiffAnchors(await readFile(state.diffPath, "utf8"));

const server = new McpServer({
  name: "Isolated Review IO",
  version: "1.0.0",
});

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

server.tool(
  "read_artifact",
  "Read a bounded line range from the precomputed review artifacts.",
  {
    artifact: z.enum([
      "description",
      "diff",
      "existing_comments",
      "candidates",
    ]),
    start_line: z.number().int().positive().optional().default(1),
    max_lines: z.number().int().min(1).max(500).optional().default(300),
  },
  async ({ artifact, start_line, max_lines }) => {
    try {
      const artifacts = {
        description: state.descriptionPath,
        diff: state.diffPath,
        existing_comments: state.commentsPath,
        candidates: state.candidatesPath,
      } as const;
      return textResult(
        await readLines(artifacts[artifact], start_line, max_lines),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "read_repo_file",
  "Read a bounded line range from one regular file inside the authorized PR workspace. Symlinks and .git are rejected.",
  {
    path: z.string().min(1).max(512),
    start_line: z.number().int().positive().optional().default(1),
    max_lines: z.number().int().min(1).max(500).optional().default(300),
  },
  async ({ path: relativePath, start_line, max_lines }) => {
    try {
      const filePath = await safeWorkspaceFile(state.workspace, relativePath);
      return textResult(await readLines(filePath, start_line, max_lines));
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "write_candidates",
  "Validate and atomically write the complete candidate-review document to its fixed output path.",
  { payload: CandidateDocumentSchema },
  async ({ payload }) => {
    try {
      const document = CandidateDocumentSchema.parse(payload);
      validateCandidateDocument(state, document, diffAnchors);
      await atomicJsonWrite(state.candidatesPath, document);
      return textResult("candidate review document accepted");
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "write_validated",
  "Validate and atomically write the complete second-pass review decision document to its fixed output path.",
  { payload: ValidatedDocumentSchema },
  async ({ payload }) => {
    try {
      const candidates = CandidateDocumentSchema.parse(
        JSON.parse(await readFile(state.candidatesPath, "utf8")),
      );
      const document = ValidatedDocumentSchema.parse(payload);
      validateValidatedDocument(state, candidates, document, diffAnchors);
      await atomicJsonWrite(state.validatedPath, document);
      return textResult("validated review document accepted");
    } catch (error) {
      return errorResult(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
