# PR Human Review navigation map

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "scripts/pr-human-review.mjs",
    "symbol": "runReviewCheck"
  },
  "results": [
    {
      "path": "scripts/pr-human-review/validate-record.mjs",
      "symbol": "validateReviewRecord"
    },
    {
      "path": "scripts/pr-human-review/trusted-retained-legacy.mjs",
      "symbol": "validateRetainedLegacy"
    }
  ],
  "failures": [
    {
      "path": "scripts/pr-human-review/read-review-input.mjs",
      "symbol": "failInput"
    }
  ]
}
```

[scripts/pr-human-review.mjs#runReviewCheck](../pr-human-review.mjs#runReviewCheck)
is the canonical command entry. It reads local evidence files or a GitHub pull-request event,
resolves the candidate plan and Git objects as data, and passes one input to
[validate-record.mjs#validateReviewRecord](./validate-record.mjs#validateReviewRecord). The command
exits zero with the v2 PASS line or prints each deterministic evidence failure and exits non-zero.

## Review validation family

- [validate-record.mjs#validateReviewRecord](./validate-record.mjs#validateReviewRecord) parses the
  v2-only fence, validates record scope and plan identity, and selects draft versus ready gates.
- [validate-review-evidence.mjs#validateInitialReview](./validate-review-evidence.mjs#validateInitialReview),
  [validate-review-evidence.mjs#validateCheckpointReview](./validate-review-evidence.mjs#validateCheckpointReview),
  and [validate-review-evidence.mjs#validateFinalReview](./validate-review-evidence.mjs#validateFinalReview)
  own architecture, checkpoint, final, visible-field, owner-path, finding, and ledger validation.
- [review-freshness.mjs#computeBuildAffectingTreeDigest](./review-freshness.mjs#computeBuildAffectingTreeDigest)
  and [review-freshness.mjs#readCurrentPlanContext](./review-freshness.mjs#readCurrentPlanContext)
  own build-tree and adaptive-plan content digests.

## Retained-legacy family

- [validate-legacy-item.mjs#validateLegacyItemShape](./validate-legacy-item.mjs#validateLegacyItemShape)
  owns candidate item and aggregate shape.
- [trusted-retained-legacy.mjs#validateRetainedLegacy](./trusted-retained-legacy.mjs#validateRetainedLegacy)
  owns whole-ledger hashing, trusted human approval, post-approval history, and registry proof.
- [scripts/check-pr-human-review-legacy-stages.mjs#runStage](../check-pr-human-review-legacy-stages.mjs#runStage)
  invokes the reusable legacy scanner for the initial and final reviewed Git ranges and rejects a
  non-exact candidate set.

The durable contract is `docs/pr-human-review-record.md`; the visible input template is
`.github/PULL_REQUEST_TEMPLATE.md`; the trusted workflow is
`.github/workflows/pr-human-review-record.yml`. Mirrored focused tests live under
`packages/tests/repo/pr-human-review/` and run through `npm run test:pr-human-review`.

## Trust boundary and failures

The `pull_request_target` workflow runs base-branch scripts. Candidate commits, the current plan,
and the legacy registry are read with Git plumbing only; candidate scripts are never checked out
or executed. Missing or malformed v2 evidence, stale plan/build facts, uncovered owners,
unresolved Critical or Important findings, mismatched candidate reports, and untrusted retained
legacy approvals all fail closed through
[read-review-input.mjs#failInput](./read-review-input.mjs#failInput) or the
deterministic errors returned by `validateReviewRecord`.
