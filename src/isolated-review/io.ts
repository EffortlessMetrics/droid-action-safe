import {
  link,
  lstat,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "fs/promises";
import path from "path";
import type {
  CandidateDocument,
  ReviewComment,
  ReviewState,
  ValidatedDocument,
} from "./schemas";
import { assertDocumentIdentity } from "./schemas";

export type DiffAnchorSet = ReadonlySet<string>;

function diffAnchorKey(
  filePath: string,
  side: ReviewComment["side"],
  line: number,
): string {
  return `${filePath}\0${side}\0${line}`;
}

function decodeGitQuotedPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }

  const bytes: number[] = [];
  const body = value.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== "\\") {
      bytes.push(...Buffer.from(character));
      continue;
    }

    index += 1;
    if (index >= body.length) {
      throw new Error("unterminated escape in quoted diff path");
    }
    const escaped = body[index];
    const simple: Record<string, number> = {
      '"': 0x22,
      "\\": 0x5c,
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
    };
    if (escaped in simple) {
      bytes.push(simple[escaped]);
      continue;
    }

    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (
        octal.length < 3 &&
        index + 1 < body.length &&
        /[0-7]/.test(body[index + 1])
      ) {
        index += 1;
        octal += body[index];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }

    throw new Error(`unsupported escape in quoted diff path: \\${escaped}`);
  }
  return Buffer.from(bytes).toString("utf8");
}

function parseDiffPath(raw: string): string | null {
  const decoded = decodeGitQuotedPath(raw.trimEnd());
  if (decoded === "/dev/null") {
    return null;
  }
  if (decoded.startsWith("a/") || decoded.startsWith("b/")) {
    return decoded.slice(2);
  }
  return decoded;
}

export function parseDiffAnchors(diff: string): Set<string> {
  const anchors = new Set<string>();
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      oldPath = null;
      newPath = null;
      inHunk = false;
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      if (line.startsWith("--- ")) {
        oldPath = parseDiffPath(line.slice(4));
      } else if (line.startsWith("+++ ")) {
        newPath = parseDiffPath(line.slice(4));
      }
      continue;
    }

    if (line === "\\ No newline at end of file") {
      continue;
    }

    const canonicalPath = newPath ?? oldPath;
    if (!canonicalPath) {
      throw new Error("diff hunk has no canonical file path");
    }

    switch (line[0]) {
      case " ":
        if (oldPath) {
          anchors.add(diffAnchorKey(canonicalPath, "LEFT", oldLine));
        }
        if (newPath) {
          anchors.add(diffAnchorKey(canonicalPath, "RIGHT", newLine));
        }
        oldLine += 1;
        newLine += 1;
        break;
      case "-":
        if (oldPath) {
          anchors.add(diffAnchorKey(canonicalPath, "LEFT", oldLine));
        }
        oldLine += 1;
        break;
      case "+":
        if (newPath) {
          anchors.add(diffAnchorKey(canonicalPath, "RIGHT", newLine));
        }
        newLine += 1;
        break;
      default:
        inHunk = false;
        break;
    }
  }

  return anchors;
}

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
  try {
    // A hard-link publication is atomic and fails when the fixed output path
    // already exists. The model cannot revise an accepted document in place.
    await link(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function sameAnchor(left: ReviewComment, right: ReviewComment): boolean {
  return (
    left.path === right.path &&
    left.line === right.line &&
    (left.startLine ?? null) === (right.startLine ?? null) &&
    left.side === right.side &&
    left.commit_id === right.commit_id
  );
}

function validateDiffAnchor(
  anchors: DiffAnchorSet,
  comment: ReviewComment,
  label: string,
): void {
  const startLine = comment.startLine ?? comment.line;
  if (comment.line - startLine > 200) {
    throw new Error(`${label} range exceeds the 201-line review limit`);
  }
  for (let line = startLine; line <= comment.line; line += 1) {
    if (!anchors.has(diffAnchorKey(comment.path, comment.side, line))) {
      throw new Error(
        `${label} targets ${comment.path} ${comment.side} line ${line}, which is not present in the frozen diff`,
      );
    }
  }
}

export function validateCandidateDocument(
  state: ReviewState,
  document: CandidateDocument,
  anchors: DiffAnchorSet,
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
    validateDiffAnchor(anchors, comment, `candidate comment ${index}`);
  }
}

export function validateValidatedDocument(
  state: ReviewState,
  candidates: CandidateDocument,
  document: ValidatedDocument,
  anchors: DiffAnchorSet,
): void {
  validateCandidateDocument(state, candidates, anchors);
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
      validateDiffAnchor(anchors, result.comment, `approved result ${index}`);
    } else if (result.candidate.body !== candidate.body) {
      throw new Error(`rejected result ${index} changed the candidate body`);
    }
  });
}
