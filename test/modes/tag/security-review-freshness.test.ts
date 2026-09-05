import { describe, expect, it } from "bun:test";
import { shouldCheckExistingSecurityReview } from "../../../src/tag";

const HEAD = "a".repeat(40);

describe("automatic security review freshness", () => {
  it("retains run-once compatibility when no exact head is supplied", () => {
    expect(shouldCheckExistingSecurityReview(undefined)).toBe(true);
    expect(shouldCheckExistingSecurityReview("   ")).toBe(true);
  });

  it("does not reuse a prior PR-wide review for an exact candidate", () => {
    expect(shouldCheckExistingSecurityReview(HEAD)).toBe(false);
  });

  it("rejects malformed candidate identities", () => {
    expect(() => shouldCheckExistingSecurityReview("abc123")).toThrow(
      "full 40-character hexadecimal commit SHA",
    );
  });
});
