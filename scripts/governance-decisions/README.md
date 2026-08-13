# Authenticated governance decisions

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "scripts/governance-decisions.mjs",
    "symbol": "runCommand"
  },
  "results": [
    {
      "path": "scripts/governance-decisions/governance-decision-transition.mjs",
      "symbol": "computeGovernanceDecisionTransition"
    },
    {
      "path": "scripts/governance-decisions/governance-decision-commit-verification.mjs",
      "symbol": "verifyGovernanceDecisionCommit"
    },
    {
      "path": "scripts/governance-decisions/github-governance-publication.mjs",
      "symbol": "publishGovernanceDecisionCommit"
    },
    {
      "path": "scripts/governance-decisions/governance-decision-remote-verification.mjs",
      "symbol": "verifyPublishedGovernanceDecisionCommit"
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

[`scripts/governance-decisions.mjs#runCommand`](../governance-decisions.mjs#runCommand) is the
single command entry. Preview reads the exact expected Git tree, validates the canonical request,
and calls
[`governance-decision-transition.mjs#computeGovernanceDecisionTransition`](./governance-decision-transition.mjs#computeGovernanceDecisionTransition).
The core returns sorted additions, deletions, bypassed domain invariants, and non-receipt content
identities without mutating the caller's repository.

[`governance-decision-commit-verification.mjs#verifyGovernanceDecisionCommit`](./governance-decision-commit-verification.mjs#verifyGovernanceDecisionCommit)
owns structural verification. It accepts injected parent and candidate snapshot reads and
requires one canonical immutable receipt plus precisely its operation-allowed declared changes.
[`governance-decision-remote-verification.mjs#verifyPublishedGovernanceDecisionCommit`](./governance-decision-remote-verification.mjs#verifyPublishedGovernanceDecisionCommit)
then binds that result to the GitHub-verified User or App author and, for workflow decisions, the
exact originating dispatch run.

[`github-governance-publication.mjs#publishGovernanceDecisionCommit`](./github-governance-publication.mjs#publishGovernanceDecisionCommit)
owns the atomic publication contract. Local callers must be the current `gh` user with effective
repository `admin` permission and must have a completely clean checkout whose `HEAD` and current
remote `main` both equal the request head. The workflow derives its human actor from the trusted
dispatch context and publishes through the same transition and receipt path.

## Commands

- `npm run governance:decide -- preview --request <request.json>` prints the deterministic
  transition.
- `npm run governance:decide -- apply --request <request.json>` authenticates and creates one
  expected-head-bound default-branch commit.
- `npm run governance:decide -- publish-blob --file <file>` uploads exact bytes as an unreferenced
  Git blob after administrator authentication.
- `npm run governance:decide -- publish-request --request <request.json>` validates and uploads the
  canonical request bytes.
- `npm run governance:decide -- verify-commit --commit <oid>` verifies both the exact structural
  transition and its remote GitHub identity.

## Workflow rollout boundary

Create the protected `governance-decisions-main` environment before enabling apply. Its deployment
branch policy permits only `main`, administrators cannot bypass it, `GOVERNANCE_APP_ID` is an
environment variable, and `GOVERNANCE_APP_PRIVATE_KEY` is an environment secret.
`GOVERNANCE_APP_SLUG` is a repository variable so credential-free decision classifiers can verify
the App author. The installed App has only Metadata read and Contents write. The apply job requires
an exact Contents-write token, binds the token action's App-slug output to both the repository
variable and the trusted `governance-decisions` slug, and passes that checked output into the
publication command. The workflow's first job has no App credential and proves the exact main
workflow source, main tip, request head, and current human administrator. The environment job
repeats those checks before creating the App token.

Mirrored behavior tests live in `packages/tests/repo/governance-decisions/` and run with
`npm run test:governance-decisions`.
