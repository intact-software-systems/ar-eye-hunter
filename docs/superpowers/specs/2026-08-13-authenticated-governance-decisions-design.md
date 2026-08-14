# Authenticated Governance Decisions Design

## Purpose

Repository administrators need a narrow break-glass path for resolving adaptive-plan and
governance blockers without manufacturing ordinary completion evidence or opening a pull request
whose only purpose is to change governance state. Ordinary product and governance development
remains pull-request based.

## Boundary

`scripts/governance-decisions.mjs` is the command entry. The owned
`scripts/governance-decisions/` capability validates one exact request, computes a deterministic
repository transition from an expected default-branch head, authenticates the administrator, and
writes the transition plus one immutable receipt through GitHub's commit API.

The pure decision boundary supports these operations:

- `plan.repair`, `plan.cancel`, `plan.supersede`, `plan.complete`, and `plan.quarantine`;
- `gate.accept-deviation`; and
- `exception.decide` for production legacy, repository structure, repository code style, and
  test-structure coupling.

No operation accepts arbitrary file content or arbitrary changed paths. Plan supersession is the
only operation that installs caller-supplied repository content, and it accepts one immutable Git
blob that must decode as the exact valid successor tactical plan.

## Authentication and atomicity

Every request names the repository, default branch, exact expected head, fixed operation, exact
target, `force: true`, and a non-empty reason. Actor and permission fields are forbidden. The local
transport derives its actor from `gh`; the workflow derives its actor from `github.actor`. Both
require current effective `admin` permission.

Application uses GitHub's GraphQL `createCommitOnBranch` mutation with the request's expected head.
A stale head writes nothing. Local application uses the authenticated administrator's `gh` token.
The verifier reads the resulting commit through the GitHub API and requires
`verification.verified: true` plus a linked commit author whose login equals the recorded actor.
Missing, ambiguous, or mismatched author/verification data fails closed.

The workflow uses a repository-installed GitHub App limited to Metadata read and Contents write.
Its secret is exposed only to an apply job in a `governance-decisions-main` environment whose
deployment-branch policy permits only `main`. A preceding job has no App credentials and requires
the exact default-branch workflow ref, `refs/heads/main`, a workflow SHA equal to the current remote
main head, and a currently authorized administrator. Only that successful preflight unlocks the
environment job. The App author must be the configured `<GOVERNANCE_APP_SLUG>[bot]` identity.

## Durable evidence

Each applied decision adds
`governance/decisions/<sha256-of-canonical-request>.json`. The canonical receipt records the
request digest and normalized request, authenticated actor, transport, semantic result, sorted
bypassed invariants, and exact before/after content identities for every non-receipt change. The
receipt is excluded from its own change set to avoid circular hashing. Existing receipts are
append-only; revocation is a new decision.

Plan dispositions never synthesize a normal `plan-adaptation-closure-v1` receipt. Cancellation
records `not-achieved`, forced completion records `admin-attested`, supersession records
`transferred`, and quarantine records `unknown`. Plan adaptation recognizes the governance receipt
as a distinct authenticated transition while preserving normal closure behavior. Repair changes
only the target plan; cancellation, completion, and quarantine delete only the target; supersession
replaces only its predecessor with its successor. No plan operation writes a shared registry or
tracked overview, and other active or postponed plans remain untouched.

Gate deviations preserve the failed underlying evidence and expose `accepted-deviation` as a
separate governance result. Exception approvals bind to an exact selector, candidate head, and
content fingerprint; a changed fingerprint or later revoke receipt makes the approval inapplicable.

Each exception consumer owns its canonical candidate projection:

- repository structure uses the existing rule, target, owner, and review/removal condition;
- production legacy uses the existing retained-ledger projection and ledger SHA-256;
- repository code style uses rule, path, optional symbol, magnitude, and candidate head; and
- test-structure coupling uses the exact candidate, linked semantic contract, disposition, and
  candidate head.

The governance-decisions capability canonicalizes and fingerprints those fixed projections and
resolves applicable/revoked receipts. Its historical exception/gate index deliberately ignores
plan-disposition receipts, which remain owned by plan-transition authentication. Each checker
retains its domain policy and existing registry.
A valid registry entry or a currently applicable receipt may authorize the exact candidate; a
receipt never masks malformed unrelated registry data. Revoke targets one prior approval decision
ID. Receipt-path collision always fails, even when the bytes match; callers create a new request
against the new head rather than treating a repeated mutation as idempotent.

## Verification and workflow classification

Commit verification checks that a commit adds exactly one receipt plus precisely its declared
state changes. Local receipts require a GitHub-verified commit whose linked user is the recorded
administrator. Workflow receipts require the configured App author and the matching
`workflow_dispatch` run, attempt, parent head, and human administrator. Remote ambiguity fails
closed.

An exact verified governance-decision commit may skip runtime deployment and distributed
validation. Both `deploy.yml` and `hetzner-supported-distributed-manifests.yml` run a no-secret
classification job first. That job checks out the exact main commit, calls `verify-commit`, and
publishes a boolean consumed only by named downstream deployment/distributed jobs. Exact decisions
still run repository governance checks. Mixed, malformed, forged, unverifiable, or additional
changes produce `decision-only: false` and use every existing workflow path. CodeQL is unchanged.

## Operator flow

`preview` is optional and read-only. `apply` repeats all validation and performs one atomic
mutation. `publish-blob` and `publish-request` make large immutable inputs addressable without a
branch. `verify-commit` is the CI and operator verification entry.

The first deployment uses one ordinary feature PR. After it merges and administrators configure
the App and ruleset, the workflow closes this implementation's adaptive plan with
`plan.complete`; that direct commit is the initial end-to-end proof.
