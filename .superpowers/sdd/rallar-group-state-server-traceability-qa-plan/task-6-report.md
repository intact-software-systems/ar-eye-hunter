# Task 6 report — descriptor translation and direct protocol entry

## Scope

Task 6 starts from exact commit
`4e736692112842811204174aef3d27c7135f0acb` and tree
`79728b406d27a21dc571b7dc0ad4315cac1eff7a`. It extracts only the existing
AppInbox-payload-to-`GroupMutationDescriptor` translation, renames the internal
group handler entry, and updates exact direct callers and traceability
inventories. It changes no public package export, persisted value, AppInbox
transaction/retry behavior, dependency, workflow, checker behavior, or later
task owner.

## RED evidence

The isolated future-contract assertion failed because
`processGroupStateMutation` did not exist. After the target-facing tests were
changed first, the focused batch failed because:

- `to-group-mutation-descriptor.ts` could not be imported;
- direct transaction fixtures could not call `processGroupStateMutation`; and
- the authoritative phase trace could not find that direct handler entry.

The other failures in the combined future-only owner remain the deliberately
pending Task 7–10 contracts; Task 6 neither addresses nor relabels them.

## GREEN implementation

`to-group-mutation-descriptor.ts` is the canonical internal
representation boundary. It exports `toGroupMutationDescriptor` and retains the
five predecessor functions with the same switch order, payload casts,
`mutationDescriptor` calls, fields, null/default behavior, errors, and volatile
invocation points. A source comparison against the starting handler found only
the exported modifier and formatter wrapping on the top-level function
signature.

`AppGroupInboxService.prepareAuthenticatedGroupMutation` calls the new boundary
directly before `GroupStateService.prepareMutation`. Registered group callbacks
call `GroupStateInboxHandler.processGroupStateMutation` directly. The handler
has no descriptor pass-through method and retains the preparation validation,
attempt count, presence branch, direct read/compute/validate sequence,
transaction, observation, wake, and result behavior unchanged.

The descriptor fixture now calls the canonical boundary directly for all 17
authenticated `GROUP_*` variants and the exact unsupported-family error. The
mutation-route inventory and reachability tests use the new exact handler name,
and the source ratchet includes the new production owner.

## Mechanical review disposition

Independent review found that the initial private target filename did not match
the exact exported symbol. The target-tree autonomy permits this internal
naming correction, so `to-group-mutation-descriptor.ts` now matches
`toGroupMutationDescriptor` without a compatibility re-export. The local
`layout.primary-export-name` allowance was removed; no checker rule, severity,
output, or strictness changed. The owner is 240 physical lines and each of its
six functions is at most 41 lines.

At exact review-fix start, changed-style comparison against
`a7a5f488cd185a7f2cc6bd814c319f97d5401d03` failed on that single
`layout.primary-export-name` finding. The unchanged comparison passes after the
rename. A byte comparison proves the renamed owner is identical to the
reviewed implementation file; only path references and factual evidence
changed.

Construction-detail review reports only retained boundary shapes in changed
production: `GroupStateInboxHandler.readGroupMutationPreparation`,
`isAuthorityProofOrNull`, and `isRecordOrNull` keep `unknown` at the untrusted
durable-authority boundary; `AppGroupInboxService.processGroupMutation` keeps
the unused framework payload typed `unknown`; and
`AppGroupInboxService.isTopologyConfigInboxType` remains the pre-existing
topology-family policy predicate. These are demonstrated boundary uses or
accepted existing no-new-magnitude findings owned by their named modules, not
new Task 6 construction debt.

## Validation and review state

Focused descriptor, authority, operation, routing, retry, phase-trace, source,
mirrored-tree, and shared-server TypeScript validation passes. The complete PR
B changed-source inventory contains 26 paths and fails closed on omission;
mechanical findings, function/module limits, import order, and runtime cycles
pass with the exact reviewed predecessor allowances and no descriptor
filename/export allowance.

The first independent review reported Critical 0 / Important 1 for the filename
and primary-symbol mismatch. The review fix resolved that exact finding. The
fresh independent re-review accepted Critical 0 / Important 0 / Minor 0 at
exact milestone head `3a730b845a78a268f1c1e19dc9b3edb7a54619cb` and tree
`a96ca6935840752328f26980fa72dcfdf59472f4`.
