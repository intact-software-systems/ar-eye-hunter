# Task 2 Report — PR A Guidance Contract

## Scope

Implemented only the eight approved guidance owners. No checker, parser,
schema, strictness, debt calculation, lineage manifest, runtime, dependency,
workflow, provenance-document, or test-rename behavior changed.

## Test-first RED

Before editing guidance, the exact nine-file Task 1 batch produced the planned
RED state:

- 68 tests passed and five tests failed;
- the four Task 2 failures were the family trace/canonical-owner contract, the
  large-review evidence contract, the human warning/ratchet review contract,
  and behavior-named semantic testing guidance; and
- the fifth failure was the intentionally pending Task 3 provenance document.

The old-guidance pressure agent independently found that dual family timelines,
transaction-callback escape safety, temporary-ratchet governance, canonical
post-PR-#59 realtime owners, and large-review decisions were not reliably
taught. Existing prose only broadly covered warning review, behavior-based
tests, and stale workflow evidence.

## GREEN And Pressure Refinement

The amended guidance now requires:

- separate construction/registration and runtime-invocation timelines for each
  materially distinct callback, transaction, retry, protocol, or lifecycle
  family;
- creation/ownership and earliest-invocation proof for every required or
  captured dependency;
- a fail-closed rule for mutable values escaping transaction callbacks and an
  immutable durable/private result preference;
- human disposition of every changed-production construction warning without
  making optional warnings globally blocking;
- temporary-ratchet owners, removal conditions, and semantic-test supremacy;
- canonical `group-state/**`, `topology/inbox/**`, and
  `rtc-topology/inbox/**` owners, with no canonical implementation for those
  capabilities under compatibility-only `services/**` paths;
- behavior-named tests with semantic entry, transaction, commit-return,
  after-commit, failure, cleanup, and final-result assertions; and
- explicit stacked-versus-single decisions at the approved review-pressure
  thresholds, a read-first map for an accepted single large PR, and current
  head/tree/workflow evidence.

The first amended-guidance pressure pass exposed missing proof that captured
dependencies exist before first invocation. A second fresh pass exposed an
overly qualified `services/**` statement. Both loopholes were closed, and the
final pressure disposition accepted all eight scenarios.

## Validation

- Prettier verification on all eight changed guidance files: pass.
- `git diff --check`: pass.
- Task 2 integrity batch without the Task 3 provenance suite: 8 files and 69
  tests passed.
- Exact Task 1 nine-file batch: 72 tests passed; only the intentional Task 3
  missing-provenance-document test failed.
- `npm run test:repo-governance`: 187 tests passed; only that same intentional
  Task 3 test failed.

## Concerns And Next Work

Task 3 must create and independently verify the 17-row, 48-target provenance
document before the complete governance command can be green. Task 2 adds no
automation proposal and changes no checker behavior.
