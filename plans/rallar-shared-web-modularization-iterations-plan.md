# Rallar Shared-Web Modularization And Improvement Iterations

Date: 2026-06-14

Status: Living plan based on current `packages/shared-web` and `apps/**`
usage. Iterations 1, 2, 3, 4, 5, 6, 7, 8, and 9 have been implemented.

## Purpose

Rallar's browser package is useful, but the current shared-web surface has
outgrown its shape. The main browser facade in
`packages/shared-web/browser/rallar.ts` is now responsible for too many product
areas at once: auth, startup, rooms, people, state events, WS messages, RTC
messages, realtime lanes, director relay, calls, media sources, diagnostics,
data, CRDT transport, subscription management, and cache coordination.

The core direction:

> Keep the existing `rallar` facade compatible, but split its implementation and
> public entry points so Rallar can have a small core, optional feature modules,
> clearer ownership, and easier tests.

## Current Code And Apps Checked

Primary local references:

- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/mod.ts`
- `packages/shared-web/browser/rallar-data.ts`
- `packages/shared-web/browser/rallar-crdt.ts`
- `packages/shared-web/browser/api-workflows.ts`
- `packages/shared-web/browser/middleware.ts`
- `packages/shared-web/browser/data-caches.ts`
- `packages/shared-web/game/mod.ts`
- `packages/tests/shared-web/rallar-operation-options.test.ts`
- `packages/tests/shared-web/rallar-crdt.test.ts`
- `apps/ar-eye-hunter-v1/src/main.tsx`
- `apps/ar-eye-hunter-v1/src/game/useRallarArena.ts`
- `apps/relic-hunters-v1/src/main.tsx`
- `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts`
- `apps/relic-hunters-v1/src/game/scene/networking.ts`
- `apps/rallar-black-box/src/App.tsx`
- `apps/rallar-black-box/src/direct-rallar-operations.ts`

Relevant current facts:

- `packages/shared-web` has about 18.5k lines of TypeScript; `rallar.ts` alone
  is about 8.2k lines.
- `RallarFacade` exposes the full browser platform as one object:
  connection/startup, `data`, `crdt`, `auth`, `rooms`, `people`, `director`,
  `messages`, `channels`, `rtc`, `calls`, `ws`, `realtime`, `media`, and
  `advanced`.
- `BrowserRallarFacade` owns many private state sets/maps in one class:
  session/connect state, current room, auth expiry, state listeners, director
  heartbeats, room/people event dedupe, WS/RTC/realtime listeners, media source
  state, and remote stream callbacks.
- `packages/shared-web/mod.ts` exports nearly every browser and game module.
  AR Eye imports it for side effects before importing `rallar`.
- The current `rallar.ts` browser bundle measured with local esbuild is about
  649.9 KiB minified, 161.0 KiB gzip, 135.0 KiB Brotli. The full
  `shared-web/mod.ts` barrel is about 688.9 KiB minified, 170.3 KiB gzip,
  143.3 KiB Brotli.
- Standalone dependency measurements: `graphology` is about 65.9 KiB minified
  / 11.6 KiB Brotli; `@js-temporal/polyfill` including `jsbi` is about
  158.3 KiB minified / 39.7 KiB Brotli.
- AR Eye uses `rallar` as a full game platform: configure/defaults, start,
  rooms, auth, realtime lanes, RTC lane waits, RTC diagnostics, director status,
  and local data.
- Relic Hunters uses `rallar` through a runtime adapter for auth, rooms,
  `messages.ws`, `messages.rtc`, realtime motion, RTC lane readiness, and
  authority client integration.
- Rallar Black Box intentionally imports the full facade dynamically and should
  remain a compatibility and conformance consumer.

## Product And Architecture Diagnosis

The current browser package is capable but too coupled.

Strengths:

- The single `rallar` facade is ergonomic for demos and apps that want the full
  platform.
- State workflows, retries, defaults, auth invalidation, scoped rooms, and RTC
  readiness already have serious behavior coverage.
- Game, AI, CRDT, data, WS, and RTC package layers exist separately enough that
  extraction is feasible.
- App usage is mostly through explicit facade branches, which gives a good
  migration path.

Weaknesses:

- `rallar.ts` violates single responsibility: it mixes product API, runtime
  orchestration, event buses, transport policy, state-cache reads, media/call
  logic, diagnostics, and pure helpers.
- Feature ownership is hard to test in isolation because many behaviors require
  constructing the full facade.
- The full facade imports CRDT/data and lower-level queue/runtime code even when
  an app only wants auth, rooms, and WS/realtime basics.
- `@shared-web/mod.ts` is too broad as a default browser entry point.
- App-level code still coordinates some transport policy directly, especially
  room RTC readiness and motion send gating.
- Bundle-size expectations are not encoded in tests or scripts, so growth is
  invisible unless someone manually measures it.

## Iteration 1: Baseline Guardrails Before Moving Code

Goal: make the current behavior and public surface explicit before
refactoring.

Implementation status: completed on 2026-06-14.

Key changes:

- Add export/API snapshot tests for `@shared-web/browser/rallar.ts`,
  `@shared-web/browser/rallar-data.ts`, `@shared-web/browser/rallar-crdt.ts`,
  and `@shared-web/game/mod.ts`.
- Add a bundle-size measurement script or package test that bundles
  `browser/rallar.ts` and `shared-web/mod.ts` to `/tmp` and reports minified,
  gzip, and Brotli sizes without failing CI initially.
- Document current app import patterns and intended future entry points in a
  short shared-web architecture note.
- Keep `rallar.ts` untouched except for test-only imports if needed.

Acceptance criteria:

- Existing app builds and shared-web tests still pass.
- A reviewer can see when public exports or browser bundle size change.
- The baseline numbers above are reproducible from a command.

Suggested validation:

- `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts`
- `npx vitest run packages/tests/shared-web/rallar-crdt.test.ts`
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
- `npm --workspace ar-eye-hunter-v1 run build`
- `npm --workspace relic-hunters-v1 run build`

Implemented work:

- Added static export/API snapshot coverage in
  `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts` for the
  main shared-web public surfaces:
  `packages/shared-web/browser/rallar.ts`,
  `packages/shared-web/browser/rallar-data.ts`,
  `packages/shared-web/browser/rallar-crdt.ts`,
  `packages/shared-web/game/mod.ts`, and
  `packages/shared-web/mod.ts`.
- Added `packages/shared-web/scripts/measure-browser-bundles.mjs` and the
  package script:
  `npm --workspace @ar-eye-hunter/shared-web run measure:browser-bundles`.
  The script bundles `browser/rallar.ts` and `shared-web/mod.ts`, minifies
  them, and reports minified, gzip, and Brotli sizes without enforcing a
  budget.
- Added `packages/shared-web/architecture.md` to document current app import
  patterns, compatibility expectations, intended future entry points, and local
  validation commands.
- Kept `packages/shared-web/browser/rallar.ts` behavior untouched during this
  iteration.

Measured baseline:

- `packages/shared-web/browser/rallar.ts`: 649.9 KiB minified, 161.0 KiB gzip,
  135.0 KiB Brotli.
- `packages/shared-web/mod.ts`: 688.9 KiB minified, 170.3 KiB gzip, 143.3 KiB
  Brotli.

Validation run:

- `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
  passed: 5 tests.
- `npm --workspace @ar-eye-hunter/shared-web run measure:browser-bundles`
  completed and printed the baseline sizes above.
- `npx vitest run packages/tests/shared-web` passed: 19 files, 236 tests.
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed.

## Iteration 2: Extract Pure Types And Helpers From `rallar.ts`

Goal: reduce cognitive load without changing runtime behavior.

Implementation status: completed on 2026-06-14 as a narrow, compatibility-first
extraction. Broader facade type splitting, state-event replay/dedupe helpers,
room/scope helpers, WS/RTC status mapping, and call/media status mapping remain
future work.

Key changes:

- Move exported facade types and option/result types into a browser facade types
  module, re-exported from `rallar.ts`.
- Move pure helpers into small files grouped by purpose:
  message selectors, operation options/retry policy, state-event replay/dedupe,
  room/scope resolution, WS/RTC status mapping, call/media status mapping.
- Keep private helper names and behavior stable where possible; do not redesign
  APIs in this iteration.
- Leave `BrowserRallarFacade` in `rallar.ts`, but replace large helper regions
  with imports.

Acceptance criteria:

- No public import breaks.
- Tests that directly import helper exports, such as message selector tests,
  continue to pass.
- `rallar.ts` loses helper bulk but still composes the same facade.

Suggested validation:

- `npx vitest run packages/tests/shared-web/rallar-message-selectors.test.ts`
- `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts`
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit`

Implemented work:

- Added `packages/shared-web/browser/rallar-message-selectors.ts` for the pure
  selector cluster:
  `RallarMessageSelector`, `RallarMessageSelectorInput`,
  `normalizeRallarMessageSelector`, `matchesRallarMessageSelector`,
  `toRallarMessageSelectorKey`, and `readRallarMessageRoomId`.
- Added `packages/shared-web/browser/rallar-operation-options.ts` for the pure
  operation policy cluster:
  `RallarOperationRetryPredicate`, `RallarOperationOptions`,
  `toRallarOperationOptions`, `toRallarCommandOptions`,
  `toRallarWorkflowPolicies`, and `shouldRetryRallarOperation`.
- Updated `packages/shared-web/browser/rallar.ts` to import those helpers and
  re-export the existing public type/function names from the same compatibility
  entry point. Existing imports from `@shared-web/browser/rallar.ts` remain
  valid.
- Kept `BrowserRallarFacade` in `rallar.ts`; only pure helper/type regions were
  moved.
- Added focused direct helper coverage in
  `packages/tests/shared-web/rallar-message-selectors.test.ts` and
  `packages/tests/shared-web/rallar-operation-options.test.ts`.

Validation run:

- `npx vitest run packages/tests/shared-web/rallar-message-selectors.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`
  passed: 2 files, 119 tests.
- `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
  passed: 5 tests.
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed.

Notes for later iterations:

- Keep `@shared-web/browser/rallar.ts` as the compatibility entry point until a
  deliberate public-entry-point pass.
- Do not move helpers that depend on facade state, browser runtime lifecycle,
  media globals, or replay message construction until Iterations 3 and 4 create
  a clearer runtime context and domain factory boundary.

## Iteration 3: Introduce A Shared Browser Facade Runtime Context

Goal: split behavior by domain without copying state or creating new globals.

Implementation status: completed on 2026-06-14 as an internal runtime-context
foundation. Domain factories and public entry-point changes remain future
iterations.

Key changes:

- Create an internal runtime context object that owns the shared mutable state
  now held by `BrowserRallarFacade`: middleware, connect state, defaults, current
  room, listener registries, event dedupe sets, auth expiry, and session helpers.
- Expose context methods for cross-cutting operations: read/require middleware,
  resolve operation options, resolve room refs/scope, emit state/auth events,
  run auth-aware operations, and close authenticated data scopes.
- Keep the singleton `rallar` and `createRallarFacade()` behavior unchanged.
- Make context internal to shared-web; do not export it as stable API.

Acceptance criteria:

- Domain modules can be added without passing the full facade instance around.
- Cross-domain operations still share one state owner per facade instance.
- Multiple `createRallarFacade()` instances remain isolated for tests.

Suggested validation:

- `npx vitest run packages/tests/shared-web/rallar-flow.test.ts`
- `npx vitest run packages/tests/shared-web/rallar-data.test.ts`
- `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts`

Implemented work:

- Added `packages/shared-web/browser/rallar-runtime-context.ts` as an internal
  shared browser facade runtime context. It is not exported from
  `packages/shared-web/mod.ts` and is not a stable public entry point.
- Moved ownership of cross-cutting mutable facade state into the context:
  connect state, cached middleware, connect promise, state-cache unsubscribe,
  current room id/ref, configured defaults, default state scope, auth expiry
  timer, auth end promise, and ended auth-session keys.
- Moved default cloning, default-scope derivation, operation-option defaulting,
  middleware read/require/clear behavior, and current-room clear/set behavior
  into the context.
- Updated `packages/shared-web/browser/rallar.ts` to delegate through the
  context while preserving `createRallarFacade()`, the singleton `rallar`, app
  imports, and the public facade object shape.
- Added `packages/tests/shared-web/rallar-runtime-context.test.ts` for direct
  internal context coverage:
  defaults are cloned and isolated, operation options inherit defaults, current
  room and connection state stay isolated per context, and middleware is read
  lazily with the same missing-middleware error.

Validation run:

- `npx vitest run packages/tests/shared-web/rallar-runtime-context.test.ts packages/tests/shared-web/rallar-flow.test.ts packages/tests/shared-web/rallar-data.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`
  passed: 4 files, 128 tests.
- `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
  passed: 5 tests.
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed.

Notes for later iterations:

- The context is intentionally broad enough for Iteration 4 domain factories to
  receive one shared state owner instead of the full `BrowserRallarFacade`.
- Listener registries and domain-specific runtime maps still live in
  `BrowserRallarFacade`; move them with their domain factories in Iteration 4
  rather than expanding this iteration.
- Do not add public entry points for the context. Public browser entry-point
  work belongs to Iteration 6.

## Iteration 4: Split The Facade Into Domain Factories

Goal: enforce separation of concerns while preserving the external `rallar`
shape.

Implementation status: completed across compatible slices on 2026-06-14 and
2026-06-15. These passes extracted the connection/defaults/session/subscription
/flow domain factory, the auth domain factory, the rooms domain factory, the
people domain factory, the calls domain factory, the director domain factory,
the media domain factory, the messages domain factory, the realtime domain
factory, and the RTC domain factory.

Key changes:

- Replace direct object literals inside `BrowserRallarFacade` with internal
  domain factories:
  `createRallarAuthFacade`, `createRallarRoomsFacade`,
  `createRallarPeopleFacade`, `createRallarMessagesFacade`,
  `createRallarRealtimeFacade`, `createRallarRtcFacade`,
  `createRallarDirectorFacade`, `createRallarCallsFacade`,
  `createRallarMediaFacade`, and `createRallarConnectionFacade`.
- Each factory receives the shared runtime context and only the collaborators it
  needs.
- Keep `rallar.auth.*`, `rallar.rooms.*`, `rallar.realtime.*`, and the rest of
  the public object shape unchanged.
- Keep `rallar.ts` as the compatibility composer that wires domain factories
  together and exports `createRallarFacade()` plus `rallar`.

Acceptance criteria:

- `rallar.ts` becomes a composer rather than the implementation of every
  feature.
- Each domain can be unit-tested with a fake context.
- App code requires no changes.

Suggested validation:

- Split `rallar-operation-options.test.ts` only after behavior is preserved.
- Run the full existing shared-web facade suite before and after each domain
  extraction.

Implemented work:

- Added `packages/shared-web/browser/rallar-connection-facade.ts` as the first
  internal domain factory. It composes the top-level connection/defaults/session
  methods with injected operations rather than directly depending on
  `BrowserRallarFacade` internals.
- Added `packages/shared-web/browser/rallar-auth-facade.ts` as the second
  internal domain factory. It composes `rallar.auth.*` methods with injected
  operations while preserving login, register, register-and-login, logout,
  restore, login-state, and auth-change behavior in the existing facade.
- Added `packages/shared-web/browser/rallar-people-facade.ts` as the third
  internal domain factory. It composes `rallar.people.*` methods with injected
  operations while preserving people state, list, refresh, event list/page,
  replay, lookup, state-change, and event-subscription behavior in the existing
  facade.
- Added `packages/shared-web/browser/rallar-calls-facade.ts` as the fourth
  internal domain factory. It composes `rallar.calls.*` methods with injected
  operations while preserving start, invite, invite-listener, and
  signal-listener behavior in the existing facade.
- Added `packages/shared-web/browser/rallar-director-facade.ts` as the fifth
  internal domain factory. It composes `rallar.director.*` methods with injected
  operations while preserving appoint, resign, status, status-listener, and
  relay creation behavior in the existing facade.
- Added `packages/shared-web/browser/rallar-media-facade.ts` as the sixth
  internal domain factory. It composes `rallar.media.*` methods with injected
  operations while preserving source controllers, local stream controls, media
  policy updates, and remote-stream subscriptions in the existing facade.
- Added `packages/shared-web/browser/rallar-messages-facade.ts` as the seventh
  internal domain factory. It composes `rallar.messages.*` methods with
  injected operations while preserving RTC send/listen, WS send/listen, and
  typed-channel creation behavior in the existing facade.
- Added `packages/shared-web/browser/rallar-realtime-facade.ts` as the eighth
  internal domain factory. It composes `rallar.realtime.*` methods with
  injected operations while preserving JSON/binary sends, lane listeners, JSON
  lane creation, and realtime health reads in the existing facade.
- Added `packages/shared-web/browser/rallar-rtc-facade.ts` as the ninth
  internal domain factory. It composes `rallar.rtc.*` methods with injected
  operations while preserving RTC status, room transport status, room open/wait,
  status/lifecycle subscriptions, lane waits, peer reads, diagnostics, ICE
  restart, and reconnect behavior in the existing facade.
- Added `packages/shared-web/browser/rallar-rooms-facade.ts` as the tenth
  internal domain factory. It composes `rallar.rooms.*` methods with injected
  operations while preserving room state/list reads, refresh, event listing,
  event page reads, replay, create, join, leave, metadata update, current-room
  reads, state-change subscriptions, and room-event subscriptions in the
  existing facade.
- Updated `packages/shared-web/browser/rallar.ts` so the existing top-level
  public methods delegate through the connection factory:
  `configure`, `setDefaults`, `defaults`, `connect`, `start`, `disconnect`,
  `status`, `isConnected`, `session`, `subscriptions`, and `flow`.
- Updated `packages/shared-web/browser/rallar.ts` so the existing `auth` public
  object delegates through the auth factory without changing the
  `rallar.auth.*` public shape.
- Updated `packages/shared-web/browser/rallar.ts` so the existing `people`
  public object delegates through the people factory without changing the
  `rallar.people.*` public shape.
- Updated `packages/shared-web/browser/rallar.ts` so the existing `calls`
  public object delegates through the calls factory without changing the
  `rallar.calls.*` public shape.
- Updated `packages/shared-web/browser/rallar.ts` so the existing `director`
  public object delegates through the director factory without changing the
  `rallar.director.*` public shape.
- Updated `packages/shared-web/browser/rallar.ts` so the existing `media`
  public object delegates through the media factory without changing the
  `rallar.media.*` public shape.
- Updated `packages/shared-web/browser/rallar.ts` so the existing `messages`
  public object delegates through the messages factory without changing the
  `rallar.messages.*` public shape.
- Updated `packages/shared-web/browser/rallar.ts` so the existing `realtime`
  public object delegates through the realtime factory without changing the
  `rallar.realtime.*` public shape.
- Updated `packages/shared-web/browser/rallar.ts` so the existing `rtc` public
  object delegates through the RTC factory without changing the `rallar.rtc.*`
  public shape.
- Updated `packages/shared-web/browser/rallar.ts` so the existing `rooms`
  public object delegates through the rooms factory without changing the
  `rallar.rooms.*` public shape.
- Kept `@shared-web/browser/rallar.ts` as the compatibility entry point and did
  not add any new public exports or app import paths.
- Added `packages/tests/shared-web/rallar-connection-facade.test.ts` to prove
  the factory delegates lifecycle methods, default handling, session reads,
  subscription creation, and flow creation through its injected operations.
- Added `packages/tests/shared-web/rallar-auth-facade.test.ts` to prove the
  auth factory delegates login, register, register-and-login, logout, restore,
  login-state, and auth-change subscription behavior through injected
  operations.
- Added `packages/tests/shared-web/rallar-people-facade.test.ts` to prove the
  people factory delegates state/list reads, refresh, event listing, event page
  reads, replay, lookup, state-change subscription, and people-event
  subscription behavior through injected operations.
- Added `packages/tests/shared-web/rallar-calls-facade.test.ts` to prove the
  calls factory delegates start, invite, invite-listener, and signal-listener
  behavior through injected operations.
- Added `packages/tests/shared-web/rallar-director-facade.test.ts` to prove the
  director factory delegates appoint, resign, status, status-listener, and relay
  creation behavior through injected operations.
- Added `packages/tests/shared-web/rallar-media-facade.test.ts` to prove the
  media factory delegates source controllers, local stream controls, media
  policy updates, and remote-stream subscription behavior through injected
  operations.
- Added `packages/tests/shared-web/rallar-messages-facade.test.ts` to prove the
  messages factory delegates RTC send/listen, WS send/listen, and typed-channel
  creation behavior through injected operations.
- Added `packages/tests/shared-web/rallar-realtime-facade.test.ts` to prove the
  realtime factory delegates JSON/binary sends, lane listeners, JSON lane
  creation, and realtime health reads through injected operations.
- Added `packages/tests/shared-web/rallar-rtc-facade.test.ts` to prove the RTC
  factory delegates status reads, room transport helpers, subscriptions, lane
  waits, peer reads, diagnostics, ICE restart, and reconnect behavior through
  injected operations.
- Added `packages/tests/shared-web/rallar-rooms-facade.test.ts` to prove the
  rooms factory delegates room state/list reads, refresh, event listing, event
  page reads, replay, create, join, leave, metadata update, current-room reads,
  state-change subscriptions, and room-event subscriptions through injected
  operations.

Validation run:

- `npx vitest run packages/tests/shared-web/rallar-auth-facade.test.ts packages/tests/shared-web/rallar-connection-facade.test.ts packages/tests/shared-web/rallar-runtime-context.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`
  passed: 4 files, 116 tests.
- `npx vitest run packages/tests/shared-web/rallar-people-facade.test.ts packages/tests/shared-web/rallar-auth-facade.test.ts packages/tests/shared-web/rallar-connection-facade.test.ts packages/tests/shared-web/rallar-runtime-context.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`
  passed: 5 files, 117 tests.
- `npx vitest run packages/tests/shared-web/rallar-calls-facade.test.ts packages/tests/shared-web/rallar-people-facade.test.ts packages/tests/shared-web/rallar-auth-facade.test.ts packages/tests/shared-web/rallar-connection-facade.test.ts packages/tests/shared-web/rallar-runtime-context.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`
  passed: 6 files, 118 tests.
- `npx vitest run packages/tests/shared-web/rallar-director-facade.test.ts packages/tests/shared-web/rallar-calls-facade.test.ts packages/tests/shared-web/rallar-people-facade.test.ts packages/tests/shared-web/rallar-auth-facade.test.ts packages/tests/shared-web/rallar-connection-facade.test.ts packages/tests/shared-web/rallar-runtime-context.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`
  passed: 7 files, 119 tests.
- `npx vitest run packages/tests/shared-web/rallar-media-facade.test.ts packages/tests/shared-web/rallar-director-facade.test.ts packages/tests/shared-web/rallar-calls-facade.test.ts packages/tests/shared-web/rallar-people-facade.test.ts packages/tests/shared-web/rallar-auth-facade.test.ts packages/tests/shared-web/rallar-connection-facade.test.ts packages/tests/shared-web/rallar-runtime-context.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`
  passed: 8 files, 120 tests.
- `npx vitest run packages/tests/shared-web/rallar-messages-facade.test.ts packages/tests/shared-web/rallar-media-facade.test.ts packages/tests/shared-web/rallar-director-facade.test.ts packages/tests/shared-web/rallar-calls-facade.test.ts packages/tests/shared-web/rallar-people-facade.test.ts packages/tests/shared-web/rallar-auth-facade.test.ts packages/tests/shared-web/rallar-connection-facade.test.ts packages/tests/shared-web/rallar-runtime-context.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`
  passed: 9 files, 121 tests.
- `npx vitest run packages/tests/shared-web/rallar-realtime-facade.test.ts packages/tests/shared-web/rallar-messages-facade.test.ts packages/tests/shared-web/rallar-media-facade.test.ts packages/tests/shared-web/rallar-director-facade.test.ts packages/tests/shared-web/rallar-calls-facade.test.ts packages/tests/shared-web/rallar-people-facade.test.ts packages/tests/shared-web/rallar-auth-facade.test.ts packages/tests/shared-web/rallar-connection-facade.test.ts packages/tests/shared-web/rallar-runtime-context.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`
  passed: 10 files, 122 tests.
- `npx vitest run packages/tests/shared-web/rallar-rtc-facade.test.ts packages/tests/shared-web/rallar-realtime-facade.test.ts packages/tests/shared-web/rallar-messages-facade.test.ts packages/tests/shared-web/rallar-media-facade.test.ts packages/tests/shared-web/rallar-director-facade.test.ts packages/tests/shared-web/rallar-calls-facade.test.ts packages/tests/shared-web/rallar-people-facade.test.ts packages/tests/shared-web/rallar-auth-facade.test.ts packages/tests/shared-web/rallar-connection-facade.test.ts packages/tests/shared-web/rallar-runtime-context.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`
  passed: 11 files, 123 tests.
- `npx vitest run packages/tests/shared-web/rallar-rooms-facade.test.ts packages/tests/shared-web/rallar-rtc-facade.test.ts packages/tests/shared-web/rallar-realtime-facade.test.ts packages/tests/shared-web/rallar-messages-facade.test.ts packages/tests/shared-web/rallar-media-facade.test.ts packages/tests/shared-web/rallar-director-facade.test.ts packages/tests/shared-web/rallar-calls-facade.test.ts packages/tests/shared-web/rallar-people-facade.test.ts packages/tests/shared-web/rallar-auth-facade.test.ts packages/tests/shared-web/rallar-connection-facade.test.ts packages/tests/shared-web/rallar-runtime-context.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`
  passed: 12 files, 124 tests.
- `npx vitest run packages/tests/shared-web/rallar-connection-facade.test.ts packages/tests/shared-web/rallar-runtime-context.test.ts packages/tests/shared-web/rallar-flow.test.ts packages/tests/shared-web/rallar-data.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`
  passed: 5 files, 129 tests.
- `npx vitest run packages/tests/shared-web` passed: 30 files, 254 tests.
- `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
  passed: 5 tests.
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed.

Notes:

- Iteration 4 domain extraction is complete; keep `rallar.ts` as the
  compatibility composer.
- Do not add smaller public browser entry points here; that remains Iteration 6.

## Iteration 5: Move Tests To Match The New Domain Boundaries

Goal: make future AI-generated or agent-generated changes safer.

Implementation status: completed on 2026-06-15. The broad
`rallar-operation-options.test.ts` suite has been split into focused
compatibility suites by domain. The old filename remains as a tiny
operation-options compatibility anchor because repo scripts and companion
coverage metadata still reference it.

Key changes:

- Split `packages/tests/shared-web/rallar-operation-options.test.ts` into
  focused suites by domain: auth/session, rooms/people/events, messages,
  realtime, RTC status/wait/recovery, director, calls/media, defaults/options,
  and startup/disconnect.
- Keep a small compatibility test proving the composed `rallar` facade exposes
  the expected public shape and shared lifecycle behavior.
- Add direct tests for each new internal domain factory where fake context
  testing is simpler than full facade setup.
- Keep black-box and app-level tests as integration coverage, not the only proof
  of package behavior.

Acceptance criteria:

- A targeted change in one domain has a targeted test file.
- Cross-domain lifecycle tests still cover startup, logout, auth expiry, and
  disconnect cleanup.
- No behavior coverage is dropped during the split.

Suggested validation:

- `npx vitest run packages/tests/shared-web`
- `npm --workspace ar-eye-hunter-v1 run build`
- `npm --workspace relic-hunters-v1 run test`
- `npm --workspace relic-hunters-v1 run build`

Implemented work:

- Added focused compatibility suites for defaults/options, composed facade
  shape, startup lifecycle, facade defaults, room/people state and events,
  typed message channels, typed realtime JSON lanes, RTC diagnostics, RTC
  recovery, WS lifecycle, workflow options, auth/session lifecycle, RTC waits,
  realtime send/listen/health, targeted channels, director relay, calls, media
  sources, and low-level RTC/WS message sends.
- Moved all broad cross-domain behavior out of
  `packages/tests/shared-web/rallar-operation-options.test.ts`. That file now
  only verifies `toRallarOperationOptions(...)` compatibility for existing repo
  commands that reference the filename.
- Moved the old operation-option normalization check out of
  `rallar-defaults-options.test.ts` and into the reduced
  `rallar-operation-options.test.ts`, keeping the shared-web test count stable.
- Kept all public `@shared-web/browser/rallar.ts` imports and app imports
  unchanged. No production shared-web modules were changed in this iteration.

Validation run:

- Each final focused suite was run alone:
  RTC recovery 6 tests, WS lifecycle 9, workflow options 9, auth/session 14,
  RTC wait 15, realtime send/listen 7, targeted channel 2, director relay 3,
  calls 3, media sources 3, and message send 8.
- Each final focused suite was also run with
  `packages/tests/shared-web/rallar-operation-options.test.ts`; all pair runs
  passed.
- `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts packages/tests/shared-web/rallar-defaults-options.test.ts`
  passed: 2 files, 3 tests.
- `npx vitest run packages/tests/shared-web` passed: 50 files, 255 tests.
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed.
- `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
  passed: 1 file, 5 tests.
- `rg -n "@shared-web/(browser/rallar|mod|game/mod)|@shared-web/browser/rallar\\.ts|@shared-web/game/mod\\.ts" apps --glob '!node_modules'`
  confirmed existing app imports remain on the compatibility paths.
- `npm --workspace ar-eye-hunter-v1 run build` passed with the existing Vite
  large-chunk warnings.
- `npm --workspace relic-hunters-v1 run test` passed: 20 files, 100 tests.
- `npm --workspace relic-hunters-v1 run build` passed with the existing Vite
  large-chunk warnings.

Remaining work:

- Iteration 5 is complete. Continue with Iteration 6 for smaller public browser
  entry points.

## Iteration 6: Add Smaller Public Browser Entry Points

Goal: let apps import what they mean, while old imports keep working.

Implementation status: completed on 2026-06-15 as a compatibility-first public
entry-point pass. App imports were intentionally not migrated in this
iteration.

Key changes:

- Keep `@shared-web/browser/rallar.ts` as the full compatibility facade.
- Add narrower public entry points:
  - browser core: config, auth, startup, rooms, people, WS messages, state
    events, and subscriptions.
  - browser realtime: core plus RTC lane readiness and realtime send/listen.
  - browser data: data stores without CRDT transport.
  - browser crdt: CRDT facade and CRDT transports.
  - browser media/calls: calls and media source controls.
- Update `packages/shared-web/mod.ts` so it remains compatible, but document
  that apps should prefer specific browser entry points.
- Do not migrate every app at once. Start with Relic or a package test consumer,
  then AR Eye, while keeping black-box on the full facade.

Acceptance criteria:

- Existing imports from `@shared-web/browser/rallar.ts` still compile.
- New entry points can be bundled independently and measured.
- A room/auth-only consumer can avoid CRDT/media/call imports.

Suggested validation:

- Add import smoke tests for each new entry point.
- Run bundle-size measurements for each entry point and compare to the baseline.
- Build AR Eye and Relic after any app migration.

Implemented work:

- Added narrow public browser entry points:
  `packages/shared-web/browser/rallar-core.ts`,
  `packages/shared-web/browser/rallar-realtime.ts`, and
  `packages/shared-web/browser/rallar-media-calls.ts`.
- Kept `packages/shared-web/browser/rallar.ts` as the full compatibility
  facade exporting `rallar` and `createRallarFacade`; the new entry points do
  not export those singleton/composer APIs.
- Treated existing `packages/shared-web/browser/rallar-data.ts` and
  `packages/shared-web/browser/rallar-crdt.ts` as the data and CRDT entry
  points rather than adding duplicate aliases.
- Added `packages/tests/shared-web/shared-web-browser-entrypoints.test.ts` to
  dynamically import each narrow entry point, assert expected factory/helper
  exports, assert forbidden full-facade exports are absent, and prove the new
  files do not runtime-import `browser/rallar.ts`.
- Extended
  `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts` with API
  snapshots for the new public entry points.
- Extended
  `packages/shared-web/scripts/measure-browser-bundles.mjs` so the reporting
  script measures the new entry points, `rallar-data.ts`, and `rallar-crdt.ts`
  alongside the full facade and `mod.ts`.
- Updated `packages/shared-web/architecture.md` with the new import guidance and
  Iteration 6 bundle measurements.
- Left app imports unchanged. AR Eye, Relic Hunters, and Rallar Black Box still
  import from the existing compatibility paths.

Measured sizes:

- `browser/rallar.ts`: 658.2 KiB minified, 162.9 KiB gzip, 136.4 KiB Brotli.
- `browser/rallar-core.ts`: 2.3 KiB minified, 0.8 KiB gzip, 0.7 KiB Brotli.
- `browser/rallar-realtime.ts`: 3.4 KiB minified, 1.0 KiB gzip, 0.9 KiB
  Brotli.
- `browser/rallar-data.ts`: 28.5 KiB minified, 6.7 KiB gzip, 6.0 KiB Brotli.
- `browser/rallar-crdt.ts`: 73.7 KiB minified, 17.4 KiB gzip, 15.7 KiB Brotli.
- `browser/rallar-media-calls.ts`: 0.5 KiB minified, 0.3 KiB gzip, 0.2 KiB
  Brotli.
- `shared-web/mod.ts`: 697.2 KiB minified, 172.0 KiB gzip, 144.6 KiB Brotli.

Validation run:

- `npx vitest run packages/tests/shared-web/shared-web-browser-entrypoints.test.ts`
  failed before implementation because the new entrypoint modules did not
  exist, then passed after adding the narrow barrels.
- `npx vitest run packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
  passed: 2 files, 14 tests.
- `npm --workspace @ar-eye-hunter/shared-web run measure:browser-bundles`
  completed and printed the Iteration 6 sizes above.
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed.
- `npx vitest run packages/tests/shared-web` passed: 51 files, 264 tests.
- `rg -n "@shared-web/(browser/rallar|mod|game/mod)|@shared-web/browser/rallar\\.ts|@shared-web/game/mod\\.ts" apps --glob '!node_modules'`
  confirmed app imports remain on the existing compatibility paths.
- `npm --workspace ar-eye-hunter-v1 run build` passed with the existing Vite
  large-chunk warnings.
- `npm --workspace relic-hunters-v1 run test` passed: 20 files, 100 tests.
- `npm --workspace relic-hunters-v1 run build` passed with the existing Vite
  large-chunk warnings.
- `git diff --check -- packages/shared-web packages/tests/shared-web plans/rallar-shared-web-modularization-iterations-plan.md`
  passed.

Remaining work:

- Continue with Iteration 7. App migration to the narrow entry points should be
  deliberate and measured rather than bundled into this public-surface pass.
- Build AR Eye and Relic after any app migration.

## Iteration 7: Dependency And Bundle Boundary Pass

Goal: reduce browser cost by making heavyweight dependencies opt-in where
possible.

Implementation status: completed on 2026-06-15 as a package dependency and
bundle-budget guardrail pass. App import cleanup and deeper shared Temporal
refactors remain future work.

Key changes:

- Remove implicit app reliance on `@shared-web/mod.ts` side effects. Apps should
  import explicit setup modules if repository/cache initialization is needed.
- Isolate `@js-temporal/polyfill` use behind queue/runtime modules and app-level
  compatibility policy. Prefer native `Temporal` when supported, and make the
  polyfill an app responsibility or lazy compatibility import.
- Keep `graphology` out of core browser entry points. Graph/topology features
  should live behind graph-specific imports or black-box/topology tooling.
- Add package-level bundle budgets:
  - full facade may stay around the current 135-145 KiB Brotli while it remains
    the "everything" import.
  - core browser entry point should target less than 100 KiB Brotli, ideally
    much lower once Temporal polyfill is not pulled into core.
  - any new dependency over 10 KiB Brotli should be called out in review.

Acceptance criteria:

- Importing the core browser entry point does not pull graphology.
- Importing core does not force the Temporal polyfill when native Temporal is
  the supported baseline.
- Bundle measurement output is visible in CI or a documented local check.

Suggested validation:

- Bundle core, realtime, CRDT, data, and full facade entry points with esbuild.
- Run `npm run test:unit` or at least all shared-web tests.

Implemented work:

- Added
  `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts` to
  bundle key browser entry points with esbuild metafiles and assert narrow core
  and realtime entries do not pull `graphology`, `@js-temporal/polyfill`, or
  the full `browser/rallar.ts` runtime composer.
- Added Brotli budget assertions for full facade, core, realtime, data, CRDT,
  and media/calls entry points.
- Removed the unused `graphology` dependency from
  `packages/shared-web/package.json` and `package-lock.json`. `graphology`
  remains in `packages/shared-graph` and app packages that declare graph
  features directly.
- Extended
  `packages/shared-web/scripts/measure-browser-bundles.mjs` with budget
  metadata, status output, and a `--check` mode.
- Added
  `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` as the
  enforcing bundle-budget command.
- Left `@js-temporal/polyfill` in shared-web dependencies because shared
  queue/runtime modules consumed by the full facade still import Temporal
  directly. This iteration only prevents Temporal from leaking into the narrow
  core/realtime bundles.
- Updated `packages/shared-web/architecture.md` with the dependency boundaries,
  budget command, and current measurements.

Measured sizes:

- `browser/rallar.ts`: 658.2 KiB minified, 162.9 KiB gzip, 136.4 KiB Brotli,
  budget < 160.0 KiB.
- `browser/rallar-core.ts`: 2.3 KiB minified, 0.8 KiB gzip, 0.7 KiB Brotli,
  budget < 100.0 KiB.
- `browser/rallar-realtime.ts`: 3.4 KiB minified, 1.0 KiB gzip, 0.9 KiB Brotli,
  budget < 100.0 KiB.
- `browser/rallar-data.ts`: 28.5 KiB minified, 6.7 KiB gzip, 6.0 KiB Brotli,
  budget < 20.0 KiB.
- `browser/rallar-crdt.ts`: 73.7 KiB minified, 17.4 KiB gzip, 15.7 KiB Brotli,
  budget < 30.0 KiB.
- `browser/rallar-media-calls.ts`: 0.5 KiB minified, 0.3 KiB gzip, 0.2 KiB
  Brotli, budget < 10.0 KiB.
- `shared-web/mod.ts`: 697.2 KiB minified, 172.0 KiB gzip, 144.6 KiB Brotli,
  no enforced budget.

Validation run:

- `npx vitest run packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
  failed before implementation because shared-web still declared `graphology`,
  then passed after removing the dependency and adding the budget command.
- `npx vitest run packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
  passed: 3 files, 17 tests.
- `npm --workspace @ar-eye-hunter/shared-web run measure:browser-bundles`
  completed and printed the budget/status table above.
- `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
  passed and reported all budgeted entries as `ok`.
- `npx vitest run packages/tests/shared-web` passed: 52 files, 267 tests.
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed.
- `rg -n "@shared-web/(browser/rallar|mod|game/mod)|@shared-web/browser/rallar\\.ts|@shared-web/game/mod\\.ts" apps --glob '!node_modules' --glob '!dist'`
  confirmed app imports remain on existing compatibility paths.
- `npm --workspace ar-eye-hunter-v1 run build` passed with the existing Vite
  large-chunk warnings.
- `npm --workspace relic-hunters-v1 run test` passed: 20 files, 100 tests.
- `npm --workspace relic-hunters-v1 run build` passed with the existing Vite
  large-chunk warnings.
- `npm --workspace rallar-black-box run build` passed with the existing Vite
  large-chunk warnings.

Remaining work:

- Continue with Iteration 8 for app import cleanup; do not mix it into this
  dependency-boundary pass.

## Iteration 8: App Consumption Cleanup

Goal: make app usage demonstrate the intended product layers.

Implementation status: completed on 2026-06-15 as a narrow app import-boundary
cleanup. App behavior, public shared-web APIs, and the full `rallar` facade
shape were left unchanged.

Key changes:

- AR Eye should import only explicit Rallar surfaces: full facade while it still
  needs director, realtime, RTC diagnostics, data, and game layers; remove
  broad side-effect imports where possible.
- Relic should continue using its runtime adapter pattern, but that adapter
  should depend on the narrowest Rallar facade type it needs.
- Black-box should intentionally keep using the full facade and dynamic import
  path as a compatibility test target.
- Add app-level notes or tests that verify room creation, auth lifecycle,
  realtime motion, and RTC lane readiness still work after import changes.

Acceptance criteria:

- App imports reveal whether the app needs core, realtime, data, CRDT, media, or
  the full facade.
- No app has to understand new internal shared-web modules.
- Black-box remains the broad conformance consumer.

Suggested validation:

- `npm --workspace ar-eye-hunter-v1 run build`
- `npm --workspace relic-hunters-v1 run test`
- `npm --workspace relic-hunters-v1 run build`
- `npm --workspace rallar-black-box run build`

Implemented work:

- Added `packages/tests/shared-web/shared-web-app-import-boundaries.test.ts` as
  a static app-boundary guard. It verifies AR Eye does not depend on broad
  side-effect barrels, AR Eye still imports the full `rallar` compatibility
  facade explicitly, Relic keeps its runtime adapter boundary without importing
  `@shared-web/mod.ts`, and Rallar Black Box still dynamically imports the full
  facade as a compatibility target.
- Verified the new boundary test failed before the app edit because
  `apps/ar-eye-hunter-v1/src/main.tsx` still imported `@shared/mod.ts`,
  `@shared-graph/mod.ts`, and `@shared-web/mod.ts` for side effects.
- Removed only those three broad side-effect imports from AR Eye's
  `main.tsx`. The explicit `@shared-web/browser/rallar.ts` facade import
  remains in place because AR Eye still uses full-facade product behavior.
- Kept Relic on its existing runtime adapter pattern and did not migrate it to
  the new narrow shared-web entry points. Relic still needs auth, startup,
  rooms, WS/RTC messages, realtime motion, RTC lane readiness, and authority
  integration through the app runtime boundary.
- Kept Rallar Black Box on the full facade dynamic import path so it remains
  the broad conformance consumer.

Validation run:

- `npx vitest run packages/tests/shared-web/shared-web-app-import-boundaries.test.ts`
  first failed with the expected AR Eye broad-import assertion, then passed
  after the import cleanup: 3 tests.
- `npx vitest run packages/tests/shared-web/shared-web-app-import-boundaries.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
  passed: 3 files, 12 tests.
- `npx vitest run packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts packages/tests/ar-eye-hunter-v1/rallarGameMatchAdapter.test.ts apps/relic-hunters-v1/tests/relic-hunters-runtime.test.ts apps/relic-hunters-v1/tests/scene-networking.test.ts`
  passed for the two package-level AR Eye files: 2 files, 9 tests. The Relic
  app test files are covered by the workspace app test command below.
- `npm --workspace ar-eye-hunter-v1 run build` passed with existing Vite
  large-chunk warnings.
- `npm --workspace relic-hunters-v1 run test` passed: 20 files, 100 tests.
- `npm --workspace relic-hunters-v1 run build` passed with existing Vite
  large-chunk warnings.
- `npm --workspace rallar-black-box run build` passed with existing Vite
  large-chunk warnings.
- `rg -n "@shared-web/mod\\.ts|@shared/mod\\.ts|@shared-graph/mod\\.ts" apps --glob '!dist'`
  returned no matches, confirming app code no longer imports those broad
  barrels.

Remaining work:

- Continue with Iteration 9 for product-oriented room transport intent and
  typed realtime/channel helpers. Do not fold that product API work into the
  app import-boundary cleanup.

## Iteration 9: Product API Follow-Through

Goal: improve the product surface after the implementation is modular enough to
change safely.

Implementation status: completed on 2026-06-15 as a compatibility-first product
API pass. Existing low-level transport APIs and app imports remain supported.

Key changes:

- Promote room-level transport intent so apps stop polling lower-level RTC
  primitives for common flows.
- Add typed room realtime/channel helpers that own RTC/WS fallback, stale send
  handling, and diagnostics.
- Make director and game authority APIs consume those helpers rather than
  reaching across multiple facade branches.
- Keep low-level `rallar.rtc.*`, `rallar.messages.*`, and `rallar.realtime.*`
  available for advanced users and black-box testing.

Acceptance criteria:

- AR Eye and Relic can express "send this room motion/game payload" without
  manually coordinating `readyPeerIds()` and `waitForRoomLane()` at every call
  site.
- The lower-level APIs remain testable and documented as advanced surfaces.
- The full facade remains compatible while new product-oriented helpers become
  the recommended path.

Implemented work:

- Added `rallar.realtime.room<T>(defaults)` with `send`, `on`, `status`, and
  `wait` methods. The room send path resolves room identity, checks current RTC
  room status, waits for room lane readiness when needed, targets ready room
  peers, forwards stale-send options, and returns room transport diagnostics.
- Added `rallar.messages.room<T>(definition)` as a typed room message helper
  over existing RTC/WS message lanes. It applies room defaults to `send`,
  `sendRtc`, and `sendWs`, with `send` preserving the existing
  RTC-with-WS-fallback behavior.
- Exported the new room helper types from the full facade and the narrow
  realtime/core entry points, and updated facade shape/API snapshot tests.
- Migrated Relic motion broadcasting and AR Eye direct fallback game sends to
  `rallar.realtime.room` without changing app imports.
- Migrated room-scoped shared-web game match sends and authority-client
  room-scoped WS/RTC sends to the new room helpers. Targeted director sends,
  diagnostics waits, and low-level black-box surfaces remain on the advanced
  APIs intentionally.
- Updated `packages/shared-web/architecture.md` to document the room helpers as
  the recommended app-level room transport surface and the low-level APIs as
  advanced/diagnostic surfaces.

Validation run:

- `npx vitest run packages/tests/shared-web/rallar-room-realtime-channel.test.ts packages/tests/shared-web/rallar-message-channel-compat.test.ts packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/rallar-game-authority-client.test.ts`
  passed: 4 files, 30 tests.
- `npx vitest run packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts packages/tests/ar-eye-hunter-v1/rallarGameMatchAdapter.test.ts`
  passed: 2 files, 9 tests.
- `npx vitest run tests/scene-networking.test.ts` from
  `apps/relic-hunters-v1` passed: 1 file, 8 tests.
- `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
  passed: 3 files, 17 tests.
- `npx vitest run packages/tests/shared-web` passed: 54 files, 275 tests.
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed.
- `npm --workspace ar-eye-hunter-v1 run build` passed with existing Vite
  large-chunk warnings.
- `npm --workspace relic-hunters-v1 run test` passed: 20 files, 100 tests.
- `npm --workspace relic-hunters-v1 run build` passed with existing Vite
  large-chunk warnings.
- `npm --workspace rallar-black-box run build` passed with existing Vite
  large-chunk warnings.

## Recommended Order

1. Baseline guardrails and bundle measurements.
2. Pure helper/type extraction from `rallar.ts`.
3. Shared runtime context.
4. Domain factories behind the existing facade shape.
5. Test suite split.
6. Smaller public entry points.
7. Dependency/bundle boundary pass.
8. App import cleanup.
9. Product API follow-through for room transport intent.

This order minimizes risk: first make behavior visible, then move pure code,
then split stateful code, then expose smaller imports, and only then change the
product API shape that apps should prefer.

## Non-Goals For The First Refactor Pass

- Do not remove or rename `rallar` or `createRallarFacade()`.
- Do not force AR Eye, Relic, or black-box onto new entry points in the same
  change that splits internals.
- Do not redesign RTC topology, CRDT sync, or game authority while extracting
  modules.
- Do not add a second browser runtime singleton.
- Do not hide low-level diagnostics; they are important for black-box and
  product trust.

## Overall Acceptance Criteria

- Same public facade behavior for existing app imports.
- `rallar.ts` becomes a compatibility composer rather than an 8k-line
  implementation file.
- Each major domain has an owner module and targeted tests.
- Smaller public entry points exist and have measured bundle sizes.
- Apps can migrate gradually.
- Bundle growth and public API growth are visible in review.
