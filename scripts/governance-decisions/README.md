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
    },
    {
      "path": "scripts/governance-decisions/governance-decision-receipt-index.mjs",
      "symbol": "readOriginMainGovernanceDecisionIndex"
    },
    {
      "path": "scripts/governance-decisions/governance-decision-admission-verification.mjs",
      "symbol": "verifyGovernanceDecisionAdmission"
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
identities without mutating the caller's repository. Current preview, publication, and apply accept
only focused gate deviations and durable policy exceptions. Active-plan operations are retired.

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
- `npm run governance:decide -- publish-request --request <request.json>` validates and uploads the
  canonical request bytes.
- `npm run governance:decide -- verify-commit --commit <oid>` verifies both the exact structural
  transition and its remote GitHub identity.

Preview is optional. A human administrator may apply directly. An AI must show the exact canonical
request and expected main head, obtain one just-in-time approval for that atomic mutation, and then
apply without further decision prompts. A changed request or expected head invalidates that
approval. Never hand-write a decision receipt, directly edit or delete a plan, fabricate completion
or review evidence, or manually construct tracked governance evidence as a substitute for this
command. This exception path is not ordinary pull request completion evidence.

Gate deviations retain the exact failed run, attempt, gate, and candidate evidence. The reusable
Governance Gate reports `accepted-deviation` separately from `passed`, and Branch Release Gate alone
turns that exact verified resolution into merge eligibility. Exception approvals project into the
existing repository-structure, production-legacy, code-style, and test-coupling contracts; existing
durable registries and static dispositions remain valid. Trusted historical receipts are read only
from an explicit `origin/main` revision and structurally replayed with GitHub-verified User or App/run
provenance. The replay reader still understands already-published plan-operation receipts, but no
current command creates, adapts, supersedes, completes, cancels, or quarantines plans. Historical
receipts also require durable admission evidence from the exact `main` push run of the
trusted deploy workflow: its classifier job, `verify-commit` step, and fail-closed resolution step
must all have completed for the exact decision commit and run attempt, and its uniquely named
authenticated-admission marker must have succeeded. The trusted workflow runs that marker only
when the unmasked `verify` outcome succeeded, `decision_only` is true, and `invalid_governance` is
false; consumers do not treat the potentially masked Jobs API verify-step conclusion as proof by
itself. That successful marker is the durable proof that the live administrator check occurred when
the decision entered `main`.
A pull-request-head receipt, a handcrafted squash/rebase-style receipt, or ambiguous run/job
evidence fails closed. Historical reads intentionally do not re-query the actor's current permission
after this exact admission has been proved.

## Workflow rollout boundary

Create the protected `governance-decisions-main` environment before enabling apply. Its deployment
branch policy permits only `main` and administrators cannot bypass it. `GOVERNANCE_APP_ID` and
`GOVERNANCE_APP_SLUG` are repository variables; `GOVERNANCE_APP_PRIVATE_KEY` is a repository Actions
secret. `GOVERNANCE_APP_SLUG` is a repository variable so credential-free decision classifiers can verify
the App author. The installed App has only Metadata read and Contents write. The apply job requires
an exact Contents-write token, binds the token action's App-slug output to both the repository
variable and the trusted `governance-decisions` slug, and passes that checked output into the
publication command. The workflow's first job has no App credential and proves the exact main
workflow source, main tip, request head, and current human administrator. The environment job
repeats those checks before creating the App token.

The default-branch ruleset bypass list must contain only the dedicated governance App and the
repository-admin role for these fixed authenticated operations. It must not grant any additional
bot, workflow, maintainer, or other role a bypass. Repository administrators are authorized by
policy and agent guidance to use their bypass only through these fixed decisions; ordinary changes
remain pull-request-based. The
workflow's built-in token supplies read-only Actions evidence before the App token is created; the
App remains limited to Metadata read and Contents write.

Mirrored behavior tests live in `packages/tests/repo/governance-decisions/` and run with
`npm run test:governance-decisions`.
