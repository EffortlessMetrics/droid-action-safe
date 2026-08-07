from __future__ import annotations

import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("emit.py")
SPEC = importlib.util.spec_from_file_location("droid_review_outcome", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

ReviewOutcome = MODULE.ReviewOutcome
artifact_facts = MODULE.artifact_facts
finalize_outcome = MODULE.finalize_outcome
matching_submitted_review = MODULE.matching_submitted_review


def artifact(
    *,
    result: str = "clean",
    body: str = "## Review scope\nfull diff\n\n## No material findings\nclean",
    results: list[dict] | None = None,
    independent: list[dict] | None = None,
    head: str = "abc123",
) -> dict:
    return {
        "version": 2,
        "meta": {"headSha": head},
        "results": results or [],
        "independentFindings": independent or [],
        "reviewSummary": {
            "result": result,
            "body": body,
            "notProvenReason": None,
        },
    }


def submitted_review(body: str, *, head: str = "abc123", review_id: int = 7) -> dict:
    return {
        "id": review_id,
        "body": body,
        "commit_id": head,
        "state": "COMMENTED",
    }


def test_zero_candidates_can_be_clean_only_with_a_useful_body() -> None:
    outcome, body = artifact_facts(artifact(), "abc123")

    assert outcome.review_result == "clean"
    assert outcome.candidate_count == 0
    assert outcome.independent_finding_count == 0
    assert body.startswith("## Review scope")


def test_legacy_artifact_cannot_prove_independent_clean_review() -> None:
    value = artifact()
    value["version"] = 1

    outcome, body = artifact_facts(value, "abc123")

    assert outcome.review_result == "not_proven"
    assert outcome.not_proven_reason == "validated_artifact_version_not_supported"
    assert body == ""


def test_missing_useful_body_is_not_proven() -> None:
    outcome, body = artifact_facts(artifact(body=""), "abc123")

    assert outcome.review_result == "not_proven"
    assert outcome.not_proven_reason == "useful_review_body_missing"
    assert body == ""


def test_pass_two_independent_findings_are_counted() -> None:
    outcome, _ = artifact_facts(
        artifact(
            result="findings",
            independent=[{"path": "src/lib.ts", "line": 4, "body": "P1"}],
        ),
        "abc123",
    )

    assert outcome.review_result == "findings"
    assert outcome.independent_finding_count == 1


def test_exact_submitted_review_proves_publication() -> None:
    outcome, body = artifact_facts(artifact(), "abc123")

    final = finalize_outcome(
        outcome,
        "abc123",
        "abc123",
        body,
        [submitted_review(body)],
    )

    assert final.review_result == "clean"
    assert final.publication_result == "posted"
    assert final.review_body_submitted is True
    assert final.submitted_review_id == 7
    assert final.not_proven_reason is None


def test_missing_submitted_body_is_not_proven() -> None:
    outcome, body = artifact_facts(artifact(), "abc123")

    final = finalize_outcome(outcome, "abc123", "abc123", body, [])

    assert final.review_result == "not_proven"
    assert final.publication_result == "not_proven"
    assert final.not_proven_reason == "useful_review_body_not_found_on_github"


def test_candidate_movement_is_stale_not_clean() -> None:
    outcome, body = artifact_facts(artifact(), "abc123")

    final = finalize_outcome(
        outcome,
        "abc123",
        "def456",
        body,
        [submitted_review(body)],
    )

    assert final.review_result == "stale"
    assert final.publication_result == "not_needed"
    assert final.not_proven_reason == "pull_request_head_moved_during_review"


def test_review_match_requires_body_and_observed_head() -> None:
    body = "## Review scope\nclaim"
    reviews = [
        submitted_review(body, head="old"),
        submitted_review("different", head="abc123", review_id=8),
    ]

    assert matching_submitted_review(reviews, "abc123", body) is None
