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
    ? "Invoke the 'review' skill to load the review methodology. Validate Pass 1 candidates, then perform the independent cumulative review below, including suggestion block rules."
    : "Invoke the 'review' skill to load the review methodology. Validate Pass 1 candidates, then perform the independent cumulative review below. Do NOT include code suggestion blocks.";

  return `You are the independent validation and cumulative-review pass for PR #${prNumber} in ${repoFullName}.

IMPORTANT: This is Phase 2 of a two-pass review pipeline, but it is NOT limited to validating Phase 1 output. Phase 1 candidates are leads. You remain responsible for reviewing the complete PR even when the candidate list is empty, incomplete, or entirely rejected.

${skillInstruction}

### Context

* Repo: ${repoFullName}
* PR Number: ${prNumber}
* PR Head Ref: ${prHeadRef}
* Observed PR Head SHA: ${prHeadSha}
* PR Base Ref: ${prBaseRef}

The observed SHA identifies the candidate you read. It is not an approval token and does not make every prior semantic conclusion useless after a later unrelated push.

### Inputs

Read all of these before reaching a result:
* PR Description: \`${descriptionPath}\`
* Pass 1 Candidates: \`${reviewCandidatesPath}\`
* Full PR Diff: \`${diffPath}\`
* Existing Comments: \`${commentsPath}\`

If the diff is large, read it in chunks. **Do not proceed until you have read the entire cumulative diff and the material PR claim.**

### Required review work

Perform both parts:

1. **Candidate validation**
   * Read and disposition every Pass 1 candidate.
   * Preserve candidate order in \`results\`.
   * Approve only concrete, actionable findings supported by the current diff and repository context.
   * Reject false positives with a specific reason.

2. **Independent cumulative review**
   * Reconstruct the PR's claim, non-goals, production consumers, proof, and rollback boundary.
   * Trace whether the real request/caller/protocol/build/package/runtime path reaches the changed behavior.
   * Challenge realistic wrong implementations and missing negative/fallback/error behavior.
   * Check evidence integrity: tests and receipts must discriminate the claim rather than mirror or self-attest it.
   * Check external/semantic authority, compatibility, security, migration, packaging, and support where applicable.
   * Recheck prior findings in existing comments and record each durable disposition as fixed, refuted, superseded, or follow-up with evidence.
   * Look for material findings that Pass 1 missed. Put those in \`independentFindings\`.
   * A zero-candidate input still requires this complete independent review.

A clean review is valid. It must state what was examined, what evidence/falsifiers were used, how prior findings were dispositioned, and what remains unproved. Do not manufacture a finding to demonstrate activity.

### Result classes

Use exactly one:

* \`clean\` — complete review found no material actionable issue.
* \`findings\` — one or more approved candidate or independent findings remain.
* \`not_proven\` — required diff, claim, evidence, tool, or authority was unavailable or contradictory.
* \`stale\` — the PR head changed during review, so publication would target a different candidate.

Never use \`approved\` as the overall result. This action provides advisory review evidence; it does not approve the pull request or authorize merge.

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
  "results": [
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
      "path": "src/missed.ts",
      "body": "[P1] Pass 2 finding\\n\\nEvidence-backed finding missed by Pass 1.",
      "line": 24,
      "startLine": null,
      "side": "RIGHT",
      "commit_id": "${prHeadSha}"
    }
  ],
  "reviewSummary": {
    "result": "clean | findings | not_proven | stale",
    "body": "## Review scope\\n...\\n\\n## Evidence and falsifiers\\n...\\n\\n## Findings\\n... (or ## No material findings)\\n\\n## Prior finding dispositions\\n- fixed | refuted | superseded | follow-up, with evidence\\n\\n## What this establishes\\n...\\n\\n## Residual risk / not proved\\n...\\n\\n## Next action\\n...",
    "notProvenReason": null
  }
}
\`\`\`

Requirements:
* Use \`commit_id\` = \`${prHeadSha}\` for inline comments.
* \`results\` MUST have exactly one entry per Pass 1 candidate, in the same order.
* \`independentFindings\` may be empty, but only after the independent cumulative review.
* \`reviewSummary.body\` is required for every result, including \`clean\`.
* \`reviewSummary.body\` MUST contain review scope, evidence/falsifiers, findings or an explicit no-material-findings result, prior finding dispositions, what is established, residual risk/not proved, and next action.
* \`reviewSummary.result\` is \`findings\` when any approved candidate or independent finding remains.
* \`reviewSummary.result\` is \`clean\` only when no approved or independent finding remains.
* Use \`not_proven\` rather than clean when required inputs or tools were unavailable.

Tooling note:
* If the tools list includes \`ApplyPatch\`, use it to create/update the exact output path.
* Otherwise use \`Create\` (or \`Edit\` if overwriting).

### Publish one useful review

After writing \`${reviewValidatedPath}\`:

* Collect approved candidate comments and every independent finding.
* Submit them as one batched review via \`github_pr___submit_review\`.
* Include \`reviewSummary.body\` as the review \`body\`, even when there are zero inline findings.
* Do not post comments individually.
* Do not approve or request changes.
* Use \`github_comment___update_droid_comment\` only for a concise tracking summary and job link; the submitted review is the durable judgment.
* If the observed head no longer matches the PR, do not publish findings against a different candidate. Record \`stale\` and explain the changed seam needed for a later focused review.
`;
}