# Authenticated governance decisions

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "scripts/governance-decisions.mjs",
    "symbol": "previewDecision"
  },
  "results": [
    {
      "path": "scripts/governance-decisions/governance-decision-transition.mjs",
      "symbol": "computeGovernanceDecisionTransition"
    },
    {
      "path": "scripts/governance-decisions/governance-decision-commit-verification.mjs",
      "symbol": "verifyGovernanceDecisionCommit"
    }
  ],
  "failures": [
    {
      "path": "scripts/governance-decisions.mjs",
      "symbol": "toError"
    }
  ]
}
```

[`scripts/governance-decisions.mjs#previewDecision`](../governance-decisions.mjs#previewDecision)
is the read-only local entry into the deterministic decision core. It reads the exact expected
Git tree, validates the canonical request, and calls
[`governance-decision-transition.mjs#computeGovernanceDecisionTransition`](./governance-decision-transition.mjs#computeGovernanceDecisionTransition).
The core returns sorted additions, deletions, bypassed domain invariants, and non-receipt content
identities without mutating the caller's repository.

[`governance-decision-commit-verification.mjs#verifyGovernanceDecisionCommit`](./governance-decision-commit-verification.mjs#verifyGovernanceDecisionCommit)
owns local structural verification. It accepts injected parent and candidate snapshot reads and
requires one canonical immutable receipt plus precisely its operation-allowed declared changes.
Remote actor and workflow authentication deliberately remain outside this core until the trusted
publication capability is installed.

## Commands

- `npm run governance:decide -- preview --request <request.json>` prints the deterministic
  transition.
- `npm run governance:decide -- verify-commit --commit <oid> --parent <oid>` verifies local
  structure without authenticating a remote author.
- `apply`, `publish-blob`, and `publish-request` decode now but fail at the single explicit trusted
  publication boundary owned by the next implementation slice.

Mirrored behavior tests live in `packages/tests/repo/governance-decisions/` and run with
`npm run test:governance-decisions`.
