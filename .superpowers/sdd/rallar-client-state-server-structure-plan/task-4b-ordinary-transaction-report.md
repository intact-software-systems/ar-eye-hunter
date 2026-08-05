# Task 4B — ordinary client mutation transaction shell

## Delivered behavior

The canonical client-state service now owns its public contracts, service
composition, timing seam, mutation read phase, and ordered mutation write
phase under `packages/shared-server/rallar-system/client-state/`. The public
`AppClientInboxService` constructor remains positional and registers the same
eight messages in the same order, but delegates ordinary client mutations to
`ClientStateInboxHandler`.

The handler holds the explicit `read → compute → validate → write` boundary.
It writes through the AppInbox transaction writer, projects committed snapshots
only after the writer returns, and retains the authorised-WebSocket and expiry
paths mechanically. Legacy service paths are direct named-export compatibility
shims; canonical modules and `packages/shared-server/mod.ts` provide the new
owners.

Navigation, routing, lineage, ownership, and semantic tests now identify the
canonical owner paths. The ordinary-transaction structural manifest binds
source-derived files to exact Task 4A blobs. The pure authorised-WebSocket
helper move is recorded separately because Git rename detection already owns
its changed-style capacity.

`packages/tests/repo/rallar-group-state-owner-integrity.test.ts` has exactly
two affected client-state path updates:

- `packages/shared-server/rallar-system/services/client-state-service.ts` →
  `packages/shared-server/rallar-system/client-state/client-state-service.ts`
- `packages/shared-server/rallar-system/services/AppClientInboxService.ts` →
  `packages/shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts`

Its authoritative-phase assertion now also reads
`packages/shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts`,
because that is where Task 4B deliberately places the direct mutation phase
statements. This is cross-domain governance trace evidence only: it keeps
`npm run test:repo-governance` from treating the legacy compatibility shims as
the executable owner; no group-state behavior changed.

## TDD and integration evidence

- RED: the canonical-owner test failed until the ten planned canonical owner
  paths existed.
- RED: navigation-map validation failed before the canonical links were added.
- RED: ordinary-transaction lineage validation failed before its manifest and
  provenance record existed.
- RED: the existing persistence-lineage suite identified missing structural
  capacity for Task 4B targets, and then detected that the pure authorised-WS
  rename must not also be listed in the structural manifest.
- GREEN: the resulting lineage model passes the changed-style gate. The
  persistence suite receives a 15-second explicit timeout because it executes
  that synchronous gate, which takes about five seconds on this worktree.

## Validation

Passed:

- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
- focused client-state semantic suite: 12 files, 85 tests
- focused lineage/navigation/ownership suite: 5 files, 31 tests
- routing source suite: 4 files, 31 tests
- `npm run test:repo-governance`: 21 files, 233 tests
- `npm run check:repo-style:changed -- 2fdba024bb347622727d337eb06fc13d2fe129fc`
- `git diff --check`
- targeted Prettier check of the canonical source files that use explicit
  `prettier-ignore` import wrapping to satisfy the repository's 100-column
  checker and Prettier simultaneously.

Style modes ran against the canonical client-state tree. Layout and detailed
layout reported no issues. Default, construction-detail, output-contract, and
object-interface modes reported only existing client-state decoder, validation,
and persistence warnings; the changed-style gate reports no new or worsened
findings. The broad `npm run check:repo-style` also exited successfully and
reported 4,569 non-blocking repository-wide pre-existing warnings.

Skipped intentionally for this narrow local task:

- `npm run test:unit`, `npm run test:ci`, and `npm run build`; these are
  whole-plan completion gates and were not run in this Task 4B cohort.
- live black-box, performance, push, pull-request, and remote workflow gates;
  they need the broader plan/release workflow and no external publication was
  requested here.

## Follow-up

The local change is ready for the parent plan's remaining cohort integration
and release gates. No push or pull request was created.
