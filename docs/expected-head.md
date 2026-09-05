# Expected pull-request head

The optional `expected_head_sha` input binds a Droid invocation to one full,
40-character pull-request head SHA. The action reads the live pull-request
metadata and fails before generating a prompt when that head does not match.

An empty or whitespace-only value means the input was not supplied and preserves
the existing live-PR checkout behavior. Every other value must be exactly 40
hexadecimal characters. Malformed and abbreviated SHAs fail the invocation
instead of being accepted or ignored.

Review and security modes additionally require the expected commit to already
exist in the caller's checkout, then detach that exact commit before computing
the diff. They do not replace it with a later mutable branch head. Fill mode
consumes the matching metadata snapshot but does not change the source tree.

Callers should check out the captured SHA before invoking the action and retain
the SHA in their own receipt. A pull request can still advance after the action
has captured and validated its inputs; later output therefore belongs to the
recorded SHA and may be stale against a subsequent head.
