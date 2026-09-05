import * as childProcess from "child_process";
import type { PRBranchData } from "../data/pr-fetcher";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

export type CommandOptions = {
  encoding: "utf8";
  stdio: "pipe";
  env?: NodeJS.ProcessEnv;
};

export type CommandRunner = (
  command: string,
  options: CommandOptions,
) => string;

const defaultRun: CommandRunner = (command, options) =>
  childProcess.execSync(command, options).toString();

export function readExpectedHeadSha(
  raw = process.env.EXPECTED_HEAD_SHA,
): string | undefined {
  const expected = raw?.trim();
  if (!expected) {
    return undefined;
  }
  if (!FULL_COMMIT_SHA.test(expected)) {
    throw new Error(
      "expected_head_sha must be a full 40-character hexadecimal commit SHA",
    );
  }
  return expected.toLowerCase();
}

export function assertExpectedHead(
  prData: PRBranchData,
  raw = process.env.EXPECTED_HEAD_SHA,
): string | undefined {
  const expected = readExpectedHeadSha(raw);
  if (!expected) {
    return undefined;
  }

  const liveHead = prData.headRefOid.toLowerCase();
  if (liveHead !== expected) {
    throw new Error(
      `PR head changed: expected ${expected}, current head is ${liveHead}`,
    );
  }
  return expected;
}

export function checkoutPullRequestHead({
  prData,
  prNumber,
  githubToken,
  run = defaultRun,
}: {
  prData: PRBranchData;
  prNumber: number;
  githubToken: string;
  run?: CommandRunner;
}): string {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid pull request number: ${prNumber}`);
  }

  const options: CommandOptions = {
    encoding: "utf8",
    stdio: "pipe",
  };
  const expected = assertExpectedHead(prData);

  run("git reset --hard HEAD", options);
  if (expected) {
    run(`git cat-file -e ${expected}^{commit}`, options);
    run(`git checkout --detach ${expected}`, options);
    const actual = run("git rev-parse HEAD", options).trim().toLowerCase();
    if (actual !== expected) {
      throw new Error(
        `Exact-head checkout failed: expected ${expected}, checked out ${actual}`,
      );
    }
    return actual;
  }

  run(`gh pr checkout ${prNumber}`, {
    ...options,
    env: { ...process.env, GH_TOKEN: githubToken },
  });
  return run("git rev-parse HEAD", options).trim().toLowerCase();
}
