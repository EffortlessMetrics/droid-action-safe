import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "fs/promises";
import os from "os";
import path from "path";
import {
  CandidateDocumentSchema,
  ReviewStateSchema,
  ValidatedDocumentSchema,
} from "../src/isolated-review/schemas";
import {
  atomicJsonWrite,
  safeWorkspaceFile,
  validateCandidateDocument,
  validateValidatedDocument,
} from "../src/isolated-review/io";

const HEAD = "a".repeat(40);
const ROOT = path.resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "droid-isolated-review-"));
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

function candidateFixture() {
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

function validatedFixture() {
  const candidate = candidateFixture().comments[0];
  return ValidatedDocumentSchema.parse({
    version: 1,
    meta: {
      repo: "EffortlessMetrics/example",
      prNumber: 42,
      headSha: HEAD,
      baseRef: "main",
      validatedAt: "2026-09-15T20:01:00Z",
    },
    results: [{ status: "approved", comment: candidate }],
    reviewSummary: {
      status: "approved",
      body: "The candidate was independently reproduced from the diff.",
    },
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("isolated review document contracts", () => {
  it("rejects traversal and non-exact commit anchors", async () => {
    const root = await temporaryDirectory();
    const state = stateFixture(root);
    const candidate = candidateFixture();
    candidate.comments[0].path = "../secret";
    expect(() => CandidateDocumentSchema.parse(candidate)).toThrow(
      "path must not traverse upward",
    );

    const wrongHead = candidateFixture();
    wrongHead.comments[0].commit_id = "b".repeat(40);
    expect(() => validateCandidateDocument(state, wrongHead)).toThrow(
      "not anchored to the authorized head",
    );
  });

  it("preserves candidate order and anchors through validation", async () => {
    const root = await temporaryDirectory();
    const state = stateFixture(root);
    const candidates = candidateFixture();
    const validated = validatedFixture();
    expect(() =>
      validateValidatedDocument(state, candidates, validated),
    ).not.toThrow();

    validated.results[0] = {
      status: "approved",
      comment: { ...candidates.comments[0], line: 11 },
    };
    expect(() =>
      validateValidatedDocument(state, candidates, validated),
    ).toThrow("changed its diff anchor");
  });

  it("publishes each model document only once", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "candidate.json");
    await atomicJsonWrite(target, candidateFixture());
    expect(JSON.parse(await readFile(target, "utf8")).version).toBe(1);
    await expect(atomicJsonWrite(target, candidateFixture())).rejects.toThrow();
  });
});

describe("isolated repository read boundary", () => {
  it("allows regular files and rejects symlinks, .git, and parent traversal", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    await writeFile(path.join(workspace, "src", "lib.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "outside"), "secret\n");
    await symlink(path.join(root, "outside"), path.join(workspace, "src", "link"));

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
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = action.match(
    new RegExp(
      `(?ms)^    - name: ${escaped}\\n(.*?)(?=^    - name:|\\Z)`,
    ),
  );
  if (!match) throw new Error(`missing action step: ${name}`);
  return match[1];
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
    expect(runPhase).not.toContain("--skip-permissions-unsafe");
    expect(runPhase).not.toContain("...process.env");
    expect(runPhase).toContain('"--restrict-tools"');
    expect(runPhase).toContain('"--disable-builtin-skills"');
    expect(runPhase).toContain('"--cwd"');
    expect(runPhase).not.toContain('"Execute"');
    expect(runPhase).not.toContain('"Read"');
    expect(prepare).toContain("exec env -i");
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
      expect(modelStep).not.toContain("MODEL_API_KEY");
    }
    expect(publisher).toContain("GITHUB_TOKEN");
    expect(publisher).not.toContain("FACTORY_API_KEY");
    expect(publisher).not.toContain("MODEL_API_KEY");
    expect(runtime).toContain("MODEL_API_KEY");
    expect(runtime).not.toContain("GITHUB_TOKEN");
    expect(runtime).not.toContain("FACTORY_API_KEY");
  });
});
