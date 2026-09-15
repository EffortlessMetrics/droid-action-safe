#!/usr/bin/env bun

import { lstat, readFile, realpath, rename, writeFile } from "fs/promises";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CandidateDocumentSchema,
  ReviewStateSchema,
  ValidatedDocumentSchema,
  assertDocumentIdentity,
  type CandidateDocument,
  type ReviewComment,
  type ReviewState,
} from "./schemas";

const statePath = process.env.REVIEW_STATE_PATH;
if (!statePath) {
  throw new Error("REVIEW_STATE_PATH is required");
}

const state = ReviewStateSchema.parse(
  JSON.parse(await readFile(statePath, "utf8")),
);

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

async function readLines(
  filePath: string,
  startLine: number,
  maxLines: number,
): Promise<string> {
  const contents = await readFile(filePath, "utf8");
  if (contents.includes("\0")) {
    throw new Error("binary files are not available to the review model");
  }
  const lines = contents.split(/\r?\n/);
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, start + maxLines);
  return lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join("\n");
}

async function safeWorkspaceFile(relativePath: string): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new Error("repository paths must be relative");
  }
  const segments = relativePath.split(/[\\/]+/);
  if (segments.some((segment) => segment === ".." || segment === ".git")) {
    throw new Error("repository path is outside the review surface");
  }

  const root = await realpath(state.workspace);
  const requested = path.resolve(root, relativePath);
  const requestedStat = await lstat(requested);
  if (requestedStat.isSymbolicLink() || !requestedStat.isFile()) {
    throw new Error("repository path must name a regular non-symlink file");
  }
  if (requestedStat.size > 2_000_000) {
    throw new Error("repository file exceeds the 2 MB review limit");
  }

  const resolved = await realpath(requested);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("repository path escaped the authorized workspace");
  }
  return resolved;
}

async function atomicJsonWrite(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, target);
}

function sameAnchor(left: ReviewComment, right: ReviewComment): boolean {
  return (
    left.path === right.path &&
    left.line === right.line &&
    (left.startLine ?? null) === (right.startLine ?? null) &&
    left.side === right.side &&
    left.commit_id === right.commit_id
  );
}

function validateCandidateDocument(document: CandidateDocument): void {
  assertDocumentIdentity(state, document.meta);
  for (const comment of document.comments) {
    if (comment.commit_id !== state.headSha) {
      throw new Error("candidate comment is not anchored to the authorized head");
    }
    if (!/^\[P[0-2]\](?:\s|$)/.test(comment.body)) {
      throw new Error("candidate comment must begin with [P0], [P1], or [P2]");
    }
  }
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
      const artifacts: Record<typeof artifact, string> = {
        description: state.descriptionPath,
        diff: state.diffPath,
        existing_comments: state.commentsPath,
        candidates: state.candidatesPath,
      };
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
      const filePath = await safeWorkspaceFile(relativePath);
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
      validateCandidateDocument(document);
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
      validateCandidateDocument(candidates);

      const document = ValidatedDocumentSchema.parse(payload);
      assertDocumentIdentity(state, document.meta);
      if (document.results.length !== candidates.comments.length) {
        throw new Error(
          "validated result count must equal the candidate comment count",
        );
      }

      document.results.forEach((result, index) => {
        const candidate = candidates.comments[index];
        const reviewed =
          result.status === "approved" ? result.comment : result.candidate;
        if (!sameAnchor(candidate, reviewed)) {
          throw new Error(`validated result ${index} changed its diff anchor`);
        }
        if (result.status === "approved") {
          if (!/^\[P[0-2]\](?:\s|$)/.test(result.comment.body)) {
            throw new Error(
              `approved result ${index} must begin with a priority tag`,
            );
          }
        } else if (result.candidate.body !== candidate.body) {
          throw new Error(`rejected result ${index} changed the candidate body`);
        }
      });

      await atomicJsonWrite(state.validatedPath, document);
      return textResult("validated review document accepted");
    } catch (error) {
      return errorResult(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
