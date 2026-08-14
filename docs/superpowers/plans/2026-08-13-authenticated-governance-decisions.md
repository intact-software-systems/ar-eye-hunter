# Authenticated Governance Decisions Implementation Plan

## Global constraints

- One normal bootstrap branch and pull request owns the plan-to-implementation lifecycle.
- Only fixed, exactly validated governance operations may write the default branch without a PR.
- Any current repository administrator may act alone; actor identity is always derived.
- Domain prerequisites may be bypassed, but structural safety, exact target identity, immutable
  receipts, administrator authentication, and expected-head atomicity never may be bypassed.
- Tests precede production code. Existing ordinary closure and exception registries remain valid.
- Product runtime, database, game, RTC Task 4B, and distributed behavior are out of scope.

## Task 1: Governance decision core

Implement exact request/receipt contracts, canonical serialization, pure repository transitions,
the five plan operations, structural commit verification, package commands, navigation, and
temporary-repository behavior tests. Activate the new capability and complete the
`governance-decision-core` adaptive slice after focused validation passes.

## Task 2: Trusted plan publication

Implement local administrator authentication, workflow main-source preflight and protected
environment boundary, atomic GitHub publication, remote commit/workflow verification,
plan-adaptation acceptance, and exact decision-only classification in the real deploy and Hetzner
workflows. Complete `authenticated-plan-publication`, then checkpoint before activating exception
work.

## Task 3: Authenticated governance exceptions

Implement exact gate deviations and fingerprint-bound exception approval/revocation. Integrate
trusted receipts with the governance aggregator and the production-legacy, repository-structure,
repository-code-style, and test-structure-coupling consumers while preserving their existing
registries. Each consumer owns a fixed canonical candidate projection and delegates only receipt
fingerprinting/applicability to the new owner. Update agent/operator guidance and workflow tests. Complete the
`authenticated-governance-exceptions` slice after focused validation passes.

## Completion

Refresh `origin/main`, record compatibility, run the focused and broad validation matrix, obtain
independent code review and Branch Release Gate evidence, and publish the one bootstrap PR. App
installation, ruleset configuration, merge, and default-branch dogfood are post-PR administrator
operations.
