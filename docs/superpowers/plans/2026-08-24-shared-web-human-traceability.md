# Shared-Web Human Traceability Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task. Use
> `superpowers:test-driven-development` for behavior changes,
> `rallar-repo:adaptive-plan-execution` for horizon decisions,
> `rallar-repo:rallar-code-writing` for every changed human-authored file,
> `rallar-repo:organizing-repository-structure` for moves and splits,
> `rallar-repo:rallar-platform`, `rallar-repo:rallar-realtime`,
> `rallar-repo:rallar-ai`, and `rallar-repo:rallar-games` for their owned
> boundaries, `rallar-repo:rallar-testing` for validation, and
> `rallar-repo:publishing-plan-progress` for delivery. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Make `packages/shared-web/**` directly navigable from each public
browser entry through construction, lifecycle, feature decisions, transport or
persistence effects, failures, cleanup, and caller-visible results. Preserve
browser behavior and intentional package entrypoints while deleting obsolete
exports, aliases, old paths, compatibility modules, and coupled tests.

**Architecture:** Preserve `rallar.ts`, the five narrow browser entrypoints,
`mod.ts`, and `game/mod.ts` as intentional public boundaries. Repair the hidden
construction cycles and duplicate connection shutdown before relocating
implementation owners from the technical `rallar-runtime/` bucket into
feature-owned folders. Migrate one control-flow family at a time, mirror its
tests, update all consumers atomically, and delete the superseded path instead
of adding or retaining backward-compatibility scaffolding.

**Tech Stack:** TypeScript with `erasableSyntaxOnly`, browser APIs, IndexedDB,
WebSocket, WebRTC, QueueBox/AL, Vitest, esbuild bundle analysis, Vite application
builds, dprint, and repository style/structure/legacy checks.

**Spec:**
[`plans/repo-human-traceability-refactoring-program-plan.md`](../../../plans/repo-human-traceability-refactoring-program-plan.md),
Wave 4 and the child-plan entry/exit contract. The completed
[`plans/rallar-shared-web-modularization-iterations-plan.md`](../../../plans/rallar-shared-web-modularization-iterations-plan.md)
is historical implementation evidence whose intentional entrypoint and bundle
results remain constraints. Its old export inventory is audit evidence, not
authority to keep obsolete exports or paths.

**Planning base:** `4d46d428d` (`main` and `origin/main` when this audit began).
Before implementation, fetch current `origin/main`, authenticate the live paths
and consumers again, and amend this plan only if ownership, intentional public
or persisted contracts, or acceptance materially changed.

## Global Constraints

- Implement each approved slice on a fresh `codex/` branch based on current
  `origin/main`; this plan's presence on `main` does not authorize production
  changes or a default-branch commit.
- Keep `browser/rallar.ts`, `browser/rallar-core.ts`,
  `browser/rallar-realtime.ts`, `browser/rallar-data.ts`,
  `browser/rallar-crdt.ts`, `browser/rallar-media-calls.ts`, `game/mod.ts`, and
  `mod.ts` only as intentional current package entrypoints. Remove obsolete
  factories, aliases, and exports from those entrypoints, update every verified
  repository consumer in the same slice, and intentionally update public
  snapshots. This plan authorizes that code-level surface cleanup without an
  old-path shim.
- Preserve the full-facade singleton and factory behavior, room and message
  behavior, connect/auth/start/disconnect ordering, cache convergence,
  IndexedDB formats and keys, WS/RTC wire shapes, CRDT formats, AI lifecycle,
  game authority behavior, and browser bundle budgets.
- Preserve the explicit browser `room` to authoritative `group-state`
  translation at `browser/rooms/room-group-state-translation.ts`. Do not add a
  second translation boundary or replace scoped `GroupRef`/`roomRef` identity
  with bare IDs.
- Delete `browser/rallar-rooms-facade.ts`, the old room workflow exports from
  `browser/api-workflows.ts`, and their exact-identity compatibility tests when
  Slice 2 moves every verified consumer to the owning `browser/rooms/**`
  modules. Do not replace them with re-export files or forwarding functions.
- Delete forwarding factories, rename-only aliases, deprecated exports,
  old-path modules, fallbacks retained for predecessor behavior, and tests that
  only protect those shapes. Public snapshots are updated to the intended
  canonical surface; they do not veto legacy deletion.
- Do not add or retain backward-compatibility modules, shims, re-export hops,
  dual old/new implementations, deprecated aliases, or fallback modes. If a
  wire or persisted contract cannot change atomically, stop for a direct
  migration decision; do not solve it with coexistence scaffolding.
- Production code, tests, fixtures, mocks, test-support helpers, scripts, and
  configuration are all human-authored code and follow the authoritative
  repository code standard. Tests receive no structural, naming, construction,
  callback, type-organization, cognitive-indirection, or touched-file exemption.
- Every changed human-authored file is reviewed and remediated in full. Every
  support file modified by that remediation enters closure recursively until
  closure. Independent untouched code remains outside closure.
- Delete all affected legacy production and test code after moving verified
  consumers. A pre-existing path, external-use uncertainty, coupled test, old
  snapshot, or previous compatibility approval is not a retention reason. No
  affected legacy item may finish this plan as `retained` or
  `minimized-boundary`.
- When improved production ownership invalidates a test coupled to private file
  placement, helper topology, call order, or predecessor behavior, rewrite or
  delete the test. Never restore inferior production structure or keep a shim
  to satisfy it.
- Semantic behavior tests are primary. Public-export, import-tree, source
  inventory, and bundle-boundary tests remain supplementary protection for the
  public or build boundary they actually own.
- Structure and code-standard alignment are separate review stages for a
  public/cross-package or greater-than-20-file family. Split again before
  implementation when a predicted review approaches 100 changed files or
  10,000 changed lines.
- Keep only the next two independently testable slices concrete. Later package
  outcomes in this document are binding acceptance and ownership constraints;
  after Slice 2, recover current source evidence and make only the next one or
  two slices concrete.

## Current-Main Evidence

### Inventory and test shape

- Production contains 118 TypeScript modules and approximately 28,000 physical
  lines: 107 modules under `browser/`, 10 under `game/`, and `mod.ts`.
- `browser/` has 44 direct TypeScript files and `browser/rallar-runtime/` has
  22; both cross the directory ownership-review threshold.
- `browser/rooms/` has 17 modules and is the useful feature-first precedent.
- Tests contain 96 TypeScript modules. Sixty-nine remain flat at
  `packages/tests/shared-web/`; only `rooms/` and `people/` substantially mirror
  production ownership.
- A full-detail static scan over `packages/shared-web` found 306 review
  findings: 159 `boundary.unknown`, 55 input-contract, 21 rename-alias, 13
  cognitive-load, 10 pass-through, 9 primary-export-name, 8
  definite-assignment, 5 responsibility-count, 4 forward-capture, 4
  output-contract, 3 file-length, and smaller construction/layout findings.
  These are review prompts, not mechanical rewrite instructions.

### Public and consumer boundaries

- `@shared-web/browser/rallar.ts` has 31 verified repository consumers across
  AR Eye, Relic Hunters, Rallar Black Box, and shared-test.
- `@shared-web/game/mod.ts` has 10 verified game consumers.
- `browser/api-integration.ts` has two non-test deep consumers in current
  repository code; `browser/rallar-ai.ts` has five app consumers.
- No repository app, example, or shared-test consumer imports the individual
  root `rallar-*-facade.ts` modules, but the public snapshots deliberately
  export their factories and contracts. External-use uncertainty does not
  justify retaining these forwarding exports: the implementation inventory
  updates verified repository consumers, removes obsolete exports, and updates
  the snapshots without a compatibility layer.
- The current full facade remains close to its strict bundle ceiling. Re-run
  the enforcing bundle command before every slice; do not rely on the stale
  measurements in `packages/shared-web/architecture.md`.

### Existing behavior and characterization evidence

- `shared-web-public-api-snapshots.test.ts`,
  `shared-web-browser-entrypoints.test.ts`, and
  `shared-web-browser-bundle-boundaries.test.ts` protect the intended package
  entries and build boundary.
- `rallar-runtime-foundations.test.ts`, `rallar-startup-lifecycle.test.ts`,
  current facade/workflow-options compatibility tests, state/cache/event tests,
  room tests, and auth/middleware tests cover the construction and lifecycle
  families selected for Slice 1. Move independently required facade/setup
  assertions to canonical behavior tests and delete the compatibility tests;
  none currently proves completed-value construction or one exactly-once
  transport cleanup owner.
- `api-integration-ws-ticket-backoff.test.ts`, `api-mutation-failure.test.ts`,
  `api-workflows.test.ts`, `api-workflows-group-mutations.test.ts`, and room
  old-path workflow tests cover the broad modules selected for Slice 2. Move
  independently required assertions to canonical feature tests and delete the
  old-path coupling.
- The planning audit's focused seven-file runtime suite passed 62 tests;
  `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed; and
  `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` passed
  with the full facade at about 158.7 KiB Brotli against the strict 160 KiB
  limit. These results characterize the planning base only and are rerun on
  the implementation branch.

The current compatibility-named test inventory is explicit deletion work, not
a protected surface:

| Owning slice/outcome | Delete after transferring independent behavior                                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slice 1              | `rallar-facade-compat.test.ts`, `rallar-workflow-options-compat.test.ts`                                                                                                                                                                            |
| Slice 2              | `rooms/room-workflow-compat.test.ts`                                                                                                                                                                                                                |
| Outcome 4            | `rallar-message-channel-compat.test.ts`, `rallar-message-send-compat.test.ts`, `rallar-ws-lifecycle-compat.test.ts`                                                                                                                                 |
| Outcome 5            | `rallar-realtime-send-listen-compat.test.ts`, `rallar-realtime-json-lane-compat.test.ts`, `rallar-targeted-channel-compat.test.ts`, `rallar-rtc-recovery-compat.test.ts`, `rallar-rtc-wait-compat.test.ts`, `rallar-rtc-diagnostics-compat.test.ts` |
| Outcome 6            | `rallar-calls-compat.test.ts`, `rallar-media-sources-compat.test.ts`                                                                                                                                                                                |
| Outcome 7            | `people/people-events-compat.test.ts`, `people/people-state-compat.test.ts`, `rallar-stats-compat.test.ts`, `rallar-director-relay-compat.test.ts`                                                                                                  |

For each file, first identify any independent observable behavior or current
product boundary it proves and move that assertion to the canonical feature
suite. Then delete the compatibility test and the predecessor production path;
do not merely rename a coupled assertion.

### Representative construction and runtime trace

```text
rallar singleton / createRallarFacade
  -> createBrowserRallarFacade
  -> createBrowserRuntimeFoundation
  -> createBrowserStateComposition
  -> createBrowserStateEventComposition
  -> createBrowserMessagingComposition
  -> createBrowserRealtimeComposition
  -> createBrowserRoomPeopleStatsComposition
  -> createBrowserCallsDirectorComposition
  -> register lifecycle participants
  -> createBrowserSessionComposition
  -> createBrowserFacadeAssembly

rallar.setup / start / connect
  -> RallarStartupController.start
  -> RallarSessionController.connect
  -> app-context.initMiddleware
  -> middleware.initialiseMiddleware
  -> API configuration and session ticket
  -> WS, QueueBox, RTC, multicast, streamer, and group services
  -> state-cache registration and hydration
  -> topology hydration and resync registration
  -> heartbeat
  -> lifecycle.attach
  -> lifecycle.connected
  -> caller-visible setup/start result
```

The trace currently hides temporal invariants:

- `browser-runtime-composition.ts` forward-captures `stateStore` and
  `stateEvents` before assignment.
- `browser-session-composition.ts` forward-captures `sessionController` and
  `startupController` before assignment.
- `rallar-runtime/composition.ts` adds a top-level definite-assignment
  `sessionController` supplier used by controllers created earlier.
- `rallar-runtime/session.ts#shutdownApiMiddleware` and
  `browser/app-context.ts#shutdownMiddleware` both own overlapping transport
  teardown, and the live disconnect path can traverse both.

The first implementation work therefore consolidates ownership before moving
files. A prettier filesystem that keeps those temporal invariants would fail
the program goal.

### Concrete-slice size and 40/50/60 function baseline

The 24 named current production modules in Slices 1 and 2 contain four files
over 400 physical lines, three over 500, two over 800, and none over the current
1,200-line physical backstop:

| File                                | Physical lines | Concrete-slice disposition                                                                                  |
| ----------------------------------- | -------------: | ----------------------------------------------------------------------------------------------------------- |
| `browser/rallar-data.ts`            |          1,040 | Close the touched construction/data-scope family in Slice 1; complete feature relocation remains Outcome 9. |
| `browser/api-integration.ts`        |            881 | Split by product HTTP owner in Slice 2.                                                                     |
| `browser/rallar-runtime/session.ts` |            584 | Split session, startup, identity, and transport cleanup ownership in Slice 1.                               |
| `browser/middleware.ts`             |            405 | Keep one transport initialization owner and close the touched initialization family in Slice 1.             |

AST source-span review of those 24 modules found 19 functions over 40 lines,
13 over 50, and eight over 60. The over-60 functions that must be split at a
coherent decision/lifecycle boundary or explicitly approved and registered if
they remain are:

| Function                                  | Current lines | Owner decision                                                                                                |
| ----------------------------------------- | ------------: | ------------------------------------------------------------------------------------------------------------- |
| `createRallarSessionController`           |           441 | Split session identity, connection, auth termination, and cleanup orchestration.                              |
| `initialiseMiddleware`                    |           246 | Split explicit transport construction/registration phases without wrapper factories.                          |
| `createRallarBrowserFacadeRuntimeContext` |           161 | Separate mutable runtime state from facade capability assembly.                                               |
| `createRallarDataFacade`                  |           121 | Close only the touched session-scope construction family in Slice 1; Outcome 9 owns the remaining Data split. |
| `refreshStateHeartbeat`                   |           107 | Move and split under the session heartbeat workflow owner in Slice 2.                                         |
| `connect`                                 |            78 | Keep the visible ordered connection lifecycle under the session owner.                                        |
| `doEndAuthSession`                        |            70 | Keep ordered auth termination while extracting owned side effects.                                            |
| `initMiddleware`                          |            62 | Replace module-global initialization with the transport runtime owner.                                        |

`createRallarStartupController` is exactly 60 lines and remains in the 50–60
review tier. The remaining 41–59-line functions receive the same touched-file
review but are not mechanical split requirements. No matching hard-tier entry
exists in `docs/repo-code-style-exceptions.md`; implementation must remove the
hard-tier condition or obtain explicit human approval and add the required
registry entry.

### Concrete-slice change classification

| Slice   | Mechanical                                                                                                            | Structural                                                             | Semantic                                                                                                               | Contractual                                                                                                                             | Operational                                                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slice 1 | Test co-location, import updates, and removal of obsolete late-binding symbols.                                       | Acyclic construction and one session/transport lifecycle owner.        | Preserve setup, connect, auth, state, Data scope, and cleanup results; add characterization before changing ownership. | Preserve intentional entrypoints while deleting obsolete facade factories, aliases, and old paths; no compatibility shim is authorized. | Cleanup ordering, exactly-once teardown, cancellation, and best-effort failure handling are operationally sensitive and require semantic lifecycle tests. |
| Slice 2 | Feature file/test moves, canonical import updates, and deletion of the broad modules and coupled compatibility tests. | Replace broad API/workflow buckets with product-owned HTTP operations. | Preserve URLs, methods, headers, serialization, validation, abort, and typed failure behavior.                         | Update all verified consumers and public snapshots to canonical owners, then delete the old exports and files in the same slice.        | Network timing and retry behavior remain unchanged; bundle and application consumers are revalidated.                                                     |

### Slice 1 exact current-to-target map

| Current owner                                                                             | Slice 1 target/disposition                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rallar-runtime/composition/browser-runtime-composition.ts` late-bound state composition  | Same composition entry during Slice 1, but it constructs completed state-cache and WS-inbox ports before state, room-state, state-event, and room-event consumers. Later relocation is not part of Slice 1.                                          |
| `rallar-runtime/state-store.ts` plus `rooms/room-state-store.ts` mutual supplier path     | Direct consumers of one completed state-cache read/observation port owned beside `state-store.ts`; no supplier or mediator.                                                                                                                          |
| `rallar-runtime/state-events.ts` plus `rooms/room-events.ts` mutual supplier path         | Direct consumers of the completed subscription capability from `rallar-runtime/ws-inbox.ts`.                                                                                                                                                         |
| `rallar-runtime/composition/browser-session-composition.ts` session/data late binding     | Same composition entry, plus a new `browser/session/session-identity.ts` value/port constructed before Data and session; no `sessionController!` or bind callback.                                                                                   |
| `rallar-runtime/session.ts` startup callback                                              | Session exposes completed connection/auth/identity operations; `startup.ts` consumes those operations and the public facade assembly selects startup directly for setup/start.                                                                       |
| `rallar-runtime/session.ts#shutdownApiMiddleware` and `app-context.ts#shutdownMiddleware` | One new `browser/connection/browser-transport-runtime.ts` stateful owner initializes, activates, and shuts down pending or active middleware exactly once. Both duplicate functions are removed; session calls the completed transport-runtime port. |
| `rallar-runtime/composition.ts` top-level `sessionController!` supplier                   | Direct completed capabilities returned by `createBrowserSessionComposition`; no replacement mutable supplier.                                                                                                                                        |

New filenames in this map are implementation targets. Existing internal paths
receive no forwarding shim. The implementation-time inventory is used to move
verified repository consumers, not to justify legacy retention. The later
feature relocation outcomes must re-authenticate temporary same-path
dispositions rather than assuming they are permanent.

## Locked Target Ownership

The final exact tree is evidence-driven, but these ownership and dependency
directions are locked:

```text
packages/shared-web/
  architecture.md
  mod.ts
  browser/
    README.md
    rallar.ts
    rallar-core.ts
    rallar-realtime.ts
    rallar-data.ts
    rallar-crdt.ts
    rallar-media-calls.ts
    <intentional public facade contracts>
    api/
    auth/
    calls/
    composition/
    connection/
    crdt/
    data/
    director/
    media/
    messages/
    people/
    realtime/
    rooms/
    rtc/
    rtc-diagnostics/
    session/
    state-cache/
    state-read/
    stats/
    websocket/
  game/
    README.md
    mod.ts
    authority/
    match/
    transport/
```

- `browser/README.md` is the durable `repository-navigation-v1` map. It names
  public entries, construction and registration, runtime invocation, results,
  failures, and cleanup for construction/session, API, state, message/WS,
  realtime/RTC, CRDT, Data, AI, and game families.
- Root browser files are limited to intentional public entrypoints and public
  facade contracts. Private runtime ownership does not remain at root merely to
  avoid import edits.
- `composition/` owns top-to-bottom dependency construction and final facade
  assembly. It contains no business policy and no forward-captured supplier.
- `session/` owns authentication/session state and the ordered connect/end
  lifecycle. One transport-runtime port owns shutdown exactly once.
- Feature owners return their public capability directly. A public facade
  factory is not used as an internal forwarding hop.
- `state-cache/` owns accepted browser state and its mutable lifecycle;
  `state-read/` owns remote/read-through behavior. Message-family dispatch has
  named owners rather than one global switchboard.
- `api/` owns generic HTTP request/error/mutation mechanics only. Product API
  calls and workflows live beside connection, CRDT, state-read, RTC topology,
  stats, director, room, and session owners.
- `game/mod.ts` remains the intentional package barrel. Game implementation is
  split only at match lifecycle, authority/election, lane/egress, transport,
  relay/recovery, and diagnostics boundaries.
- No nested barrel exists solely to shorten internal imports.

---

## Slice 1 — Acyclic Browser Construction And One Connection Lifecycle

### Task 1: Freeze public, construction, and cleanup behavior before production edits

**Files:**

- Create: `packages/shared-web/browser/README.md`
- Create: `packages/tests/shared-web/composition/browser-runtime-construction.test.ts`
- Create: `packages/tests/shared-web/composition/browser-facade-behavior.test.ts`
- Create: `packages/tests/shared-web/session/browser-connection-cleanup.test.ts`
- Modify: `packages/shared-web/architecture.md`
- Modify: `packages/tests/shared-web/rallar-runtime-foundations.test.ts`
- Modify: `packages/tests/shared-web/rallar-startup-lifecycle.test.ts`
- Delete after transferring independent behavior:
  `packages/tests/shared-web/rallar-facade-compat.test.ts`
- Delete after transferring independent behavior:
  `packages/tests/shared-web/rallar-workflow-options-compat.test.ts`
- Read and preserve: `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
- Read and preserve: `packages/tests/shared-web/shared-web-browser-entrypoints.test.ts`
- Read and preserve: `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`

**Interfaces:**

- The construction test observes completed dependency values supplied to each
  consumer; it does not assert private factory call order or source text.
- The cleanup test drives disconnect through the real session-owned cleanup
  port and captures WS, QueueBox, RTC, multicast, media, heartbeat, state-cache,
  and lifecycle effects.
- `browser/README.md` uses the repository's current
  `repository-navigation-v1` fenced JSON format and links to production
  symbols, not this plan.

- [ ] Record the exact implementation-base SHA, current public snapshot result,
      current bundle result, and focused style/construction findings in the pull
      request. Do not write those changing identifiers into repository files.
- [ ] Add a failing construction test whose fake dependencies throw if a
      consumer invokes them before construction completes. Exercise one complete
      facade creation and a later setup/connect invocation.
- [ ] Add a failing cleanup test that connects with real owned ports, then
      disconnects and proves each material teardown effect occurs once, cleanup
      remains best-effort only where current behavior requires it, and disconnected
      notification happens after runtime clearing.
- [ ] Extend the existing startup/facade tests to cover no restored session,
      initialization failure, 401-triggered auth termination, concurrent auth end
      during connect, expiry, explicit disconnect, and logout without asserting
      helper topology.
- [ ] Move independently required public facade and setup-options assertions to
      `browser-facade-behavior.test.ts`, then delete both compatibility tests. Do
      not preserve exact factory identity, old overloads, or predecessor import
      paths.
- [ ] Run the new and changed test files. Confirm RED specifically because
      construction still relies on late-bound suppliers and live cleanup has two
      owners; do not accept an unrelated fixture or import failure as the RED gate.
- [ ] Add the durable navigation map with two timelines: construction and
      registration, then runtime invocation and cleanup. Mark the current late
      binding and double shutdown as the next owned correction without claiming
      they are already fixed.
- [ ] Run `npm run format -- packages/shared-web/browser/README.md packages/shared-web/architecture.md packages/tests/shared-web/composition packages/tests/shared-web/session packages/tests/shared-web/rallar-runtime-foundations.test.ts packages/tests/shared-web/rallar-startup-lifecycle.test.ts`.
- [ ] Run the focused tests again and retain the expected RED evidence for the
      two new semantic failures while all unchanged characterization remains green.
- [ ] Review every changed file in full. Recursively include support files
      changed by remediation; leave independent untouched files outside closure.
- [ ] Commit this behavior-characterization/navigation unit on the feature
      branch with message `test(shared-web): characterize browser runtime ownership`.

### Task 2: Remove the state and state-event construction cycles

**Files:**

- Modify: `packages/shared-web/browser/rallar-runtime/composition/browser-runtime-composition.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/state-store.ts`
- Modify: `packages/shared-web/browser/rooms/room-state-store.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/state-events.ts`
- Modify: `packages/shared-web/browser/rooms/room-events.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/ws-inbox.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/contracts.ts`
- Modify: `packages/tests/shared-web/composition/browser-runtime-construction.test.ts`
- Modify: affected state, room-state, room-event, and people-event tests

**Interfaces:**

- `createBrowserStateComposition` constructs lower-level cache/repository reads
  first and passes completed ports to room and aggregate state owners.
- `createBrowserStateEventComposition` constructs one completed WS inbox
  subscription capability, then gives state-event and room-event operations
  direct access without mutual late binding.
- No `readStateStore`, `readStateEvents`, setter, definite-assignment binding,
  mutable closure, or registry replaces the removed cycle.

- [ ] Name the independent production breaks protected by the existing state,
      room-state, room-event, people-event, resync, and cache tests. Delete or
      rewrite assertions that protect only the current mutual factory topology.
- [ ] Introduce the smallest lower-level state-cache read/observation port that
      both room and aggregate state need. Declare it beside its canonical state
      owner and instantiate it before either consumer.
- [ ] Construct room state and aggregate state from completed values. If their
      lifecycle and mutable state cannot state independent responsibilities,
      consolidate them under one stateful owner rather than adding a mediator.
- [ ] Introduce one completed WS inbox subscription port and construct room
      event and state event operations without either reading the not-yet-created
      other owner.
- [ ] Remove the `stateStore!` and `stateEvents!` bindings and every supplier,
      setter, or obsolete contract made unnecessary by the new direction.
- [ ] Run the construction, state-cache/read, room-state, room-event, and
      people-event tests until GREEN.
- [ ] Run `npm run check:repo-style:construction-details -- --root packages/shared-web/browser` and give every finding in changed production files a human disposition.
- [ ] Update the state and event paths in `browser/README.md` from actual
      production symbols and verify a code-only navigation probe reaches entry,
      state decision, effects, failures, and result without a plan.
- [ ] Apply full touched-file standards closure and run `git diff --check`.
- [ ] Commit with message `refactor(shared-web): make browser state construction acyclic`.

### Task 3: Remove session/startup late binding and establish one shutdown owner

**Files:**

- Modify: `packages/shared-web/browser/rallar-runtime/composition.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/composition/browser-session-composition.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/composition/browser-communication-composition.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/composition/browser-product-composition.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/session.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/startup.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/lifecycle.ts`
- Modify: `packages/shared-web/browser/rallar-runtime-context.ts`
- Modify: `packages/shared-web/browser/app-context.ts`
- Modify: `packages/shared-web/browser/middleware.ts`
- Modify: `packages/shared-web/browser/rallar-data.ts`
- Create: `packages/shared-web/browser/session/session-identity.ts`
- Create: `packages/shared-web/browser/connection/browser-transport-runtime.ts`
- Modify: `packages/tests/shared-web/composition/browser-runtime-construction.test.ts`
- Modify: `packages/tests/shared-web/session/browser-connection-cleanup.test.ts`
- Modify: affected auth, data-scope, startup, lifecycle, and facade tests

**Interfaces:**

- A completed session core exposes narrow auth, connection, operation-scope,
  auth-aware-operation, data-scope, and cleanup ports before higher product
  capabilities are constructed.
- Startup depends on a completed connect/auth/room/people capability. Session
  does not receive a callback to a startup owner created later.
- Data scope resolution depends on an immutable/narrow session identity port,
  not the future session controller.
- `browser/connection/browser-transport-runtime.ts` owns pending and active
  middleware, returns initialized middleware, and performs teardown exactly
  once. `app-context` delegates to that owner and contains no teardown
  algorithm.

- [ ] Write or adapt focused RED tests for session identity/data scope before
      product construction, setup delegating through a completed connect port, and
      live cleanup exactly once.
- [ ] Separate the session core from startup orchestration so dependencies are
      constructed top-to-bottom. Keep current start/setup results and auth timing.
- [ ] Replace every `readSessionController` supplier in canonical composition
      with the narrow completed capability actually required by the consumer.
- [ ] Remove `bindSessionController`, `sessionController!`,
      `startupController!`, and any replacement late-binding mechanism.
- [ ] Move the union of the two shutdown implementations into
      `browser-transport-runtime.ts`, give it explicit pending/active lifecycle
      state, and delete both duplicates. Preserve intentional cleanup ordering and
      best-effort error behavior with semantic tests.
- [ ] Keep intentional public connection/auth behavior unchanged, return the
      public capability directly from canonical composition, and delete any pure
      forwarding factory, obsolete exported facade type, and coupled test in the
      touched closure after updating verified consumers.
- [ ] Run focused auth, startup, data, middleware, connection, lifecycle, and
      facade tests until GREEN.
- [ ] Run the construction-detail checker and confirm zero forward captures in
      the complete `packages/shared-web/browser` construction path.
- [ ] Update `browser/README.md` with the final construction and cleanup
      timelines. Run a code-only navigation probe beginning at
      `createBrowserRallarFacade`; every dependency must be visible above its
      consumer and shutdown must have one owner.
- [ ] Apply full touched-file standards closure and run `git diff --check`.
- [ ] Commit with message `refactor(shared-web): establish one browser session lifecycle`.

### Task 4: Close Slice 1 package and application evidence

**Files:**

- Modify only when tests expose a real affected contract: public snapshots,
  browser entrypoint tests, bundle-boundary tests, and app-import-boundary tests
- Modify: `packages/shared-web/browser/README.md`
- Modify: `packages/shared-web/architecture.md`

- [ ] Run all Slice 1 focused tests plus
      `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/shared-web/shared-web-app-import-boundaries.test.ts`.
- [ ] Run `npx tsc -p packages/shared-web/tsconfig.json --noEmit`.
- [ ] Run `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` and fail the slice on any budget regression.
- [ ] Build AR Eye, Relic Hunters, and Rallar Black Box because the full browser
      construction path is consumed by all three.
- [ ] Run `npm run check:repo-style -- --root packages/shared-web`,
      `npm run check:repo-style:construction-details -- --root packages/shared-web/browser`,
      `npm run check:repo-style:changed -- origin/main WORKTREE`, and
      `npm run check:repo-structure -- --base origin/main`.
- [ ] Review affected production legacy and run
      `npm run review:legacy -- $(git merge-base origin/main HEAD) HEAD`. Give each
      candidate one disposition: `removed` or `resolved`. Delete affected legacy
      tests with the production path; this child does not permit
      `minimized-boundary` or `retained` dispositions.
- [ ] Confirm every changed human-authored file was reviewed and remediated in
      full, every changed support file recursively entered closure, and independent
      untouched files remained outside closure.
- [ ] Record passed, failed, unavailable, and skipped commands in the pull
      request, then publish the reviewed Slice 1 commits without starting Slice 2
      if the post-consolidation navigation probe fails.

---

## Slice 2 — Feature-Owned Browser HTTP And Workflow Boundaries

### Task 5: Characterize broad API behavior before deleting the old owners

**Files:**

- Modify: `packages/tests/shared-web/api-integration-ws-ticket-backoff.test.ts`
- Modify: `packages/tests/shared-web/api-mutation-failure.test.ts`
- Modify: `packages/tests/shared-web/api-workflows.test.ts`
- Modify: `packages/tests/shared-web/api-workflows-group-mutations.test.ts`
- Delete after transferring independent behavior coverage:
  `packages/tests/shared-web/rooms/room-workflow-compat.test.ts`
- Create: `packages/tests/shared-web/api/browser-http-feature-ownership.test.ts`
- Read: `packages/shared-web/browser/api-integration.ts`
- Read: `packages/shared-web/browser/api-workflows.ts`
- Read: every repository consumer returned by the current deep-import search

**Tests:**

- Feature tests call the future owned module and assert request path, method,
  headers, serialized body, response validation, abort behavior, and typed
  failures independently of the old module topology.
- No test asserts exact old-module identity, deprecated exports, forwarding
  behavior, or an obsolete file path. Transfer any independently required
  behavior assertion, then delete the coupled test.

- [ ] Re-run consumer searches for every export in `api-integration.ts` and
      `api-workflows.ts`; map every verified repository consumer to its canonical
      target. Unknown external use does not create a retention task.
- [ ] Add semantic tests for config/ICE, CRDT catch-up, state collections and
      event pages, topology/graph, statistics, group mutation/membership/presence,
      client session, state refresh, heartbeat, and director appointment families.
- [ ] Move independently required room workflow assertions to the canonical
      room owner and delete the old-path exact-identity suite.
- [ ] Run the new feature tests and confirm GREEN against the current broad
      modules before movement. These tests are characterization, so a forced RED is
      neither required nor desirable.
- [ ] Record the old exports and coupled tests that will be deleted. This plan's
      no-shim decision is already explicit: after verified repository consumers
      move, update public snapshots and remove both broad modules in Slice 2.
- [ ] Apply full touched-file standards closure and commit with message
      `test(shared-web): characterize browser HTTP ownership`.

### Task 6: Move each HTTP operation and workflow to its product owner

**Current-to-target ownership map:**

| Current exports                                                | Canonical target                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `readApiConfig`, `readIceCandidates`                           | `browser/connection/connection-http-api.ts`                                                                   |
| `catchUpRallarCrdtDocument`                                    | `browser/crdt/crdt-catch-up-http-api.ts`                                                                      |
| state client/group collections, point reads, and event pages   | `browser/state-read/state-snapshot-http-api.ts` and `browser/state-read/state-event-http-api.ts`              |
| graph reads and topology config/override/reconfigure           | `browser/rtc/rtc-topology-http-api.ts`                                                                        |
| workspace/group/me statistics                                  | `browser/stats/rallar-stats-http-api.ts`                                                                      |
| group create/update/membership/presence requests               | `browser/rooms/room-group-state-http-api.ts` behind the named room/group-state translation                    |
| client session connect/heartbeat                               | `browser/session/client-session-http-api.ts`                                                                  |
| `refreshStateSnapshots`                                        | `browser/state-read/refresh-state-snapshots.ts`                                                               |
| `refreshStateHeartbeat`                                        | `browser/session/refresh-state-heartbeat.ts`                                                                  |
| director appointment workflow                                  | `browser/director/appoint-room-director.ts`                                                                   |
| room invite/join-code workflows                                | existing canonical `browser/rooms/room-membership-group-state-workflows.ts`                                   |
| `browser/rallar-rooms-facade.ts` and old room workflow exports | canonical `browser/rooms/**` owners; update verified consumers and delete the predecessor files/exports/tests |

**Files:**

- Create the canonical target modules in the table
- Delete after moving all owned operations:
  `packages/shared-web/browser/api-integration.ts`
- Delete after moving all owned workflows:
  `packages/shared-web/browser/api-workflows.ts`
- Delete after moving every verified room consumer:
  `packages/shared-web/browser/rallar-rooms-facade.ts`
- Modify: `packages/shared-web/browser/api/http-request.ts`
- Modify: `packages/shared-web/browser/api/http-error.ts`
- Modify: `packages/shared-web/browser/api/state-mutation-http-contracts.ts`
- Modify: direct CRDT, state-read, room, stats, director, connection/session,
  and RTC topology consumers
- Modify: `packages/shared-web/mod.ts`
- Move: corresponding tests into mirrored `api/`, `connection/`, `crdt/`,
  `director/`, `rooms/`, `rtc/`, `session/`, `state-read/`, and `stats/` paths

- [ ] Move one family at a time with Git rename detection. Preserve HTTP paths,
      defaults, serialization, headers, abort propagation, result types, and error
      timing; do not combine structural movement with semantic redesign.
- [ ] Keep generic request/error/mutation mechanics under `browser/api/` and
      pass fully populated feature input into them. Do not add a feature-blind
      translator, workflow, or service bucket.
- [ ] Route every room-facing caller through
      `room-group-state-translation.ts`; run the browser-room boundary checker after
      each room family move.
- [ ] Replace four-or-more positional parameters in canonical owned operations
      with named feature inputs and update every caller in the same family. Do not
      retain the positional form as an overload, alias, or forwarding export.
- [ ] Update every verified consumer to direct owning modules, remove old
      exports from `mod.ts` and the public snapshots, and delete
      `api-integration.ts`, `api-workflows.ts`, and `rallar-rooms-facade.ts` after
      the final consumer moves. Do not leave re-export files.
- [ ] Move semantic tests with their production owner. Delete public
      compatibility, exact-identity, and old-path tests after transferring any
      independently required behavior assertion. Cross-feature public/bundle
      tests remain at the shared-web test root and assert only the canonical
      surface.
- [ ] Run each moved family's focused tests, then the whole Slice 2 test set and
      package typecheck.
- [ ] Update `browser/README.md` API and result/failure paths from production
      symbols. A navigation probe must start from a public operation name and find
      its HTTP side effect and typed result without entering either broad legacy
      module on the canonical path.
- [ ] Apply full touched-file standards closure, inspect rename detection,
      review legacy dispositions, and commit separately reviewable family moves.

### Task 7: Close Slice 2 public, bundle, and consumer evidence

- [ ] Run `npx vitest run packages/tests/shared-web`.
- [ ] Run `npx tsc -p packages/shared-web/tsconfig.json --noEmit`.
- [ ] Run the public API snapshot, browser entrypoint, bundle-boundary, app
      import-boundary, and canonical room translation suites explicitly.
- [ ] Run `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`.
- [ ] Build AR Eye and Relic Hunters. Build Rallar Black Box when a full-facade
      or API-integration path moved.
- [ ] Run default, construction-detail, changed-range, and repository-structure
      checks and give changed-surface findings human dispositions.
- [ ] Confirm `api-integration.ts`, `api-workflows.ts`,
      `rallar-rooms-facade.ts`, their old exports, and their compatibility tests
      no longer exist; no room/group-state crossing bypasses the named boundary;
      and the public snapshots contain only the intentional canonical surface.
- [ ] Confirm full recursive touched-file closure and record exact command
      results in the pull request before selecting the next horizon.

---

## Later Required Outcomes

After Slice 2, recover the live owner, entry, dataflow, failures, tests,
consumers, and affected legacy for the next one or two families. These outcomes
are ordered by dependency and navigation risk; they are not permission to
activate all families concurrently.

### Outcome 3: Browser state cache and remote reads

- Consolidate module-global mutation from `data-caches.ts` into one explicit
  state-cache lifecycle owner.
- Keep `state-cache/` acceptance/convergence separate from `state-read/`
  remote/read-through effects.
- Give group delta, topology adoption, graph hydration, and snapshot/event
  message families named dispatch owners.
- Characterize whether multiple `createRallarFacade()` instances intentionally
  share global cache/session state before changing isolation semantics.
- Delete the legacy bare-event/delta fallback and its coupled tests after all
  verified producers and consumers use the canonical event envelope. If that
  cannot be deployed atomically, stop for a direct protocol migration decision;
  do not add a dual-format decoder or fallback.

### Outcome 4: Messages, WebSocket, browser AL, and QueueBox

- Colocate message send/route policy, typed channels, subscription lifetime,
  WS inbox ordering, WS lifecycle, browser AL stores, and browser QueueBox
  persistence under their truthful feature owners.
- Keep RTC-with-WS fallback as product policy, not generic transport plumbing.
- Preserve exact QoS, expiry, retry, dedupe, routing, and cleanup behavior.
- Mirror message, WS, AL, and QueueBox tests and verify room target validation.

### Outcome 5: RTC and realtime

- Move `rallar-runtime/rtc.ts` and `realtime.ts` beside their public contracts
  only after acyclic composition exists.
- Split RTC at status/room view, wait/readiness, diagnostics, recovery, and
  lifecycle boundaries. Split realtime at receive subscriptions, send/target
  policy, room channels, targeted channels, and health.
- Preserve scoped room identity, data-channel readiness semantics, connection
  attempt budgets, recovery diagnostics, and low-level advanced surfaces.
- Run shared WebRTC/AL tests and both game app builds in addition to shared-web.

### Outcome 6: Calls and media

- Separate call lifecycle and signal routing from media-source lifecycle and
  remote-stream delivery.
- Keep browser resource ownership and cleanup explicit. Do not create a
  controller/facade pair when one stateful owner can return the public
  capability directly.

### Outcome 7: Director, auth, people, and stats

- Split director appointment/status from relay lifecycle.
- Keep auth/session decisions in the session owner; keep people event/state and
  stats reads beside their feature contracts.
- Delete public forwarding factories and rename-only aliases, update every
  verified caller to the canonical owner, and update the public snapshots. Do
  not preserve the old symbols as wrappers or deprecated exports.

### Outcome 8: Browser CRDT

- Keep `browser/rallar-crdt.ts` as the public entrypoint while moving document
  lifecycle, local persistence, live transport, HTTP catch-up, operation
  application, undo/redo, sequence, and numeric implementation to owned
  modules.
- Preserve CRDT keys, envelopes, transport strategy, convergence, recovery,
  encryption, and public contracts. Validate browser and shared CRDT suites.

### Outcome 9: Rallar Data

- Keep `browser/rallar-data.ts` as the public entrypoint while separating
  facade/store lifecycle, repository-backed state, persistence
  encoding/migration, and broadcast synchronization.
- Preserve store identity, scope cleanup, migration semantics, durability,
  hydration, and IndexedDB formats.

### Outcome 10: Browser RallarAI

- Keep shared contracts in `packages/shared/rallar-ai` and live WebLLM/browser
  policy in shared-web.
- Split browser facade/provider execution only at authorization/policy,
  lifecycle, validation, diagnostics, and live-provider boundaries.
- Preserve strict schema validation and AI result proposal/acceptance lifecycle.

### Outcome 11: Browser game helpers

- Execute as a separate child because `game/match.ts` is a high-density public
  game runtime with app-level consumers.
- Keep `game/mod.ts` as the package barrel; split match lifecycle/status,
  election/appointment, lane readiness/egress, transport routing,
  relay/recovery, and diagnostics.
- Move types beside their owner, update all verified consumers, and delete
  generic `game/types.ts` without an alias or re-export file.
- Run shared-web game tests, AR Eye package tests/build, and Relic tests/build.

### Outcome 12: Final package closure

- Root browser production modules are intentional public boundaries; private
  runtime owners are feature-colocated.
- Tests mirror production, except genuinely cross-feature public/bundle/app
  boundary suites.
- No construction forward capture, affected legacy production/test code,
  backward-compatibility module, shim, deprecated alias, dual implementation,
  fallback, coupled old-path test, or unexplained new checker warning remains.
- Every feature with more than 20 modules or three control-flow families has a
  current durable navigation map.
- Public snapshots and bundle budgets pass, both game apps build, and a human
  code-only probe can trace setup/connect, room message, RTC realtime, state
  refresh, CRDT, Data, AI, and game match flows.

## Acceptance Criteria

- [ ] `createBrowserRallarFacade` constructs every dependency before its
      consumer, with no definite-assignment, mutable supplier, setter injection,
      registry, or test-only construction path.
- [ ] Browser connection/session cleanup has one visible owner and semantic
      exactly-once coverage.
- [ ] Every major browser capability has one obvious entry, a feature-owned
      implementation path, mirrored tests, and a durable navigation path when
      required.
- [ ] Every moved or split module has a matching primary exported symbol and
      filename; no unexplained new repository checker finding remains on the
      changed surface.
- [ ] Intentional package entrypoints, runtime behavior, wire/persisted
      contracts, scoped identity, and bundle budgets remain correct. Obsolete
      exports and import paths are removed, every verified consumer is updated,
      and public snapshots intentionally record the smaller canonical surface.
- [ ] No affected backward-compatibility wrapper, shim, old-path re-export,
      deprecated alias, predecessor fallback, duplicate implementation, or test
      coupled only to those shapes exists.
- [ ] Re-run the concrete-slice file-size and AST 40/50/60 inventory on final
      code. Every materially touched file over 800 lines and function over 60
      lines is split at a coherent boundary or has explicit human approval and a
      current `docs/repo-code-style-exceptions.md` entry.
- [ ] All changed files satisfy full recursive touched-file standards closure;
      independent untouched code remained outside closure.
- [ ] Every changed production file, test, fixture, mock, test-support helper,
      script, and configuration file satisfies the authoritative repository code
      standard in full. Tests have no relaxed naming, construction, callback,
      type, function-size, responsibility, or cognitive-indirection standard.
- [ ] Focused tests, `packages/tests/shared-web`, package typecheck, bundle
      budgets, affected app tests/builds, style, changed-range, structure, legacy,
      and required publication gates are reported as passed, failed, unavailable,
      or skipped.

## Explicit Non-Goals

- Do not redesign authoritative group-state, topology, AppInbox, or server
  behavior from this browser package plan.
- Do not redesign public product vocabulary, caller-visible `GroupSnapshot`
  semantics, transport selection policy, persistence formats, or multi-facade
  isolation. This does not preserve obsolete code paths, exports, aliases, or
  fallback implementations.
- Do not split files mechanically by line count or introduce one interface,
  helper, controller, or adapter per file.
- Do not add nested barrels, a second facade singleton, a service locator, or a
  generic `runtime`, `services`, `helpers`, or `types` owner.
- Do not execute more than the next two evidence-backed slices at once.

## Completion Handoff

For every slice, report:

- changed files and the owner-to-result behavior made easier to trace;
- why each keep/split/move/consolidate decision was chosen;
- the intentional canonical public surface, deleted exports/paths/aliases, and
  preserved protocol, persisted, bundle, and app behavior;
- exact passed, failed, unavailable, and skipped validation;
- confirmation that every affected legacy production/test item was deleted or
  resolved and none was retained as a shim, wrapper, fallback, alias, or coupled
  test;
- the code-only navigation probe result;
- the final concrete-slice file-size tiers and 40/50/60 function inventory,
  including the disposition of every touched over-800-line file and over-60-line
  function;
- remaining feature debt and the next one or two evidence-backed outcomes;
- the updated Wave 4 status in
  `plans/repo-human-traceability-refactoring-program-plan.md` or its explicitly
  approved successor ledger;
- confirmation that every changed human-authored file was reviewed in full,
  support-file remediation recursively reached closure, and independent
  untouched files stayed outside closure;
- confirmation that every changed production file, test, fixture, mock, and
  test-support helper satisfies the authoritative code standard in full, not
  merely the currently blocking checker subset;
- follow-up issue URLs, or `Follow-up: None`.
