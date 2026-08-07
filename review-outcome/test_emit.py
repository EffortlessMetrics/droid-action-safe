from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("emit.py")
SPEC = importlib.util.spec_from_file_location("droid_review_outcome", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

artifact_facts = MODULE.artifact_facts
finalize_outcome = MODULE.finalize_outcome
matching_submitted_review = MODULE.matching_submitted_review

CLEAN_BODY = """## Review scope
Reviewed the cumulative claim and production route.

## Evidence and falsifiers
Read the full diff and challenged the opposite behavior.

## No material findings
No material actionable issue remains in the reviewed scope.

## Prior finding dispositions
No prior finding required a new disposition.

## What this establishes
The reviewed claim is supported by the inspected evidence.

## Residual risk / not proved
A platform-specific path was not exercised locally.

## Next action
Allow the advisory consumer to use the review result.
"""

FINDINGS_BODY = """## Review scope
Reviewed the cumulative claim and production route.

## Evidence and falsifiers
Read the full diff and exercised the stale-input path.

## Findings
The stale-input branch still returns an exact result.

## Prior finding dispositions
The earlier parsing concern was refuted by source inspection.

## What this establishes
The normal route works, but stale handling remains unsafe.

## Residual risk / not proved
Other cache consumers were not inspected.

## Next action
Repair the stale branch and refresh this review seam.
"""


def artifact(
    *,
    result: str = "clean",
    body: str = CLEAN_BODY,
    results: list[dict] | None = None,
    independent: list[dict] | None = None,
    summary_findings: list[dict] | None = None,
    head: str = "abc123",
) -> dict:
    return {
        "version": 2,
        "meta": {"headSha": head},
        "results": results or [],
        "independentFindings": independent or [],
        "summaryFindings": summary_findings or [],
        "reviewSummary": {
            "result": result,
            "body": body,
            "notProvenReason": None,
        },
    }


def submitted_review(
    body: str,
    *,
    head: str = "abc123",
    review_id: int = 7,
    state: str = "COMMENTED",
) -> dict:
    return {
        "id": review_id,
        "body": body,
        "commit_id": head,
        "state": state,
    }


class ReviewOutcomeTests(unittest.TestCase):
    def test_zero_candidates_can_be_clean_only_with_a_useful_body(self) -> None:
        outcome, body = artifact_facts(artifact(), "abc123")

        self.assertEqual(outcome.review_result, "clean")
        self.assertEqual(outcome.candidate_count, 0)
        self.assertEqual(outcome.independent_finding_count, 0)
        self.assertEqual(outcome.summary_finding_count, 0)
        self.assertTrue(body.startswith("## Review scope"))

    def test_legacy_artifact_cannot_prove_independent_clean_review(self) -> None:
        value = artifact()
        value["version"] = 1

        outcome, body = artifact_facts(value, "abc123")

        self.assertEqual(outcome.review_result, "not_proven")
        self.assertEqual(
            outcome.not_proven_reason, "validated_artifact_version_not_supported"
        )
        self.assertEqual(body, "")

    def test_empty_body_is_not_proven(self) -> None:
        outcome, body = artifact_facts(artifact(body=""), "abc123")

        self.assertEqual(outcome.review_result, "not_proven")
        self.assertEqual(outcome.not_proven_reason, "useful_review_body_missing")
        self.assertEqual(body, "")

    def test_nonempty_lgtm_body_is_not_proven(self) -> None:
        outcome, body = artifact_facts(artifact(body="LGTM"), "abc123")

        self.assertEqual(outcome.review_result, "not_proven")
        self.assertTrue(
            outcome.not_proven_reason.startswith("useful_review_body_missing_heading:")
        )
        self.assertEqual(body, "")

    def test_missing_prior_dispositions_is_not_proven(self) -> None:
        body = CLEAN_BODY.replace(
            "## Prior finding dispositions\nNo prior finding required a new disposition.\n\n",
            "",
        )
        outcome, _ = artifact_facts(artifact(body=body), "abc123")

        self.assertEqual(outcome.review_result, "not_proven")
        self.assertEqual(
            outcome.not_proven_reason,
            "useful_review_body_missing_heading:prior_finding_dispositions",
        )

    def test_pass_two_independent_findings_are_counted(self) -> None:
        outcome, _ = artifact_facts(
            artifact(
                result="findings",
                body=FINDINGS_BODY,
                independent=[{"path": "src/lib.ts", "line": 4, "body": "P1"}],
            ),
            "abc123",
        )

        self.assertEqual(outcome.review_result, "findings")
        self.assertEqual(outcome.independent_finding_count, 1)

    def test_summary_only_findings_are_counted(self) -> None:
        outcome, _ = artifact_facts(
            artifact(
                result="findings",
                body=FINDINGS_BODY,
                summary_findings=[
                    {
                        "severity": "P1",
                        "title": "No safe inline anchor",
                        "body": "Evidence gap affects the whole claim.",
                    }
                ],
            ),
            "abc123",
        )

        self.assertEqual(outcome.review_result, "findings")
        self.assertEqual(outcome.summary_finding_count, 1)

    def test_clean_result_with_findings_is_not_proven(self) -> None:
        outcome, _ = artifact_facts(
            artifact(
                results=[
                    {
                        "status": "approved",
                        "comment": {"path": "src/lib.ts", "line": 4, "body": "P1"},
                    }
                ]
            ),
            "abc123",
        )

        self.assertEqual(outcome.review_result, "not_proven")
        self.assertEqual(outcome.not_proven_reason, "clean_result_contains_findings")

    def test_findings_result_without_structured_findings_is_not_proven(self) -> None:
        outcome, _ = artifact_facts(
            artifact(result="findings", body=FINDINGS_BODY),
            "abc123",
        )

        self.assertEqual(outcome.review_result, "not_proven")
        self.assertEqual(
            outcome.not_proven_reason,
            "findings_result_without_structured_findings",
        )

    def test_artifact_head_mismatch_is_stale_without_publication_requirement(self) -> None:
        outcome, body = artifact_facts(artifact(head="old"), "abc123")

        self.assertEqual(outcome.review_result, "stale")
        self.assertEqual(outcome.publication_result, "not_needed")
        self.assertEqual(
            outcome.not_proven_reason,
            "validated_head_does_not_match_expected_head",
        )
        self.assertEqual(body, "")

    def test_exact_submitted_review_proves_publication(self) -> None:
        outcome, body = artifact_facts(artifact(), "abc123")

        final = finalize_outcome(
            outcome,
            "abc123",
            "abc123",
            body,
            [submitted_review(body)],
        )

        self.assertEqual(final.review_result, "clean")
        self.assertEqual(final.publication_result, "posted")
        self.assertTrue(final.review_body_submitted)
        self.assertEqual(final.submitted_review_id, 7)
        self.assertIsNone(final.not_proven_reason)

    def test_missing_submitted_body_is_not_proven(self) -> None:
        outcome, body = artifact_facts(artifact(), "abc123")

        final = finalize_outcome(outcome, "abc123", "abc123", body, [])

        self.assertEqual(final.review_result, "not_proven")
        self.assertEqual(final.publication_result, "not_proven")
        self.assertEqual(
            final.not_proven_reason, "useful_review_body_not_found_on_github"
        )

    def test_approval_state_does_not_prove_advisory_review_publication(self) -> None:
        outcome, body = artifact_facts(artifact(), "abc123")

        final = finalize_outcome(
            outcome,
            "abc123",
            "abc123",
            body,
            [submitted_review(body, state="APPROVED")],
        )

        self.assertEqual(final.review_result, "not_proven")
        self.assertEqual(
            final.not_proven_reason, "useful_review_body_not_found_on_github"
        )

    def test_candidate_movement_is_stale_not_clean(self) -> None:
        outcome, body = artifact_facts(artifact(), "abc123")

        final = finalize_outcome(
            outcome,
            "abc123",
            "def456",
            body,
            [submitted_review(body)],
        )

        self.assertEqual(final.review_result, "stale")
        self.assertEqual(final.publication_result, "not_needed")
        self.assertEqual(
            final.not_proven_reason, "pull_request_head_moved_during_review"
        )

    def test_review_match_requires_body_and_observed_head(self) -> None:
        body = CLEAN_BODY
        reviews = [
            submitted_review(body, head="old"),
            submitted_review("different", head="abc123", review_id=8),
        ]

        self.assertIsNone(matching_submitted_review(reviews, "abc123", body))


if __name__ == "__main__":
    unittest.main()
