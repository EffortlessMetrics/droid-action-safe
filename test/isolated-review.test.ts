import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import type { Octokits } from "../src/github/api/client";
import { fetchAndStoreComments } from "../src/github/data/review-artifacts";
import {
  atomicJsonWrite,
  parseDiffAnchors,
  safeWorkspaceFile,
  validateCandidateDocument,
  validateValidatedDocument,
} from "../src/isolated-review/io";
import {
  CandidateDocumentSchema,
  ReviewStateSchema,
  ValidatedDocumentSchema,
  type CandidateDocument,
  type ReviewComment,
} from "../src/isolated-review/schemas";

const HEAD = "a".repeat(40);
const ROOT = path.resolve(import.meta.dir, "..");
const DIFF = `diff --git a/src/lib.ts b/src/lib.ts
index 1111111..2222222 100644
--- a/src/lib.ts
+++ b/src/lib.ts
@@ -8,3 +8,4 @@
 context
-old value
+new value
+another value
 context
`;
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "droid-isolated-review-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function stateFixture(root: string) {
  return ReviewStateSchema.parse({
    repository: "EffortlessMetrics/example",
    owner: "EffortlessMetrics",
    repo: "example",
    prNumber: 42,
    headSha: HEAD,
    headRef: "feature/review",
    baseRef: "main",
    workspace: path.join(root, "workspace"),
    promptsDir: path.join(root, "artifacts"),
    isolatedCwd: path.join(root, "empty"),
    descriptionPath: path.join(root, "description.txt"),
    diffPath: path.join(root, "diff.txt"),
    commentsPath: path.join(root, "comments.json"),
    candidatesPath: path.join(root, "candidates.json"),
    validatedPath: path.join(root, "validated.json"),
    candidatePromptPath: path.join(root, "candidate.md"),
    validatorPromptPath: path.join(root, "validator.md"),
    trackingCommentId: 123,
    eventName: "pull_request_review",
  });
}

function candidateFixture(): CandidateDocument {
  return CandidateDocumentSchema.parse({
    version: 1,
    meta: {
      repo: "EffortlessMetrics/example",
      prNumber: 42,
      headSha: HEAD,
      baseRef: "main",
      generatedAt: "2026-09-15T20:00:00Z",
    },
    comments: [
      {
        path: "src/lib.ts",
        body: "[P1] Real failure\n\nThe changed branch returns the wrong value.",
        line: 10,
        startLine: null,
        side: "RIGHT",
        commit_id: HEAD,
      },
    ],
    reviewSummary: { body: "One candidate survived the first pass." },
  });
}

function firstComment(document: CandidateDocument): ReviewComment {
  const comment = document.comments[0];
  if (!comment) throw new Error("fixture candidate is missing its first comment");
  return comment;
}

function validatedFixture() {
  return ValidatedDocumentSchema.parse({
    version: 1,
    meta: {
      repo: "EffortlessMetrics/example",
      prNumber: 42,
      headSha: HEAD,
      baseRef: "main",
      validatedAt: "2026-09-15T20:01:00Z",
    },
    results: [{ status: "approved", comment: firstComment(candidateFixture()) }],
    reviewSummary: {
      status: "approved",
      body: "The candidate was reproduced in a separate pass.",
    },
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("isolated review document contracts", () => {
  it("rejects traversal, stale commits, and anchors absent from the diff", async () => {
    const state = stateFixture(await temporaryDirectory());
    const anchors = parseDiffAnchors(DIFF);

    const traversal = candidateFixture();
    firstComment(traversal).path = "../secret";
    expect(() => CandidateDocumentSchema.parse(traversal)).toThrow(
      "path must not traverse upward",
    );

    const stale = candidateFixture();
    firstComment(stale).commit_id = "b".repeat(40);
    expect(() => validateCandidateDocument(state, stale, anchors)).toThrow(
      "not anchored to the authorized head",
    );

    const outsideDiff = candidateFixture();
    firstComment(outsideDiff).line = 200;
    expect(() => validateCandidateDocument(state, outsideDiff, anchors)).toThrow(
      "not present in the frozen diff",
    );
  });

  it("rejects inverted ranges and moved validator anchors", async () => {
    const state = stateFixture(await temporaryDirectory());
    const anchors = parseDiffAnchors(DIFF);
    const candidates = candidateFixture();
    const validated = validatedFixture();
    expect(() =>
      validateValidatedDocument(state, candidates, validated, anchors),
    ).not.toThrow();

    const inverted = candidateFixture();
    firstComment(inverted).startLine = 11;
    expect(() => CandidateDocumentSchema.parse(inverted)).toThrow(
      "startLine must be less than or equal to line",
    );

    const moved = ValidatedDocumentSchema.parse({
      ...validated,
      results: [
        {
          status: "approved",
          comment: { ...firstComment(candidates), line: 11 },
        },
      ],
    });
    expect(() =>
      validateValidatedDocument(state, candidates, moved, anchors),
    ).toThrow("changed its diff anchor");
  });

  it("publishes each model document only once", async () => {
    const target = path.join(await temporaryDirectory(), "candidate.json");
    await atomicJsonWrite(target, candidateFixture());
    expect(JSON.parse(await readFile(target, "utf8")).version).toBe(1);
    await expect(atomicJsonWrite(target, candidateFixture())).rejects.toThrow();
  });
});

describe("frozen review evidence", () => {
  it("paginates complete issue and review comment histories", async () => {
    const root = await temporaryDirectory();
    const issueComments = Array.from({ length: 120 }, (_, id) => ({ id }));
    const reviewComments = Array.from({ length: 135 }, (_, id) => ({ id }));
    const issueEndpoint = () => Promise.resolve({ data: issueComments });
    const reviewEndpoint = () => Promise.resolve({ data: reviewComments });
    const calls: unknown[] = [];
    const client = {
      rest: {
        paginate: async (endpoint: unknown) => {
          calls.push(endpoint);
          return endpoint === issueEndpoint ? issueComments : reviewComments;
        },
        rest: {
          issues: { listComments: issueEndpoint },
          pulls: { listReviewComments: reviewEndpoint },
        },
      },
    } as unknown as Octokits;

    const commentsPath = await fetchAndStoreComments(
      client,
      "EffortlessMetrics",
      "example",
      42,
      root,
    );
    const frozen = JSON.parse(await readFile(commentsPath, "utf8"));
    expect(calls).toEqual([issueEndpoint, reviewEndpoint]);
    expect(frozen.issueComments).toHaveLength(120);
    expect(frozen.reviewComments).toHaveLength(135);
  });
});

describe("isolated repository read boundary", () => {
  it("allows regular files and rejects symlinks, .git, and parent traversal", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    await writeFile(
      path.join(workspace, "src", "lib.ts"),
      "export const value = 1;\n",
    );
    await writeFile(path.join(root, "outside"), "secret\n");
    await symlink(
      path.join(root, "outside"),
      path.join(workspace, "src", "link"),
    );

    expect(await safeWorkspaceFile(workspace, "src/lib.ts")).toBe(
      path.join(workspace, "src", "lib.ts"),
    );
    await expect(safeWorkspaceFile(workspace, "src/link")).rejects.toThrow(
      "regular non-symlink file",
    );
    await expect(safeWorkspaceFile(workspace, ".git/config")).rejects.toThrow(
      "outside the review surface",
    );
    await expect(safeWorkspaceFile(workspace, "../outside")).rejects.toThrow(
      "outside the review surface",
    );
  });
});

function namedStep(action: string, name: string): string {
  const marker = `    - name: ${name}\n`;
  const start = action.indexOf(marker);
  if (start < 0) throw new Error(`missing action step: ${name}`);
  const bodyStart = start + marker.length;
  const next = action.indexOf("    - name: ", bodyStart);
  return action.slice(bodyStart, next < 0 ? action.length : next);
}

describe("isolated action credential boundary", () => {
  it("keeps model and publisher authority in separate steps", async () => {
    const action = await readFile(
      path.join(ROOT, "isolated-review", "action.yml"),
      "utf8",
    );
    const runPhase = await readFile(
      path.join(ROOT, "src", "isolated-review", "run-phase.ts"),
      "utf8",
    );
    const prepare = await readFile(
      path.join(ROOT, "src", "isolated-review", "prepare.ts"),
      "utf8",
    );

    expect(action).not.toContain("id-token");
    expect(action).not.toContain("model_base_url");
    expect(action).toContain('"https://api.minimax.io/anthropic"');
    expect(action).toContain(
      'Path(os.environ["DROID_HOME"]) / ".factory" / "settings.json"',
    );
    expect(runPhase).not.toContain("--skip-permissions-unsafe");
    expect(runPhase).not.toContain("...process.env");
    expect(runPhase).toContain('"--restrict-tools"');
    expect(runPhase).toContain('"--disable-builtin-skills"');
    expect(runPhase).toContain('"--cwd"');
    expect(runPhase).not.toContain('"Execute"');
    expect(runPhase).not.toContain('"Read"');
    expect(prepare).toContain("exec env -i");
    expect(prepare).toContain('sender?.type !== "User"');
    expect(prepare).toContain('context.actor.endsWith("[bot]")');
    expect(prepare).not.toContain('setOutput("github_token"');

    const candidate = namedStep(
      action,
      "Generate review candidates in isolated model boundary",
    );
    const validator = namedStep(
      action,
      "Validate review candidates in isolated model boundary",
    );
    const publisher = namedStep(action, "Publish typed review result");
    const runtime = namedStep(action, "Create private isolated runtime");

    for (const modelStep of [candidate, validator]) {
      expect(modelStep).toContain("FACTORY_API_KEY");
      expect(modelStep).not.toContain("GITHUB_TOKEN");
      expect(modelStep).not.toContain("MINIMAX_API_KEY");
    }
    expect(publisher).toContain("GITHUB_TOKEN");
    expect(publisher).not.toContain("FACTORY_API_KEY");
    expect(publisher).not.toContain("MINIMAX_API_KEY");
    expect(runtime).toContain("MINIMAX_API_KEY");
    expect(runtime).not.toContain("GITHUB_TOKEN");
    expect(runtime).not.toContain("FACTORY_API_KEY");
  });
});
