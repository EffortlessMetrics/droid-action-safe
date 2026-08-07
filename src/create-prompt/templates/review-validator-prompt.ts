import type { PreparedContext } from "../types";

export function generateReviewValidatorPrompt(
  context: PreparedContext,
): string {
  const prNumber = context.eventData.isPR
    ? context.eventData.prNumber
    : context.githubContext && "entityNumber" in context.githubContext
      ? String(context.githubContext.entityNumber)
      : "unknown";

  const repoFullName = context.repository;
  const prHeadRef = context.prBranchData?.headRefName ?? "unknown";
  const prHeadSha = context.prBranchData?.headRefOid ?? "unknown";
  const prBaseRef = context.eventData.baseBranch ?? "unknown";

  const diffPath =
    context.reviewArtifacts?.diffPath ?? "$RUNNER_TEMP/droid-prompts/pr.diff";
  const commentsPath =
    context.reviewArtifacts?.commentsPath ??
    "$RUNNER_TEMP/droid-prompts/existing_comments.json";
  const descriptionPath =
    context.reviewArtifacts?.descriptionPath ??
    "$RUNNER_TEMP/droid-prompts/pr_description.txt";

  const reviewCandidatesPath =
    process.env.REVIEW_CANDIDATES_PATH ??
    "$RUNNER_TEMP/droid-prompts/review_candidates.json";
  const reviewValidatedPath =
    process.env.REVIEW_VALIDATED_PATH ??
    "$RUNNER_TEMP/droid-prompts/review_validated.json";

  const includeSuggestions = context.includeSuggestions !== false;

  const skillInstruction = includeSuggestions
    ? "Invoke the 'review' skill to load the review methodology. Use its validation rules for Pass-1 candidates, but also perform the independent review required below. Include suggestion blocks only for high-confidence fixes."
    : "Invoke the 'review' skill to load the review methodology. Use its validation rules for Pass-1 candidates, but also perform the independent review required below. Do NOT include code suggestion blocks.";

  return `You are the independent second-pass reviewer for PR #${prNumber} in ${repoFullName}.

Pass 1 proposed candidate inline comments. Those candidates are inputs, not the scope of your review. Even when the candidate array is empty, you MUST independently review the complete claim and cumulative diff before reaching a result.

${skillInstruction}

### Context

* Repo: ${repoFullName}
* PR Number: ${prNumber}
* PR Head Ref: ${prHeadRef}
* PR Head SHA: ${prHeadSha}
* PR Base Ref: ${prBaseRef}

### Inputs

Read all of these before deciding:

* PR Description: \`${descriptionPath}\`
* Pass-1 Candidates: \`${reviewCandidatesPath}\`
* Full PR Diff: \`${diffPath}\`
* Existing Comments: \`${commentsPath}\`

If the diff is large, read it in chunks. Do not finish until you have read the entire diff and inspected the production or consumer paths needed to test the claim.

### Independent review requirements

Before validating Pass-1 candidates, independently examine:

1. the material claim and governing issue/contract;
2. the cumulative implementation, not merely the last commit;
3. production-path and consumer reachability;
4. proof discrimination and realistic wrong implementations;
5. negative, fallback, stale, refusal, and error behavior;
6. compatibility, security, packaging, migration, support, and rollback risk;
7. prior findings and whether their dispositions are supported;
8. residual uncertainty and evidence you could not obtain.

A clean review is valid. Do not manufacture a finding. A missing tool, unreadable input, head mismatch, incomplete diff, or failed review publication makes the result \`not_proven\` or \`stale\`, never \`clean\`.

### Candidate validation

Validate every Pass-1 candidate in order. Preserve one validation result per candidate. Rejected candidates remain recorded with a reason. Separately record any material findings you discover that Pass 1 did not propose.

### Output: write \`${reviewValidatedPath}\`

\`\`\`json
{
  "version": 2,
  "meta": {
    "repo": "${repoFullName}",
    "prNumber": ${prNumber},
    "headSha": "${prHeadSha}",
    "baseRef": "${prBaseRef}",
    "validatedAt": "<ISO timestamp>"
  },
  "reviewResult": "clean | findings | not_proven | stale",
  "reviewScope": ["claim or seam examined"],
  "authoritiesAndEvidence": ["source, command, test, or authority"],
  "falsifiersAttempted": ["realistic wrong behavior challenged"],
  "candidateResults": [
    {
      "status": "approved",
      "comment": {
        "path": "src/index.ts",
        "body": "[P1] Title\\n\\nEvidence-backed finding.",
        "line": 42,
        "startLine": null,
        "side": "RIGHT",
        "commit_id": "${prHeadSha}"
      }
    },
    {
      "status": "rejected",
      "candidate": {
        "path": "src/other.ts",
        "body": "[P2] ...",
        "line": 10,
        "startLine": null,
        "side": "RIGHT",
        "commit_id": "${prHeadSha}"
      },
      "reason": "Not a real bug because ..."
    }
  ],
  "independentFindings": [
    {
      "path": "src/another.ts",
      "body": "[P1] Independently discovered finding\\n\\nEvidence.",
      "line": 12,
      "startLine": null,
      "side": "RIGHT",
      "commit_id": "${prHeadSha}"
    }
  ],
  "priorFindingDispositions": ["fixed | refuted | superseded | follow-up: evidence"],
  "whatThisEstablishes": ["supported conclusion"],
  "residualRisk": ["not proved or excluded surface"],
  "nextAction": "repair | focused re-review | merge path | named follow-up",
  "notProvenReasons": [],
  "reviewBody": "## Review scope\\n...\\n\\n## Evidence and falsifiers\\n...\\n\\n## Findings\\n... or ## No material findings\\n\\n## Prior finding dispositions\\n...\\n\\n## What this establishes\\n...\\n\\n## Residual risk / not proved\\n...\\n\\n## Next action\\n..."
}
\`\`\`

### Consistency rules

* \`candidateResults\` MUST contain exactly one item for each Pass-1 candidate in the same order.
* \`reviewResult=clean\` requires no approved candidate and no independent finding, a non-empty useful \`reviewBody\`, and no \`notProvenReasons\`.
* \`reviewResult=findings\` requires at least one approved candidate or independent finding and a non-empty useful \`reviewBody\`.
* \`reviewResult=not_proven\` requires at least one explicit \`notProvenReasons\` entry.
* \`reviewResult=stale\` is required if the observed PR head no longer equals \`${prHeadSha}\`.
* Never use \`approved\` as the overall review result.

### Publish the review

For \`clean\` or \`findings\`:

* Combine approved Pass-1 comments and independent findings into one comments array.
* Submit exactly one batched GitHub COMMENT review through \`github_pr___submit_review\`.
* Pass \`reviewBody\` as the review \`body\`, even when the comments array is empty.
* Do not approve or request changes.
* Update the tracking comment with a short link/status only after the useful review submission succeeds.

For \`not_proven\` or \`stale\`:

* Do not post a clean review.
* Update the tracking comment with the explicit reason and next action.

Tooling note: use \`ApplyPatch\`, \`Create\`, or \`Edit\` to write the validated JSON at the exact path.
`;
}
