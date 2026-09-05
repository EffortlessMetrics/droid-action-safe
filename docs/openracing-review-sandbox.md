# Exact-head read-only review sandbox

This action line is intentionally based on the artifact-safe revision
`7c1377ccbacddc95560d1570547a5baa51de01ec`. Its composite action defaults raw
debug upload off and, when explicitly enabled, admits only the separately
sanitized debug directory. Raw `$HOME/.factory` and raw prompt files are not
eligible for upload.

Two environment contracts harden review and security-review invocation:

- `EXPECTED_HEAD_SHA` accepts either an empty value or one full 40-character
  commit SHA. A supplied SHA must match live pull-request metadata and must
  already exist in the caller checkout. Review generation detaches that exact
  commit rather than running `gh pr checkout` against a mutable branch.
- `READ_ONLY_REVIEW=true` removes `Execute`, `Edit`, `Create`, `ApplyPatch`, and
  `FetchUrl` from candidate generation. It rejects arbitrary `DROID_ARGS` and
  caller MCP expansion. The validator receives repository read/search tools,
  tracking-comment update, and `github_pr___submit_review` only.

When an exact head is supplied, automatic security review runs for that
candidate even when the pull request already has an older security-review
comment. Legacy callers that omit the expected head retain the prior run-once
PR behavior.

This is a capability boundary, not a claim that model output is correct. The
caller must still:

1. reject forks before supplying secrets;
2. check out the captured full head SHA with persisted credentials disabled;
3. avoid credential-bearing `settings` files accessible to the review agent;
4. keep full output and debug artifact upload disabled for secrets-backed runs;
5. treat review failure and findings as advisory evidence rather than merge
   authority.
