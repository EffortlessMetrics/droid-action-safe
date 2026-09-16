import { execFileSync } from "child_process";
import { writeFile, mkdir } from "fs/promises";
import type { Octokits } from "../api/client";
import type { ReviewArtifacts } from "../../create-prompt/types";

const DIFF_MAX_BUFFER = 50 * 1024 * 1024; // 50MB buffer for large diffs

type CommentEndpoint = (
  params: Record<string, unknown>,
) => Promise<{ data: unknown[] }>;

type CommentRestClient = {
  paginate?: (
    endpoint: CommentEndpoint,
    params: Record<string, unknown>,
  ) => Promise<unknown[]>;
  rest?: {
    issues: { listComments: CommentEndpoint };
    pulls: { listReviewComments: CommentEndpoint };
  };
  issues?: { listComments: CommentEndpoint };
  pulls?: { listReviewComments: CommentEndpoint };
};

async function listAllComments(
  client: CommentRestClient,
  endpoint: CommentEndpoint,
  params: Record<string, unknown>,
): Promise<unknown[]> {
  if (client.paginate) {
    return client.paginate(endpoint, params);
  }
  const response = await endpoint(params);
  return response.data;
}

/**
 * Compute the PR diff and store it on disk.
 *
 * Tries git merge-base first (requires sufficient history). When that
 * fails (e.g. shallow clone without unshallow support) it falls back
 * to `gh pr diff` which always works.
 */
export async function computeAndStoreDiff(
  baseRef: string,
  tempDir: string,
  options?: { githubToken?: string; prNumber?: number },
): Promise<string> {
  const promptsDir = `${tempDir}/droid-prompts`;
  await mkdir(promptsDir, { recursive: true });

  let diff: string;
  try {
    // Unshallow the repo if it's a shallow clone (needed for merge-base).
    try {
      const shallow = execFileSync(
        "git",
        ["rev-parse", "--is-shallow-repository"],
        {
          encoding: "utf8",
          stdio: "pipe",
        },
      ).trim();
      if (shallow === "true") {
        execFileSync("git", ["fetch", "--unshallow"], {
          encoding: "utf8",
          stdio: "pipe",
        });
        console.log("Unshallowed repository");
      } else {
        console.log("Repository already has full history");
      }
    } catch {
      console.log("Repository already has full history");
    }

    // Fetch the base branch without invoking a shell. GitHub controls baseRef,
    // but it is still untrusted pull-request metadata at this boundary.
    try {
      execFileSync(
        "git",
        ["fetch", "--", "origin", `${baseRef}:refs/remotes/origin/${baseRef}`],
        { encoding: "utf8", stdio: "pipe" },
      );
      console.log(`Fetched base branch: ${baseRef}`);
    } catch {
      console.log(`Base branch fetch skipped (may already exist): ${baseRef}`);
    }

    const mergeBase = execFileSync(
      "git",
      ["merge-base", "HEAD", `refs/remotes/origin/${baseRef}`],
      { encoding: "utf8" },
    ).trim();

    diff = execFileSync("git", ["--no-pager", "diff", `${mergeBase}..HEAD`], {
      encoding: "utf8",
      maxBuffer: DIFF_MAX_BUFFER,
    });
  } catch {
    // Fallback: use gh CLI to get the diff (works even with shallow clones).
    if (options?.githubToken && options?.prNumber) {
      console.log(
        "Git merge-base failed, falling back to gh pr diff for PR diff",
      );
      diff = execFileSync("gh", ["pr", "diff", String(options.prNumber)], {
        encoding: "utf8",
        maxBuffer: DIFF_MAX_BUFFER,
        env: { ...process.env, GH_TOKEN: options.githubToken },
      });
    } else {
      throw new Error(
        "Git merge-base failed and no fallback credentials provided",
      );
    }
  }

  const diffPath = `${promptsDir}/pr.diff`;
  await writeFile(diffPath, diff);
  console.log(`Stored PR diff (${diff.length} bytes) at ${diffPath}`);
  return diffPath;
}

export async function fetchAndStoreComments(
  octokit: Octokits,
  owner: string,
  repo: string,
  prNumber: number,
  tempDir: string,
): Promise<string> {
  const promptsDir = `${tempDir}/droid-prompts`;
  await mkdir(promptsDir, { recursive: true });

  // Production Octokit exposes endpoints under `.rest`, while older focused
  // test doubles expose them directly. Pagination is mandatory whenever the
  // real client supplies it; the direct path preserves the narrow unit seam.
  const client = octokit.rest as unknown as CommentRestClient;
  const endpoints = client.rest ?? {
    issues: client.issues,
    pulls: client.pulls,
  };
  if (!endpoints.issues || !endpoints.pulls) {
    throw new Error("Octokit comment endpoints are unavailable");
  }

  const [issueComments, reviewComments] = await Promise.all([
    listAllComments(client, endpoints.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    }),
    listAllComments(client, endpoints.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);

  const comments = {
    issueComments,
    reviewComments,
  };

  const commentsPath = `${promptsDir}/existing_comments.json`;
  await writeFile(commentsPath, JSON.stringify(comments, null, 2));
  console.log(
    `Stored existing comments (${issueComments.length} issue, ${reviewComments.length} review) at ${commentsPath}`,
  );
  return commentsPath;
}

export async function storeDescription(
  title: string,
  body: string,
  tempDir: string,
): Promise<string> {
  const promptsDir = `${tempDir}/droid-prompts`;
  await mkdir(promptsDir, { recursive: true });

  const content = `# ${title}\n\n${body}`;
  const descriptionPath = `${promptsDir}/pr_description.txt`;
  await writeFile(descriptionPath, content);
  console.log(
    `Stored PR description (${content.length} bytes) at ${descriptionPath}`,
  );
  return descriptionPath;
}

/**
 * Pre-compute all review artifacts (diff, comments, description) in parallel.
 */
export async function computeReviewArtifacts(opts: {
  baseRef: string;
  tempDir: string;
  octokit: Octokits;
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  githubToken?: string;
}): Promise<ReviewArtifacts> {
  const [diffPath, commentsPath, descriptionPath] = await Promise.all([
    computeAndStoreDiff(opts.baseRef, opts.tempDir, {
      githubToken: opts.githubToken,
      prNumber: opts.prNumber,
    }),
    fetchAndStoreComments(
      opts.octokit,
      opts.owner,
      opts.repo,
      opts.prNumber,
      opts.tempDir,
    ),
    storeDescription(opts.title, opts.body, opts.tempDir),
  ]);

  return { diffPath, commentsPath, descriptionPath };
}
