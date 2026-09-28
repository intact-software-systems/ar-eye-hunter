# Task 9 report: maintained test typing

**Status:** DONE_WITH_CONCERNS

## Changes

- `packages/tests/shared-server/rallar-system/websocket/outbox/ws-room-provenance-delivery.test.ts`: construct the base broadcast with a supported scope, then keep the existing principal target replacement for the distinct principal provenance rejection case.
- `packages/tests/shared/alm/outbound-room-repair-authority.test.ts`: restore timers in a cleanup callback that returns `void`.
- `packages/tests/shared/services/ws-room-provenance-planning.test.ts`: explicitly pass the absent application QoS provider to the carrier provider constructor.

No production API or behavior changed. The principal case still serializes and tests a principal broadcast; it was not converted into a room case. No support files were changed by remediation.

## Validation

- RED: `npm run typecheck:tests` exited 1, reporting exactly one new type error in each of the three test files. `npx tsc -p packages/tests/tsconfig.json --noEmit --pretty false 2>&1 | rg 'ws-room-provenance-delivery|outbound-room-repair-authority|ws-room-provenance-planning'` identified TS2345 at line 305, TS2322 at line 22, and TS2554 at line 77 respectively. The maintained gate is authoritative; the direct compiler also emits unrelated dependency errors.
- GREEN: `npx vitest run packages/tests/shared-server/rallar-system/websocket/outbox/ws-room-provenance-delivery.test.ts packages/tests/shared/alm/outbound-room-repair-authority.test.ts packages/tests/shared/services/ws-room-provenance-planning.test.ts` exited 0: 3 files, 23 tests passed.
- GREEN: `npm run typecheck:tests` exited 0: 1351 files enforced, zero known-debt files, no new type errors.
- GREEN: `npx tsc -p packages/shared/tsconfig.json --noEmit` and `npx tsc -p packages/shared-server/tsconfig.json --noEmit` both exited 0.
- GREEN: `npx dprint check` on the three touched test files and `git diff --check` both exited 0.
- GREEN with existing warnings: `npm run check:repo-style` exited 0 and reported 3303 non-blocking findings across the broader repository.
- BROADER BRANCH FAILURE: `npm run check:repo-style:changed -- origin/main` exited 1 because `packages/shared-test/black-box-runner` has a new or worsened `layout.directory-density` finding (23 direct production TypeScript files). Task 9 did not touch that directory. The whole branch is not ready on this evidence.

## Full-file review and closure

I read and reviewed each of the three changed human-authored test files in full, including assertions, fixtures, callback cleanup, dataflow, and file layout. The principal negative test remains independent from the room and broad cases. No affected unused code or in-scope standards violation remained. Every support file modified by remediation would enter recursive closure; none was modified. Independent untouched code remains outside closure.

## Self-review and follow-up

The diff is confined to the three intended typing repairs and this report. No test assertions were removed or weakened. The broader branch owner needs to resolve the changed-range directory-density failure before branch delivery; Task 9 has no separate issue or PR URL.
