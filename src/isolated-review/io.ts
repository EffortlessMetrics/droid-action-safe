import { lstat, readFile, realpath, rename, writeFile } from "fs/promises";
import path from "path";
import type {
  CandidateDocument,
  ReviewComment,
  ReviewState,
  ValidatedDocument,
} from "./schemas";
import { assertDocumentIdentity } from "./schemas";

export async function readLines(
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

export async function safeWorkspaceFile(
  workspace: string,
  relativePath: string,
): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new Error("repository paths must be relative");
  }
  const segments = relativePath.split(/[\\/]+/);
  if (segments.some((segment) => segment === ".." || segment === ".git")) {
    throw new Error("repository path is outside the review surface");
  }

  const root = await realpath(workspace);
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

export async function atomicJsonWrite(
  target: string,
  value: unknown,
): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, target);
}

export function sameAnchor(
  left: ReviewComment,
  right: ReviewComment,
): boolean {
  return (
    left.path === right.path &&
    left.line === right.line &&
    (left.startLine ?? null) === (right.startLine ?? null) &&
    left.side === right.side &&
    left.commit_id === right.commit_id
  );
}

export function validateCandidateDocument(
  state: ReviewState,
  document: CandidateDocument,
): void {
  assertDocumentIdentity(state, document.meta);
  for (const [index, comment] of document.comments.entries()) {
    if (comment.commit_id !== state.headSha) {
      throw new Error(
        `candidate comment ${index} is not anchored to the authorized head`,
      );
    }
    if (!/^\[P[0-2]\](?:\s|$)/.test(comment.body)) {
      throw new Error(
        `candidate comment ${index} must begin with [P0], [P1], or [P2]`,
      );
    }
  }
}

export function validateValidatedDocument(
  state: ReviewState,
  candidates: CandidateDocument,
  document: ValidatedDocument,
): void {
  validateCandidateDocument(state, candidates);
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
}
