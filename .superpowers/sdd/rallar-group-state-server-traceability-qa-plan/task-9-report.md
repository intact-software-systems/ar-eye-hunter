# Task 9 report — immutable AppInbox transaction result and narrow mutation capability

## Start and scope

Task 9 started from exact commit
`9b1dd873b183132a4379dd532c8fc516dbc2dfd4` and tree
`b9094e7ccc77eff6318b1644cbc5916afc2babf7`. It changes only the approved
AppInbox transaction owner, group inbox handler/capability wiring, exact
presence-connect input type, directly owned behavior/source ratchets, and this
Task 9 evidence. Task 10 names and files remain untouched.

## Test-first evidence

The predecessor focused selection passed six behavior files / 105 tests. The
existing future target file then failed exactly twelve cases: the two Task 9
immutable-result/narrow-capability cases and the ten reserved Task 10 naming
cases. After adding the stronger Task 9 fixtures but before production changes,
the exact transaction selection had 19 failures / 2 passes. The failures
showed the old broad dependency and mutable callback escape directly; the
durable-only compatibility fixture remained GREEN.

Task 9 GREEN passes seven selected transaction-result cases and thirteen
transaction, failure, operation, retry, idempotency, presence, and routing
files / 143 tests. The broad group-state/AppInbox compatibility selection,
excluding only the intentional future Task 10 cases in the combined target
file, passes 56 files / 280 tests. The complete combined future file now fails
exactly its ten Task 10 cases and has seven Task 9 cases GREEN.

## Implementation ownership

`AppInboxTransactionWriter.writeFinalizedMutation` is the single transaction,
durable-result replacement, reservation-finalization, and finalization-record
owner. Existing `writeMutation` projects the durable result as both persisted
and caller-visible data. `writeMutationWithAfterCommitResult` projects only
`durableResult` into persistence/finalization and returns the complete immutable
`AppInboxMutationTransactionResult` only after `runInTransaction` succeeds.
No compound result is serialized.

`GroupStateInboxHandler.commitMutation` returns
`{ durableResult, afterCommitResult: { committedSnapshot } }` from its callback,
destructures that value after commit, observes the exact snapshot object, wakes
in predecessor order, and returns only the durable result. All four real-path
transaction failures leave the writer pending and expose no result, snapshot,
observation, wake, event, or final outbox state.

`GroupStateInboxMutationOperations` contains exactly `read`, `compute`,
`validate`, `write`, `sessionGenerationLifecycle`, and `observeSnapshot`.
The handler and presence-connect function consume it; the existing broad
`GroupStateService` supplies it structurally. Preparation, listing, paging,
events, cache queries, and unrelated lifecycle operations are excluded. The
broad exported service, factory result, compatibility exports, and consumers do
not change.

## Compatibility and structure

The independently authored raw create-group JSON remains byte-for-byte equal,
with the same outer/snapshot/event key order, and contains no private
`committedSnapshot`. The exact committed snapshot identity crosses the commit
return boundary once. The durable-only writer returns and finalizes the same
object identity with unchanged JSON property order. Existing retry, operation,
idempotency, presence, receipt, event, outbox, finalization, public return, and
post-finalization recovery tests pass.

`AppInboxService.ts` is an existing 729-line public base. Task 9 changes one
line, from a private transaction-writer field to a protected field, so the
existing AppGroup subclass can call the writer's exact internal operation. Its
four pre-existing over-60-line functions and module line count remain exact and
are pinned by the changed-source ratchet. Broadly decomposing that public base
would expand Task 9 and is not required to expose this immutable result.
All other changed modules and functions remain within their limits; runtime
imports remain acyclic.

## Validation

- Focused Task 9 result: 1 file / 7 passed / 10 intentionally skipped Task 10
  cases.
- Transaction, failure, operation, retry, idempotency, presence, and routing:
  13 files / 143 tests passed.
- Broad group-state/AppInbox compatibility: 56 files / 280 tests passed.
- Source, mirrored-tree, active-path, and owner ratchets: 4 files / 26 tests
  passed.
- Shared-server TypeScript passed with no emit.
- Changed-style comparison against exact base
  `a7a5f488cd185a7f2cc6bd814c319f97d5401d03` passed with no new finding.
- Prettier passed for the ordinarily formatted Task 9 files; the two inherited
  four-space AppInbox owners retain narrow semantic diffs instead of broad
  file-wide reformatting. `git diff --check` passed, and regular versus
  ignore-all-space stats prove those owners contain no formatting churn.

## Review

Self-review: Critical 0 / Important 0. The transaction owner exposes private
data only after commit, persists/finalizes only durable data, shares one write
sequence, and preserves every pre-existing failure/retry/public path. The
capability is exact and internal. Fresh independent re-review accepted Critical
0 / Important 0 at exact milestone head
`7556238729da5b485ca4811f2ee806d67205a1c0` and tree
`f2358d6cf946a59a4ae3f66c3c185f7b89d9d3b5`.
