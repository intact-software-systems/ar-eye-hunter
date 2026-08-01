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

## Exact Pressure-Scenario Matrix

### 1. Construction And Runtime Timelines

- **Prompt intent:** Separate construction/registration from runtime invocation
  for every materially distinct family.
- **Baseline:** **FAIL.** Construction order and callback timing were reviewed,
  but one representative callback trace could satisfy the prose.
- **Amended:** **PASS.** “Family-level code-derived trace as two distinct
  timelines” names dependency creation/ownership, registration, earliest
  invocation, and proof that dependencies exist before runtime.

### 2. Transaction-Callback Escape

- **Prompt intent:** Fail closed when mutable state escapes a transaction
  callback.
- **Baseline:** **FAIL.** General `const`, retry, and transaction-ownership rules
  neither prohibited the escape nor required callback-contract proof.
- **Amended:** **PASS.** “Mutable values do not escape a transaction callback”
  without invocation-count, retry, commit, failure, and safety proof; immutable
  durable/private results are preferred.

### 3. Construction-Warning Disposition

- **Prompt intent:** Disposition changed-production construction warnings
  without globally blocking optional diagnostics.
- **Baseline:** **PASS, but broad.** Warnings had to be reviewed and could be
  rejected by human judgment, but the evidence shape was implicit.
- **Amended:** **PASS, explicit.** Every warning records path, rule, symbol, and
  a fixed/false-positive/owned-debt disposition; warning-only success is
  insufficient and global strictness is unchanged.

### 4. Temporary Ratchets

- **Prompt intent:** Give migration ratchets owners, removal conditions, and
  supplementary status.
- **Baseline:** **FAIL.** No lifecycle rule existed for literal, case, assertion,
  or tree-count ratchets.
- **Amended:** **PASS.** Every temporary ratchet has an owner and removal
  condition and remains supplementary until semantic coverage replaces it
  after publication.

### 5. Canonical Realtime Owners

- **Prompt intent:** Direct reviewers to canonical post-PR-#59 realtime owners.
- **Baseline:** **FAIL.** The realtime skill still presented `services/**` as
  the server room/group owner.
- **Amended:** **PASS.** `group-state/**`, `topology/inbox/**`, and
  `rtc-topology/inbox/**` are canonical; those capabilities cannot gain
  canonical implementations under compatibility-only `services/**`.

### 6. Behavior-Named Semantic Tests

- **Prompt intent:** Prefer behavior-named semantic boundary tests over
  task-history names and counts.
- **Baseline:** **PASS, but distributed.** Existing naming and mutation-behavior
  rules rejected historical names and count-only proof without one concise
  boundary checklist.
- **Amended:** **PASS, explicit.** Behavior-named modules assert entry,
  transaction, commit return, after-commit, failure, cleanup, and final result;
  count ratchets never replace them.

### 7. Large-Review Decision

- **Prompt intent:** Require a deliberate review shape for a cohesive 101-file
  pull request.
- **Baseline:** **FAIL.** Cohesive-milestone guidance contained no size
  threshold, stacked-versus-single decision, or read-first map.
- **Amended:** **PASS.** More than 100 files and the other approved thresholds
  require a written decision, never an automatic split, plus a one-screen
  read-first map when one pull request is retained.

### 8. Current Publication Evidence

- **Prompt intent:** Block completion when published evidence belongs to older
  code.
- **Baseline:** **PASS, but broad.** Existing completion gates required the
  final feature SHA and rejected older workflow runs but did not name the full
  evidence record.
- **Amended:** **PASS, explicit.** “Stale evidence blocks completion” until the
  head, tree, run, attempt, conclusion, and verified SHA are current.

Two GREEN follow-ups closed real loopholes rather than changing the scenario
contract. Scenario 1 originally separated registration from invocation but did
not require two independently complete timelines or prove dependencies existed
before first invocation. Scenario 5 originally qualified compatibility-only
paths as “applicable old” paths, leaving room to place a new canonical owner
under `services/**`. The final wording closes both interpretations.

## Validation

- Prettier verification on all eight changed guidance files: pass.
- `git diff --check`: pass.
- Task 2 integrity batch without the Task 3 provenance suite: 8 files and 70
  tests passed.
- Exact Task 1 nine-file batch: 73 tests passed; only the intentional Task 3
  missing-provenance-document test failed.
- `npm run test:repo-governance`: 188 tests passed; only that same intentional
  Task 3 test failed.
- Review-fix checklist RED: the final outcome still allowed only one
  representative input; the new focused assertion failed on that exact phrase.
- Review-fix checklist GREEN: the final outcome now requires the authoritative
  family-level two-timeline evidence and variant inventory.

## Concerns And Next Work

Task 3 must create and independently verify the 17-row, 48-target provenance
document before the complete governance command can be green. Task 2 adds no
automation proposal and changes no checker behavior.
