#!/usr/bin/env python3
"""Compile a fail-honest Droid review outcome from the validated artifact.

The composite action calls this after the validator.  The validated artifact is
review evidence, not publication proof, so clean/findings results are accepted
only when the exact useful review body can also be found in GitHub's submitted
review list for the observed candidate.
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from typing import Any, Callable, Iterable

ALLOWED_RESULTS = {"clean", "findings", "not_proven", "stale"}


@dataclass
class ReviewOutcome:
    review_result: str = "not_proven"
    publication_result: str = "not_proven"
    candidate_count: int = 0
    validated_count: int = 0
    approved_inline_count: int = 0
    independent_finding_count: int = 0
    review_body_submitted: bool = False
    observed_head: str = ""
    current_head: str = ""
    not_proven_reason: str | None = None
    submitted_review_id: int | None = None
    artifact_version: int | None = None


def load_validated_artifact(path: pathlib.Path) -> tuple[dict[str, Any] | None, str | None]:
    if not path.is_file():
        return None, "validated_artifact_missing"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return None, f"validated_artifact_invalid:{type(exc).__name__}"
    if not isinstance(value, dict):
        return None, "validated_artifact_not_object"
    return value, None


def artifact_facts(artifact: dict[str, Any], expected_head: str) -> tuple[ReviewOutcome, str]:
    outcome = ReviewOutcome(observed_head=expected_head)
    version = artifact.get("version")
    outcome.artifact_version = version if isinstance(version, int) else None

    if version != 2:
        outcome.not_proven_reason = "validated_artifact_version_not_supported"
        return outcome, ""

    meta = artifact.get("meta")
    results = artifact.get("results")
    independent = artifact.get("independentFindings")
    summary = artifact.get("reviewSummary")
    if not isinstance(meta, dict):
        outcome.not_proven_reason = "validated_meta_not_object"
        return outcome, ""
    if not isinstance(results, list):
        outcome.not_proven_reason = "validated_results_not_array"
        return outcome, ""
    if not isinstance(independent, list):
        outcome.not_proven_reason = "independent_findings_not_array"
        return outcome, ""
    if not isinstance(summary, dict):
        outcome.not_proven_reason = "review_summary_not_object"
        return outcome, ""

    artifact_head = meta.get("headSha")
    if not isinstance(artifact_head, str) or not artifact_head:
        outcome.not_proven_reason = "validated_head_missing"
        return outcome, ""
    outcome.observed_head = artifact_head
    if artifact_head != expected_head:
        outcome.review_result = "stale"
        outcome.not_proven_reason = "validated_head_does_not_match_expected_head"
        return outcome, ""

    outcome.candidate_count = len(results)
    outcome.validated_count = len(results)
    outcome.approved_inline_count = sum(
        1
        for item in results
        if isinstance(item, dict) and item.get("status") == "approved"
    )
    outcome.independent_finding_count = len(independent)

    declared_result = summary.get("result")
    body = summary.get("body")
    declared_reason = summary.get("notProvenReason")
    if declared_result not in ALLOWED_RESULTS:
        outcome.not_proven_reason = "review_result_invalid"
        return outcome, ""
    if not isinstance(body, str) or not body.strip():
        outcome.not_proven_reason = "useful_review_body_missing"
        return outcome, ""

    outcome.review_result = declared_result
    if declared_result == "not_proven":
        outcome.not_proven_reason = (
            declared_reason.strip()
            if isinstance(declared_reason, str) and declared_reason.strip()
            else "validator_reported_not_proven"
        )
        outcome.publication_result = "not_needed"
    elif declared_result == "stale":
        outcome.not_proven_reason = (
            declared_reason.strip()
            if isinstance(declared_reason, str) and declared_reason.strip()
            else "validator_reported_stale"
        )
        outcome.publication_result = "not_needed"

    return outcome, body.strip()


def matching_submitted_review(
    reviews: Iterable[dict[str, Any]], expected_head: str, expected_body: str
) -> dict[str, Any] | None:
    normalized_body = expected_body.strip()
    for review in reviews:
        if not isinstance(review, dict):
            continue
        body = review.get("body")
        commit_id = review.get("commit_id")
        state = review.get("state")
        if (
            isinstance(body, str)
            and body.strip() == normalized_body
            and commit_id == expected_head
            and state in {"COMMENTED", "APPROVED", "CHANGES_REQUESTED"}
        ):
            return review
    return None


def finalize_outcome(
    outcome: ReviewOutcome,
    expected_head: str,
    current_head: str | None,
    expected_body: str,
    reviews: Iterable[dict[str, Any]] | None,
    provider_error: str | None = None,
) -> ReviewOutcome:
    outcome.current_head = current_head or ""

    if provider_error:
        outcome.review_result = "not_proven"
        outcome.publication_result = "not_proven"
        outcome.not_proven_reason = provider_error
        return outcome

    if current_head != expected_head:
        outcome.review_result = "stale"
        outcome.publication_result = "not_needed"
        outcome.not_proven_reason = "pull_request_head_moved_during_review"
        return outcome

    if outcome.review_result in {"not_proven", "stale"}:
        return outcome

    match = matching_submitted_review(reviews or [], expected_head, expected_body)
    if match is None:
        outcome.review_result = "not_proven"
        outcome.publication_result = "not_proven"
        outcome.not_proven_reason = "useful_review_body_not_found_on_github"
        return outcome

    outcome.review_body_submitted = True
    outcome.publication_result = "posted"
    review_id = match.get("id")
    outcome.submitted_review_id = review_id if isinstance(review_id, int) else None
    outcome.not_proven_reason = None
    return outcome


def github_json(url: str, token: str) -> Any:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "droid-action-safe-review-outcome",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def load_github_state(
    repository: str,
    pr_number: str,
    token: str,
    fetch_json: Callable[[str, str], Any] | None = None,
) -> tuple[str | None, list[dict[str, Any]] | None, str | None]:
    if not repository or "/" not in repository:
        return None, None, "repository_identity_missing"
    if not pr_number.isdigit():
        return None, None, "pull_request_number_invalid"
    if not token:
        return None, None, "github_token_missing"

    fetch = fetch_json or github_json
    base = f"https://api.github.com/repos/{repository}"
    try:
        pull = fetch(f"{base}/pulls/{pr_number}", token)
        current_head = pull.get("head", {}).get("sha")
        if not isinstance(current_head, str) or not current_head:
            return None, None, "pull_request_head_missing"

        reviews: list[dict[str, Any]] = []
        for page in range(1, 11):
            batch = fetch(
                f"{base}/pulls/{pr_number}/reviews?per_page=100&page={page}", token
            )
            if not isinstance(batch, list):
                return current_head, None, "pull_request_reviews_not_array"
            reviews.extend(item for item in batch if isinstance(item, dict))
            if len(batch) < 100:
                break
        return current_head, reviews, None
    except (OSError, urllib.error.URLError, urllib.error.HTTPError, ValueError) as exc:
        return None, None, f"github_review_verification_failed:{type(exc).__name__}"


def set_output(name: str, value: str | int | bool | None) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        return
    rendered = "" if value is None else str(value).lower() if isinstance(value, bool) else str(value)
    with open(output_path, "a", encoding="utf-8") as handle:
        handle.write(f"{name}={rendered}\n")


def main() -> int:
    validated_path = pathlib.Path(os.environ.get("VALIDATED_PATH", ""))
    expected_head = os.environ.get("EXPECTED_HEAD", "")
    repository = os.environ.get("REPOSITORY", "")
    pr_number = os.environ.get("PR_NUMBER", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    receipt_env = os.environ.get("RECEIPT_PATH", "")
    receipt_path = (
        pathlib.Path(receipt_env)
        if receipt_env
        else validated_path.with_name("review_outcome.json")
    )

    artifact, artifact_error = load_validated_artifact(validated_path)
    if artifact_error:
        outcome = ReviewOutcome(
            observed_head=expected_head,
            not_proven_reason=artifact_error,
        )
        body = ""
    else:
        assert artifact is not None
        outcome, body = artifact_facts(artifact, expected_head)

    if outcome.review_result not in {"not_proven", "stale"}:
        current_head, reviews, provider_error = load_github_state(
            repository, pr_number, token
        )
        outcome = finalize_outcome(
            outcome,
            expected_head,
            current_head,
            body,
            reviews,
            provider_error,
        )

    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(
        json.dumps(asdict(outcome), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    fields = {
        "review-result": outcome.review_result,
        "publication-result": outcome.publication_result,
        "candidate-count": outcome.candidate_count,
        "validated-count": outcome.validated_count,
        "approved-inline-count": outcome.approved_inline_count,
        "independent-finding-count": outcome.independent_finding_count,
        "review-body-submitted": outcome.review_body_submitted,
        "observed-head": outcome.observed_head,
        "current-head": outcome.current_head,
        "not-proven-reason": outcome.not_proven_reason,
        "submitted-review-id": outcome.submitted_review_id,
        "receipt-path": str(receipt_path),
    }
    for name, value in fields.items():
        set_output(name, value)

    print(json.dumps(asdict(outcome), sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
