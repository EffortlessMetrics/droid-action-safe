import { describe, expect, test } from "bun:test";
import type { IssueCommentEvent } from "@octokit/webhooks-types";
import { shouldTriggerTag } from "../../src/tag";
import { createMockAutomationContext, createMockContext } from "../mockContext";

describe("shouldTriggerTag", () => {
  test("returns true when trigger phrase is present", () => {
    const contextWithTrigger = createMockContext({
      eventName: "issue_comment",
      isPR: false,
      inputs: {
        ...createMockContext().inputs,
        triggerPhrase: "@droid",
      },
      payload: {
        comment: {
          body: "Hey @droid, can you help?",
        },
      } as IssueCommentEvent,
    });

    expect(shouldTriggerTag(contextWithTrigger)).toBe(true);
  });

  test("returns false when trigger phrase is missing", () => {
    const contextWithoutTrigger = createMockContext({
      eventName: "issue_comment",
      isPR: false,
      inputs: {
        ...createMockContext().inputs,
        triggerPhrase: "@droid",
      },
      payload: {
        comment: {
          body: "This is just a regular comment",
        },
      } as IssueCommentEvent,
    });

    expect(shouldTriggerTag(contextWithoutTrigger)).toBe(false);
  });

  test("returns true for PR contexts when automaticReview is enabled", () => {
    const contextWithAutomaticReview = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      inputs: {
        ...createMockContext().inputs,
        automaticReview: true,
      },
    });

    expect(shouldTriggerTag(contextWithAutomaticReview)).toBe(true);
  });

  test("returns true for PR contexts when automaticSecurityReview is enabled", () => {
    const contextWithAutomaticSecurityReview = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      inputs: {
        ...createMockContext().inputs,
        automaticSecurityReview: true,
      },
    });

    expect(shouldTriggerTag(contextWithAutomaticSecurityReview)).toBe(true);
  });

  test("returns true for workflow_dispatch security scan schedule", () => {
    const context = createMockAutomationContext({
      eventName: "workflow_dispatch",
      inputs: {
        securityScanSchedule: true,
      },
    });

    expect(shouldTriggerTag(context)).toBe(true);
  });

  test("returns true for schedule security scan schedule", () => {
    const context = createMockAutomationContext({
      eventName: "schedule",
      inputs: {
        securityScanSchedule: true,
      },
    });

    expect(shouldTriggerTag(context)).toBe(true);
  });

  test("returns false for workflow_dispatch without security scan schedule", () => {
    const context = createMockAutomationContext({
      eventName: "workflow_dispatch",
      inputs: {
        securityScanSchedule: false,
      },
    });

    expect(shouldTriggerTag(context)).toBe(false);
  });
});
