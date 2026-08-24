# Task 2: acyclic browser state construction

## Scope and outcome

This task replaces the two browser construction back-references with completed
lower-level ports. `createBrowserStateComposition` now creates one
`RallarStateCacheReadPort` before both state consumers, and
`createBrowserStateEventComposition` creates one `RallarWsInbox` from the
already completed connection runtime before either event consumer. Room events
subscribe directly to that inbox; people events remain a separate inbox owner.

The state/room behavior is unchanged: cache reads still return their configured
defaults, room state still applies scope and current-room rules, and group and
client events keep their validation, filtering, deduplication, and listener
semantics. No alternate path, mediator, alias, fallback construction path, or
forwarding hop was introduced.

`packages/shared-web/browser/rallar-runtime/composition.ts` has the minimal
caller change needed to pass the completed `foundation.connectionRuntime` into
the state-event composition. Its separate `sessionController!` construction
cycle remains the explicitly planned Task 3 correction; this task does not
preserve or add a workaround for it.

## Changed files and behavior

- `packages/shared-web/browser/rallar-runtime/state-store.ts` — owns the new
  completed cache read/observation port and makes `RallarStateStore` consume it
  directly.
- `packages/shared-web/browser/rooms/room-state-store.ts` — consumes the same
  cache port rather than individual read and observation suppliers.
- `packages/shared-web/browser/rallar-runtime/composition/browser-runtime-composition.ts`
  — constructs cache before state consumers and the WS inbox before event
  consumers; removes both definite-assignment construction bindings.
- `packages/shared-web/browser/rallar-runtime/composition.ts` — passes the
  completed connection runtime to the state-event composition.
- `packages/shared-web/browser/rooms/room-events.ts` — owns its direct WS inbox
  subscription while it has room-event listeners.
- `packages/shared-web/browser/rallar-runtime/state-events.ts` and
  `packages/shared-web/browser/rallar-runtime/contracts.ts` — remove the
  obsolete room-event retention and forwarding contract; people events retain
  only their own inbox subscription.
- `packages/shared-web/browser/README.md` — documents the actual construction
  and invocation symbols and current source anchors.
- `packages/tests/shared-web/composition/browser-runtime-construction.test.ts`
  — proves room-event subscription does not read an incomplete session
  controller.
- `packages/tests/shared-web/rallar-runtime-foundations.test.ts` and
  `packages/tests/shared-web/rooms/room-state-store-current-room.test.ts` —
  construct the completed cache port instead of topology-coupled suppliers.

## Legacy deleted

- `stateStore!` and the room-state read/observation closures that captured it.
- `stateEvents!`, room-event retention closures, the room subscription counter,
  and state-event group-message forwarding.
- Optional state-store cache suppliers and room-state-store cache supplier
  fields.
- `RallarStateEventsPort.retainRoomEventSubscription` and
  `CreateRoomEventsInput.retainWsInboxSubscription`.

No retained production legacy candidate was reported by the changed-call-path
review. Existing wire behavior and the independently-owned Task 3 session and
duplicate-cleanup corrections were not broadened into this slice.

## TDD evidence

Before the production refactor, this semantic construction test was made to
subscribe through `roomEvents` while `readSessionController` throws:

```text
npx vitest run packages/tests/shared-web/composition/browser-runtime-construction.test.ts
```

It was RED with the expected `state-event session port was used before
construction completed` error. After the refactor it is green, and the focused
Task 2 suite is 15 files / 69 tests green.

The combined Task 1 characterization command has exactly one planned RED:
`browser-connection-cleanup.test.ts` observes duplicate transport teardown on
the second disconnect. The other four files and 18 tests are green. That is the
remaining Task 3 cleanup correction; construction is green.

## Construction-detail review and dispositions

The warning-only construction-detail commands were run across the runtime and
rooms roots. Every finding in a changed production file was reviewed:

- `composition/browser-runtime-composition.ts`: both targeted
  definite-assignment bindings and the `readDefaults` pass-through finding are
  removed.
- `composition.ts`: `sessionController!` is the distinct session/startup cycle
  that Task 3 owns. The direct `connectionRuntime` dependency added here does
  not read, retain, or extend that cycle; the remaining finding is neither new
  nor worsened by this task.
- `state-store.ts`: `error: unknown` is a narrow repository failure boundary;
  it is normalized immediately to recognize the configured-cache absence and
  every other error is rethrown.
- `state-events.ts`: the WS payload is deliberately `unknown` at the protocol
  boundary and is accepted only after `validateAuthoritativeClientEvent`.
  The nested callback is the inbox callback, which directly delegates to the
  owning dispatch method and adds no forwarding layer.
- `room-events.ts`: incoming WS payload is deliberately `unknown` until its
  envelope and `validateAuthoritativeGroupEvent` checks complete. Its inbox
  callback performs topic selection and directly invokes its own dispatcher;
  the callback-depth signal is therefore a real protocol boundary, not hidden
  control flow.
- `contracts.ts`: the generic-file-name warning predates the deletion. The file
  remains the existing shared runtime-contract owner; moving unrelated public
  contract surface would broaden this construction-only task without improving
  the removed cycle.

The structure check reports the pre-existing `rallar-runtime` directory-density
review (22 direct sources). The cache port is a state-runtime capability and the
composition change is its existing owner, so no mechanical file move or
pass-through module is justified in this slice.

## Closure and self-review

All changed production and test files were read in full before changes. The
navigation probe traces facade composition to foundation, cache port, state
stores, WS inbox, room-event dispatch, and people-event dispatch. A source scan
finds no `stateStore!`, `stateEvents!`, read/set/bind state-owner helper, or
obsolete room-inbox retention contract in the browser package or its focused
tests.

No public export or package entry-point changed, and no new bundle-sensitive
dependency was added, so public API snapshot and bundle-boundary checks were
not relevant.

## Commands and results

```text
git status --short --branch
git rev-parse HEAD
```

Confirmed the clean required base
`ebb471ee09b2c67525dc62031b2d1455ed3e7866` before edits.

```text
npx vitest run packages/tests/shared-web/composition/browser-runtime-construction.test.ts
```

Expected semantic RED before the refactor; after implementation this command
passed with 2 tests.

```text
npx vitest run packages/tests/shared-web/composition/browser-runtime-construction.test.ts packages/tests/shared-web/rallar-runtime-foundations.test.ts packages/tests/shared-web/data-caches.test.ts packages/tests/shared-web/group-state-delta-application.test.ts packages/tests/shared-web/group-state-resync-on-reopen.test.ts packages/tests/shared-web/state-snapshot-collection-refresh.test.ts packages/tests/shared-web/state-snapshot-point-read.test.ts packages/tests/shared-web/state-snapshot-reconciliation.test.ts packages/tests/shared-web/rooms/room-state-store.test.ts packages/tests/shared-web/rooms/room-state-store-current-room.test.ts packages/tests/shared-web/rooms/room-events-list-and-page.test.ts packages/tests/shared-web/rooms/room-events-replay.test.ts packages/tests/shared-web/rooms/room-events-subscription.test.ts packages/tests/shared-web/people/people-events-compat.test.ts packages/tests/shared-web/rallar-people-facade.test.ts
```

Passed: 15 files, 69 tests.

```text
npx vitest run packages/tests/shared-web/composition/browser-runtime-construction.test.ts packages/tests/shared-web/composition/browser-facade-behavior.test.ts packages/tests/shared-web/session/browser-connection-cleanup.test.ts packages/tests/shared-web/rallar-runtime-foundations.test.ts packages/tests/shared-web/rallar-startup-lifecycle.test.ts
```

Expected exit 1: exactly the one planned Task 3 duplicate-cleanup assertion
failed; 4 files and 18 tests passed.

```text
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npm run format -- packages/shared-web/browser/README.md packages/shared-web/browser/rallar-runtime/composition.ts packages/shared-web/browser/rallar-runtime/composition/browser-runtime-composition.ts packages/shared-web/browser/rallar-runtime/contracts.ts packages/shared-web/browser/rallar-runtime/state-events.ts packages/shared-web/browser/rallar-runtime/state-store.ts packages/shared-web/browser/rooms/room-events.ts packages/shared-web/browser/rooms/room-state-store.ts packages/tests/shared-web/composition/browser-runtime-construction.test.ts packages/tests/shared-web/rallar-runtime-foundations.test.ts packages/tests/shared-web/rooms/room-state-store-current-room.test.ts
npm run format:check -- packages/shared-web/browser/README.md packages/shared-web/browser/rallar-runtime/composition.ts packages/shared-web/browser/rallar-runtime/composition/browser-runtime-composition.ts packages/shared-web/browser/rallar-runtime/contracts.ts packages/shared-web/browser/rallar-runtime/state-events.ts packages/shared-web/browser/rallar-runtime/state-store.ts packages/shared-web/browser/rooms/room-events.ts packages/shared-web/browser/rooms/room-state-store.ts packages/tests/shared-web/composition/browser-runtime-construction.test.ts packages/tests/shared-web/rallar-runtime-foundations.test.ts packages/tests/shared-web/rooms/room-state-store-current-room.test.ts
npm run check:repo-style:changed -- ebb471ee09b2c67525dc62031b2d1455ed3e7866
npm run check:repo-style:construction-details -- --root packages/shared-web/browser/rallar-runtime
npm run check:repo-style:construction-details -- --root packages/shared-web/browser/rooms
npm run check:repo-structure -- --base ebb471ee09b2c67525dc62031b2d1455ed3e7866
npm run review:legacy -- ebb471ee09b2c67525dc62031b2d1455ed3e7866 HEAD
git diff --check
```

Typecheck and formatting passed. Changed-style passed with no new findings.
Construction-detail output is warning-only and is disposed above. Structure
passed with the documented density review. Legacy review and whitespace diff
check passed.

```text
rg -n 'createBrowserRuntimeFoundation|createBrowserStateComposition|createBrowserStateEventComposition|connectionRuntime: foundation.connectionRuntime' packages/shared-web/browser/rallar-runtime/composition.ts packages/shared-web/browser/rallar-runtime/composition/browser-runtime-composition.ts
rg -n 'createRallarStateCacheReadPort|stateCache|createRallarWsInbox|wsInbox|onEvent\\(|dispatch\\(|onPeopleEvent\\(' packages/shared-web/browser/rallar-runtime/composition/browser-runtime-composition.ts packages/shared-web/browser/rallar-runtime/state-events.ts packages/shared-web/browser/rooms/room-events.ts packages/shared-web/browser/rallar-runtime/state-store.ts packages/shared-web/browser/rooms/room-state-store.ts
rg -n 'stateStore!|stateEvents!|readStateStore|readStateEvents|setStateStore|setStateEvents|bind.*State(Store|Events)|retainRoomEventSubscription|retainWsInboxSubscription' packages/shared-web/browser packages/tests/shared-web
```

Navigation and obsolete-construction scans resolved the documented symbols and
returned no forbidden state-owner construction leftovers.

## Issues and follow-up

No blocker or external follow-up was created. Task 3 remains responsible for
the explicit session/startup late binding and the one duplicate-cleanup RED.
