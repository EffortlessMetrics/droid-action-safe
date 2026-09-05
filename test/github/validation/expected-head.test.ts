import { afterEach, describe, expect, it } from "bun:test";
import {
  assertExpectedHead,
  checkoutPullRequestHead,
  readExpectedHeadSha,
  type CommandRunner,
} from "../../../src/github/validation/expected-head";

const EXPECTED = "a".repeat(40);
const OTHER = "b".repeat(40);
const PR_DATA = {
  baseRefName: "main",
  headRefName: "feature/exact-head",
  headRefOid: EXPECTED,
  title: "Exact head",
  body: "",
} as any;

describe("expected PR head contract", () => {
  const originalExpectedHead = process.env.EXPECTED_HEAD_SHA;

  afterEach(() => {
    if (originalExpectedHead === undefined) {
      delete process.env.EXPECTED_HEAD_SHA;
    } else {
      process.env.EXPECTED_HEAD_SHA = originalExpectedHead;
    }
  });

  it("preserves legacy behavior when no expected head is supplied", () => {
    delete process.env.EXPECTED_HEAD_SHA;
    expect(readExpectedHeadSha()).toBeUndefined();
    expect(readExpectedHeadSha("   \t\n")).toBeUndefined();
    expect(assertExpectedHead(PR_DATA)).toBeUndefined();
    expect(assertExpectedHead(PR_DATA, "   ")).toBeUndefined();
  });

  it("rejects abbreviated and non-hexadecimal expected heads", () => {
    for (const value of ["abc123", "z".repeat(40), `${EXPECTED}00`]) {
      expect(() => readExpectedHeadSha(value)).toThrow(
        "full 40-character hexadecimal commit SHA",
      );
    }
  });

  it("rejects a PR head that differs from the authorized head", () => {
    expect(() => assertExpectedHead(PR_DATA, OTHER)).toThrow(
      `expected ${OTHER}, current head is ${EXPECTED}`,
    );
  });

  it("accepts the exact PR head", () => {
    expect(assertExpectedHead(PR_DATA, EXPECTED.toUpperCase())).toBe(EXPECTED);
  });

  it("detaches the exact commit already present in the checkout", () => {
    process.env.EXPECTED_HEAD_SHA = EXPECTED;
    const calls: string[] = [];
    const run: CommandRunner = (command) => {
      calls.push(command);
      return command === "git rev-parse HEAD" ? `${EXPECTED}\n` : "";
    };

    expect(
      checkoutPullRequestHead({
        prData: PR_DATA,
        prNumber: 42,
        githubToken: "token",
        run,
      }),
    ).toBe(EXPECTED);
    expect(calls).toEqual([
      "git reset --hard HEAD",
      `git cat-file -e ${EXPECTED}^{commit}`,
      `git checkout --detach ${EXPECTED}`,
      "git rev-parse HEAD",
    ]);
  });

  it("keeps the existing live checkout path without the optional input", () => {
    delete process.env.EXPECTED_HEAD_SHA;
    const calls: Array<{ command: string; token?: string }> = [];
    const run: CommandRunner = (command, options) => {
      calls.push({ command, token: options.env?.GH_TOKEN });
      return command === "git rev-parse HEAD" ? `${EXPECTED}\n` : "";
    };

    expect(
      checkoutPullRequestHead({
        prData: PR_DATA,
        prNumber: 42,
        githubToken: "token",
        run,
      }),
    ).toBe(EXPECTED);
    expect(calls[1]).toEqual({
      command: "gh pr checkout 42",
      token: "token",
    });
  });
});
