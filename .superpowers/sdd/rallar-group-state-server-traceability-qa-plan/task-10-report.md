# Task 10 report — internal names and retained presence ownership

## Start and scope

Task 10 started from exact commit
`7556238729da5b485ca4811f2ee806d67205a1c0` and tree
`f2358d6cf946a59a4ae3f66c3c185f7b89d9d3b5`. It changes only the approved
target-identity, computed-result, and mutation-write internal names; their
direct callers; the one mirrored write-owner test path; exact source/test
inventories; and Task 10 evidence. No package compatibility export, checker,
dependency, lockfile, workflow, TypeScript setting, persistence contract, or
AppInbox owner changes.

## Test-first evidence

Before implementation,
`group-state-inbox-transaction-result.test.ts` failed exactly its ten reserved
Task 10 cases while all seven Task 9 transaction-result cases passed. The
failures named the three absent target symbols, two absent target paths, absent
behavior test path, three retained predecessor names/paths, and absent primary
write symbol at the target path.

After the exact moves and renames, the same suite passes 17/17. The test reads
`computeGroupMutationWrite` from its actual pure computed-result owner rather
than incorrectly requiring that symbol in the separate persistence write
owner. That correction makes the existing RED assertion follow the ownership
contract in Section 4.3 and does not add a production workaround.

## Implementation and compatibility

- `resolve-group-mutation-target-identity.ts` exports the exact two approved
  resolver names. Their branches, values, null behavior, and direct read and
  validation callers are unchanged.
- `group-mutation-result.ts` exports `computeGroupMutationWrite`. Its body,
  input fields, returned property order, defaults, event/receipt/outbox
  construction, and errors are unchanged. The descriptive internal input name
  `GroupMutationWriteInput` lets the longer primary function name remain at the
  hard 60-line limit without adding a helper or alias.
- `write-group-mutation.ts` is a 100% Git rename and still exports
  `writeGroupMutation`; conditional guard, authoritative effects, event,
  receipt, final outbox, and sequential fallback order are byte-identical.
- `write-group-mutation-behavior.test.ts` retains its one named case, fixtures,
  literals, and five `expect(...)` sites; only the canonical owner import
  changes.
- Internal callers import the canonical owners directly. No old internal path
  remains and no re-export or second hop was added.

The final PR #59 prerequisite already had direct presence lifecycle functions
at blob `e2e642d54bcbd9b7ff04917ef9d900e39d3827c8`. Its compatibility file blob
`b811c2f7429e2e10ab0fecf1998b0a7d9f7dd052` is byte-identical in this
candidate. The current direct owner differs only by Task 9's already-reviewed
type and property narrowing to the six-operation inbox capability. Task 10
does not change presence implementation, lifecycle, exports, or consumers.

## Validation

- Exact future/transaction target: 1 file / 17 tests passed after exactly 10
  intended RED failures and 7 predecessor passes.
- Mutation, operation, retry, idempotency, presence, authoritative-phase, and
  owner batch: 23 files / 113 tests passed.
- Source tree, changed-owner limits, active paths, runtime cycles, presence
  owner, and authoritative phase batch: 4 files / 43 tests passed.
- Complete mirrored group-state suite: 51 files / 235 tests passed.
- Surrounding AppInbox, middleware, topology/RTC, source-tree, and public-owner
  compatibility batch: 10 files / 174 tests passed.
- Shared-server TypeScript passed with no emit.
- Prettier, staged diff checks, exact changed-style comparison against
  `a7a5f488cd185a7f2cc6bd814c319f97d5401d03`, the 400/60-line ratchet, and
  runtime-cycle analysis pass. `computeGroupMutationWrite` is exactly 60 lines.

## Review

Self-review is Critical 0 / Important 0. The only production diffs are the
approved internal symbol/path substitutions and direct imports; the write
owner is a 100% rename, the pure computed-result body is unchanged, old private
paths are absent, compatibility owners are unchanged, every target name matches
its filename/role, and no new runtime dependency or cycle exists. Fresh
independent re-review accepted Critical 0 / Important 0 / Minor 0 at exact
milestone head `41ae45afa268d186e65dfe0188be7f146ee80f7e` and tree
`c6373a00e686bae64f7bc5b3361798fbfb105f98`.
