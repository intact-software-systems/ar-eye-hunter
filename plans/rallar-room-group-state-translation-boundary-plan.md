# Rallar Room/Group-State Translation Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` only after the human explicitly approves this
> exact child-plan revision. Use `rallar-repo:publishing-plan-progress` for
> branch, pull-request, progress, and completion evidence. Use
> `rallar-repo:rallar-platform`, `rallar-repo:rallar-realtime`,
> `rallar-repo:rallar-code-writing`, and `rallar-repo:rallar-testing` for the
> implementation and validation. Use `superpowers:test-driven-development`
> before every production extraction or compatibility change. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the browser room feature independently navigable and establish
one explicit, pure boundary between browser `room` inputs/views and
authoritative `group-state` contracts while preserving every current public
return type, package export, API call, and runtime behavior.

**Architecture:** Move the room facade and browser room ownership out of the
broad browser root and `rallar-runtime` folder into
`packages/shared-web/browser/rooms/`. Keep product orchestration in room-named
modules. Route every construction or projection of authoritative group-state
data through
`packages/shared-web/browser/rooms/room-group-state-translation.ts`. Preserve
the old public facade path and the old public group-workflow exports through
one-hop compatibility re-exports. Use two independently reviewable pull
requests: a behavior-preserving structure-and-boundary pass, followed only
after merge and the required default-branch workflow by a behavior-preserving
code-standard alignment pass.

**Tech Stack:** TypeScript `7.0.2`, Vitest, npm workspaces, Vite, browser Fetch,
the shared-web public entrypoints, the warning-only repository style checker,
Git rename detection, and GitHub Actions publication gates.

## Global Constraints

- This plan is the browser child in Wave 1 of the
  [Repository Human Traceability Refactoring Program](repo-human-traceability-refactoring-program-plan.md).
- Drafting, approval, execution, publication, and handoffs follow the
  [Repository Human Traceability Program Execution Plan](repo-human-traceability-program-execution-plan.md).
- Wave 0 governance/checker is `ledger-published`. Its frozen implementation
  evidence, TypeScript `7.0.2`, warning-only behavior, and strict-mode rejection
  remain unchanged.
- Human approval binds execution to exact plan blob
  `37861202ce25c3cd5832663a5a3f6d7e2e4a0e4e` plus only the explicitly recorded
  amendments in this document. That approval does not extend to the alignment,
  shared-server, API-v1, or later ledger work before their stated gates.
- Do not start the authoritative shared-server or API-v1 child. Their files are
  inspected here only to prove the top-to-bottom call trace and browser
  compatibility boundary.
- Keep package roles fixed: `packages/shared-web` owns the browser product API,
  `packages/shared` owns cross-runtime contracts, `apps/api-v1` owns HTTP
  routes, and `packages/shared-server` owns authoritative mutation behavior.
- `room` remains the browser and product term. `group-state` remains the
  authoritative transport, API, and server term. `GroupRef` and `roomRef`
  remain established protocol identities.
- Preserve the complete `RallarRoomsFacade` public surface, including exact
  `GroupSnapshot`, `GroupEvent`, `StateEventPage<GroupEvent>`, and
  `GroupRef`-based return and property compatibility. Do not introduce a public
  `RallarRoomSnapshot` or other replacement public room contract.
- Preserve `packages/shared-web/mod.ts`, `rallar.ts`, `rallar-core.ts`, and
  `rallar-realtime.ts` export names and runtime/type-only boundaries.
- Preserve every HTTP method, path, body field, omitted-field behavior,
  request-id source, scope rule, retry policy, operation order, cache update,
  event-deduplication rule, timeout, error class, and partial-failure result.
- Do not change OpenAPI, API-v1 routes, AppInbox, shared-server group-state,
  persistence, WebSocket/RTC protocols, application behavior, dependencies,
  GitHub Actions workflow definitions, or checker semantics.
- A test that exposes a current defect does not authorize a fix. Record it,
  stop the affected task, and return this plan for explicit human revision.
- New and materially rewritten production or test modules are at most 400
  physical lines. A touched general function follows the 40/50/60 review tiers.
  Do not use pass-through helpers to satisfy a numeric limit.
- Preserve unrelated plans, especially
  `plans/rallar-rest-snapshot-read-convergence-implementation-plan.md`.
- Execute and publish the structure/boundary and code-standard alignment passes
  as separate pull requests because the migration moves a public path, touches
  a package boundary, and spans more than approximately 20 source and test
  files.

---

Date: 2026-07-29

Status: approved; structure/boundary Tasks 0 through 6 and code-standard
alignment Tasks 7 and 8 are complete; browser implementation is `complete`;
the separately authorized evidence-ledger publication is pending

**2026-07-30 pre-Task 6 internal-contract reconciliation:** Human review
authorized this plan-only correction after a fresh whole-structure review found
that the seven-method `RallarRoomStateStorePort` inventory below omitted eight
behavior-preserving capabilities already present on the predecessor state
store. The exact implemented fifteen-method contract is the cohesive internal
room-state-store ownership surface. It is not a public package export or a
generic dependency bag. This correction approves no new method, runtime
behavior, public surface, compatibility structure, lifecycle, state, bundle
budget, or Task 7 alignment work.

**2026-07-30 Task 7 internal-contract alignment:** After the structure pass
merged, the approved Task 7 consumer review found that
`resolveCurrentRoomId` and `isSameRoomRefOrId` had no remaining callers beyond
their private room-state-store and retained-runtime delegation sites. The
alignment ratchet therefore removes those two unused private pass-throughs and
retains the exact thirteen-method cohesive internal owner recorded below. This
approves no behavior, public-contract, compatibility, lifecycle, state,
dependency, workflow, checker, TypeScript, or bundle-budget change.

**2026-07-30 Task 8 active test-path reconciliation:** Human review authorized
the active browser-room command and companion-coverage registry updates made
necessary by the approved test-tree moves. The registry now names the exact
room facade, realtime, state-store, and event successor suites together with
the retained people compatibility suites, and its focused test proves that
every active `testFiles` path resolves from the repository root. This
traceability correction approves no runtime behavior, public contract,
dependency, lockfile, workflow, TypeScript, checker, bundle-budget, server,
API-v1, or unrelated-plan change.

Planning base and prerequisite evidence:

- The human approved exact child-plan blob
  `37861202ce25c3cd5832663a5a3f6d7e2e4a0e4e` for the two locked implementation
  pull requests. During structure execution, the human authorized only the
  request-object compatibility, fixed `<192 KiB` headless budget, scoped review
  fixes, test-layout split, and fifteen-method internal state-store contract
  amendments recorded in this document.
- Structure branch `codex/rallar-room-group-state-boundary-structure` published
  Tasks 0 through 6 through PR #53 at exact feature SHA
  `ca6c907c50d12a5d52a2b54ebf81e81cff2c4a54`, tree
  `a43c05ee5046a2a5fec6c7bc7223dfaec5868365`. The PR merged to exact
  `origin/main` SHA `a0baa7ed77c9759e9a3c2c3c3c5da4c5ca845960`, and **Run
  Hetzner Supported Distributed Manifests** run `30506826362` attempt 1
  succeeded for that exact main SHA.
- The pre-Task 6 structure evidence records TypeScript `7.0.2`,
  `layout.browser-room-boundary=0`, the exact four-way test split at
  `164/394/244/313` physical lines with 16 named cases and 65 `expect(...)`
  sites, and a latest accepted headless measurement of `191.541016 KiB`,
  strictly below the fixed `<192 KiB` child budget.
- The alignment branch started from that exact successful structure merge SHA.
  Its frozen tree is `0061bce118c30759d9a71beb867692dc97c0bf84`; final feature
  SHA `ec49e76b95160d2a2d0fb54b140963cd144f3dcd` passed Branch Release Gate
  `30513466787` attempt 1. PR #54 merged as exact `origin/main` SHA
  `d807b602ad0b400c5bfc10b8da955093df57f5ce`, and **Run Hetzner Supported
  Distributed Manifests** run `30516918807` attempt 1 succeeded for that exact
  main SHA. The final alignment headless Brotli measurement was `191.817383
KiB`, strictly below the fixed `<192 KiB` child budget.
- This separately authorized evidence-ledger branch starts from exact
  `origin/main` SHA `d807b602ad0b400c5bfc10b8da955093df57f5ce`, tree
  `0061bce118c30759d9a71beb867692dc97c0bf84`. Its own future tree, commit,
  PR, Branch Release Gate, merge, and default-workflow evidence remain external
  to this plan tree.
- Governance/checker implementation remains frozen at tree
  `47a885540b60765a1a0c95089902a0371e0a7f2b`, feature SHA
  `a986931c250c2f1fa12daa3e8d44a74669b178ed`, Branch Release Gate run
  `30362667041` attempt 2 success, PR #47, resulting `main` SHA
  `4f98f241aefe62c89288e29403ba7f1f23897625`, and **Run Hetzner Supported
  Distributed Manifests** run `30367222275` attempt 1 success.
- Its later ledger tree is `94270ad17f7f68eaa9b95529764c23a844514ae9`,
  ledger feature SHA `c4743acd9fc685292f9fa6a7508d0a08afe05fd6`, Branch
  Release Gate run `30371906927` attempt 1 success, PR #51, resulting `main`
  SHA `7a6c8e0c2cfb3413b4c0fbaaf0af31af2571c015`, and **Run Hetzner
  Supported Distributed Manifests** run `30407710853` attempt 1 success for
  that exact SHA. The governance/checker child is therefore
  `ledger-published`.
- The unrelated REST snapshot plan remains SHA-256
  `0eea5bdfae06aa25005790220b9331ad721eaf5c917b50c8693cef4d5b185189`.

## 1. Scope And Success Boundary

This child owns the current browser room facade, room operations, room state
projection, room events, room presence waiting, and the browser-side workflows
that turn room actions into existing authoritative group-state API calls.

It succeeds when a human can:

1. start at `RallarRoomsFacade.create` or another room method;
2. enter the room feature through `browser-rallar-rooms.ts`;
3. find the owned use case by its matching filename;
4. see exactly one module where room values become group-state requests or
   group snapshots become room views;
5. continue through the existing `api-integration.ts` call and API-v1 route;
6. verify from tests and public snapshots that behavior and compatibility did
   not change.

This child does not reorganize API-v1, shared-server group-state, browser
people, realtime, messages, RTC, or full browser composition. Necessary edits
to mixed state/event composition and imports are limited to separating existing
room ownership. Existing public workflows remain callable under their current
names and paths.

## 2. Current Evidence Inventory

### 2.1 Exact current production tree in scope

The current room path is distributed across these exact files:

```text
packages/shared-web/
  mod.ts                                      # intentional package entrypoint
  browser/
    api-integration.ts                        # HTTP adapter; 1,438 lines
    api-workflows.ts                          # mixed client/group workflows; 1,061 lines
    rallar-connection-facade.ts               # imports RallarRoomState
    rallar-core.ts                            # exports room factory and facade types
    rallar-facade-contract.ts                 # aggregate facade uses RallarRoomsFacade
    rallar-rooms-facade.ts                    # public facade/contracts; 466 lines
    rallar.ts                                 # public full facade; unchanged
    rallar-runtime-context.ts                 # current-room runtime memory; unchanged
    rallar-runtime/
      composition.ts                          # creates state/events/controller/facade; 435 lines
      contracts.ts                            # mixed state and event ports; 170 lines
      director.ts                             # RallarRoomsFacade consumer; 761 lines
      rooms.ts                                # room controller and all room operations; 1,069 lines
      startup.ts                              # RallarRoomsFacade consumer; 124 lines
      state-events.ts                         # mixed room/people events; 804 lines
      state-store.ts                          # mixed room/people state projection; 424 lines
```

The later route and server children own these traced-but-unchanged files:

```text
apps/api-v1/src/routes/group-state-routes.ts
packages/shared-server/rallar-system/services/AppGroupInboxService.ts
packages/shared-server/rallar-system/services/group-state-service.ts
packages/shared-server/rallar-system/services/group-state-mutations.ts
```

### 2.2 Exact current test and example tree used for characterization

```text
packages/tests/shared-web/
  api-workflows.test.ts                       # public workflow/API behavior; 1,925 lines
  authoritative-group-fixtures.ts
  rallar-auth-session-compat.test.ts          # api-workflows module-path mock
  rallar-calls-compat.test.ts                 # api-workflows module-path mock
  rallar-director-relay-compat.test.ts        # api-workflows module-path mock
  rallar-facade-defaults.test.ts              # api-workflows module-path mock
  rallar-media-sources-compat.test.ts         # api-workflows module-path mock
  rallar-message-send-compat.test.ts          # api-workflows module-path mock
  rallar-realtime-send-listen-compat.test.ts  # api-workflows module-path mock
  rallar-room-realtime-channel.test.ts        # 361 lines
  rallar-rooms-facade.test.ts                 # 225 lines
  rallar-rooms-people-events.test.ts           # mixed event coverage; 1,053 lines
  rallar-rooms-people-state.test.ts            # mixed state coverage; 148 lines
  rallar-rtc-recovery-compat.test.ts           # api-workflows module-path mock
  rallar-rtc-wait-compat.test.ts               # api-workflows module-path mock
  rallar-startup-lifecycle.test.ts             # api-workflows module-path mock
  rallar-targeted-channel-compat.test.ts       # api-workflows module-path mock
  rallar-workflow-options-compat.test.ts       # facade/workflow compatibility; 1,590 lines
  rallar-ws-lifecycle-compat.test.ts           # api-workflows module-path mock
  shared-web-app-import-boundaries.test.ts     # 101 lines
  shared-web-browser-bundle-boundaries.test.ts # 156 lines
  shared-web-browser-entrypoints.test.ts       # 356 lines
  shared-web-public-api-snapshots.test.ts      # 780 lines

examples/
  browser-startup-room/README.md
  room-crdt-document/README.md
  room-message-channel/README.md
  room-realtime-channel/README.md
```

The broad compatibility tests remain in place when their stable public import
path remains the subject. Room-owned direct tests move into
`packages/tests/shared-web/rooms/`. Mixed room/people tests are split without
dropping or rewriting any people assertion.

### 2.3 Current public surfaces and known consumers

`packages/shared-web/browser/rallar-rooms-facade.ts` is a tested public deep
entrypoint. Its exact direct repository consumers are:

```text
packages/shared-web/browser/rallar-connection-facade.ts
packages/shared-web/browser/rallar-core.ts
packages/shared-web/browser/rallar-facade-contract.ts
packages/shared-web/browser/rallar-runtime/composition.ts
packages/shared-web/browser/rallar-runtime/contracts.ts
packages/shared-web/browser/rallar-runtime/director.ts
packages/shared-web/browser/rallar-runtime/rooms.ts
packages/shared-web/browser/rallar-runtime/startup.ts
packages/shared-web/browser/rallar-runtime/state-events.ts
packages/shared-web/browser/rallar-runtime/state-store.ts
packages/tests/shared-web/rallar-rooms-facade.test.ts
```

The public export chain is:

```text
rallar-rooms-facade.ts
  -> rallar-core.ts
      -> rallar-realtime.ts
  -> rallar-facade-contract.ts
      -> rallar.ts
          -> packages/shared-web/mod.ts
```

Application and package consumers use `rallar.rooms` through
`@shared-web/browser/rallar.ts`, including:

- `apps/ar-eye-hunter-v1/src/game/useRallarArena.ts` for refresh, state,
  create-and-switch, enter, and change subscriptions;
- `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts` for refresh, create,
  and enter;
- `apps/rallar-black-box/src/direct-rallar-operations.ts` and the three legacy
  controllers
  `legacy/diagnostics/rooms-clients/use-rooms-clients-controller.ts`,
  `legacy/diagnostics/rtc-realtime/use-rtc-realtime-controller.ts`, and
  `legacy/diagnostics/rtc/use-rtc-diagnostics-controller.ts` for create, join,
  leave, and current room;
- `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/director-controller.ts`
  and `runtime.ts` for distributed browser join, refresh, and leave;
- `packages/shared-web/game/authority-client.ts`, `match-support.ts`, and
  `match.ts` for room state, presence, and room-scoped authority/realtime
  behavior.

`api-workflows.ts` also exposes current group workflow names from
`packages/shared-web/mod.ts`. Repository code imports the module from heartbeat,
middleware, director, people, rooms, and `api-workflows.test.ts`; many shared-web
compatibility tests mock that exact module path. External deep-import consumers
cannot be enumerated from this repository, so current export names and the old
module path are compatibility constraints.

### 2.4 Current warning and size baseline

The planning scan

```bash
node scripts/repo-style-check.mjs \
  --root packages/shared-web/browser \
  --layout-only \
  --layout-details
```

exits `0` with 15 warning-only layout findings. Its exact summary is:

```text
layout.browser-room-boundary=2
layout.directory-density=2
layout.feature-prefix-cluster=1
layout.filename-style=0
layout.generic-filename=2
layout.generic-route-init=0
layout.primary-export-name=8
layout.server-group-state-vocabulary=0
layout.unapproved-mod=0
```

The two room-boundary findings are exactly:

- `packages/shared-web/browser/rallar-rooms-facade.ts`, for direct authoritative
  imports including `GroupSnapshot`, `GroupEvent`, state-event types, and
  request types;
- `packages/shared-web/browser/rallar-runtime/rooms.ts`, for direct
  `GroupRole`, `GroupSnapshot`, and `UpdateGroupRequest` imports.

Active hard-tier production files are `rooms.ts`, `api-workflows.ts`, and
`state-events.ts`. The structure pass splits each at the room ownership
boundary. `rallar-rooms-facade.ts` and `state-store.ts` cross the 400-line
review threshold and are also split. Mechanical import-only edits to the
761-line `director.ts` do not authorize unrelated extraction or formatting.

Before each implementation PR freezes, record final physical lines and inspect
every changed general function at 40/50/60 lines. Every new production and
test file must be at most 400 lines. No hard-tier exception is approved by this
plan.

## 3. Representative Dataflow And Call Trace

### 3.1 Current create trace

The representative current trace is:

```text
application consumer
  rallar.rooms.create(input)
    packages/shared-web/browser/rallar-rooms-facade.ts
      createRallarRoomsFacade(...).create
        packages/shared-web/browser/rallar-runtime/rooms.ts
          BrowserRallarRoomsController.create
            normalize string/RallarCreateRoomInput
            connect + requireSession + resolve scope/policies
            packages/shared-web/browser/api-workflows.ts
              createAndJoinStateGroup
                generate groupId and stable workflow request IDs
                construct CreateGroupRequest inline
                packages/shared-web/browser/api-integration.ts
                  createStateGroup
                    executeHttpRequest
                      POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups
                connectStateGroupPresenceSessionWithMembershipRepair
            setCurrentRoom + acceptSnapshots
            return GroupSnapshot
```

The unchanged authoritative continuation is:

```text
apps/api-v1/src/routes/group-state-routes.ts
  init POST /groups handler
    readRequestWithRequestId<CreateGroupRequest>
    validatedGroupMutationRequest('createGroup', ...)
    processGroupAppInbox(AppInboxType.GROUP_CREATE)
      defaultProcessGroupAppInbox
        AppGroupInboxService.processAuthenticatedEntryUntilCompletion
          GroupStateService.prepareMutation
          AppGroupInboxService.processMutation
            GroupStateService.read
            GroupStateService.compute
            GroupStateService.validate
            AppGroupInboxService.commitMutation
              GroupStateService.write(transaction, computed)
```

### 3.2 Target create trace

After this child, the browser trace must be:

```text
application consumer
  RallarRoomsFacade.create(input)
    rooms/rallar-rooms-facade.ts
      rooms/browser-rallar-rooms.ts
        createAndJoinRoom
          rooms/create-and-join-room.ts
            connect + require session + resolve scope/policies
            createAndJoinStateGroup
              rooms/room-group-state-workflows.ts
                generate groupId and stable workflow request IDs once
                toCreateGroupStateRequest
                  rooms/room-group-state-translation.ts
                api-integration.createStateGroup
                existing presence-repair sequence
            room-state-store.setCurrentRoom + acceptSnapshots
            return the same GroupSnapshot
```

The API-v1 and shared-server continuation remains byte-for-byte outside this
child. A reviewer must be able to follow this trace by matching the function
and filename at every browser-owned step.

## 4. Existing API Calls Preserved By The Move

| Facade behavior              | Existing workflow/API call                                                | Existing transport behavior                         |
| ---------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| `refresh`                    | `refreshStateSnapshots` -> `listStateClients` + `listStateGroups`         | parallel GET reads                                  |
| `create` / `createAndSwitch` | `createAndJoinStateGroup` -> `createStateGroup`, then presence connection | POST group, then membership/presence sequence       |
| `join` / `enter`             | `joinStateGroup`, then presence connection                                | POST join, then membership-repair/presence sequence |
| `leave`                      | `leaveStateGroup` -> disconnect presence, then member status `left`       | ordered disconnect/upsert sequence                  |
| `update`                     | `updateStateGroupDetails` -> `updateStateGroup`                           | PUT group                                           |
| `archive` / `delete`         | `archiveStateGroup` / `deleteStateGroup` -> `updateStateGroup`            | PUT status with current reason handling             |
| `invite` / `acceptInvite`    | invite APIs, with current accept-plus-presence sequence                   | existing POST paths                                 |
| member governance            | remove/ban/unban/role/ownership APIs                                      | existing POST/PUT paths                             |
| `updateMetadata`             | read current snapshot, merge patch, then `updateStateGroup`               | existing read-then-PUT sequence                     |
| event list/replay            | group event list/page API calls                                           | existing GET/query/cursor behavior                  |

The plan does not rename these public authoritative workflow functions or low-
level API functions. New room-named internal use cases call them through the
named translation boundary.

## 5. Exact Target Trees And Responsibilities

### 5.1 Target production tree

```text
packages/shared-web/
  mod.ts                                      # same public names
  browser/
    api-integration.ts                        # unchanged HTTP adapter
    api-workflows.ts                          # non-room workflows + compatibility re-exports
    state-workflow-support.ts                 # shared result/not-found/request-ID functions
    rallar-connection-facade.ts               # direct import from rooms/
    rallar-core.ts                            # same exports, new owning import
    rallar-facade-contract.ts                 # same public aggregate contract
    rallar-rooms-facade.ts                    # approved one-hop compatibility re-export only
    rallar.ts                                 # unchanged public facade
    rallar-runtime-context.ts                 # unchanged current-room memory
    rooms/
      browser-rallar-rooms.ts                 # createBrowserRallarRooms; obvious feature entry
      create-and-join-room.ts                 # createAndJoinRoom and create-and-switch
      join-room.ts                            # joinRoom and enterRoom
      leave-room.ts                           # leaveRoom
      rallar-room-contracts.ts                # intentionally shared public room inputs/views
      rallar-rooms-facade.ts                  # RallarRoomsFacade + createRallarRoomsFacade
      room-events.ts                          # createRoomEvents; room list/replay/subscriptions
      room-group-state-mutation-workflows.ts  # existing update/lifecycle/metadata workflow bodies
      room-group-state-translation.ts         # the only room/group-state translation boundary
      room-group-state-workflows.ts           # existing create/join/leave/presence workflow bodies
      room-membership-group-state-workflows.ts # existing invite/member workflow bodies
      room-membership.ts                      # room member/invite facade operations
      room-presence.ts                        # waitForRoomPresence
      room-session.ts                         # createRoomSession
      room-state-store.ts                     # createRoomStateStore; room view/listeners
      room-target.ts                          # toRoomTarget and input validation
      update-room.ts                          # updateRoom, lifecycle, and metadata operations
    rallar-runtime/
      composition.ts                          # wires rooms entry and retained shared infrastructure
      contracts.ts                            # narrower room/state/event ports
      director.ts                             # mechanical owning-import update only
      startup.ts                              # mechanical owning-import update only
      state-events.ts                         # retained shared inbox + people events, under 400 lines
      state-store.ts                          # retained cache + people state, under 400 lines
      rooms.ts                                # removed; no compatibility shim
```

Every target basename names its primary symbol or cohesive capability. Files
with several related public room contracts or operations intentionally contain
multiple candidates and do not claim one arbitrary primary export.

The exact internal entry and ownership contracts are:

```ts
interface CreateBrowserRallarRoomsInput {
    readonly stateStore: RallarRoomStateStorePort;
    readonly roomEvents: RallarRoomEventsPort;
    readonly messages: RallarMessagesFacade;
    readonly realtime: RallarRealtimeFacade;
    readonly connect: (options?: RallarOperationOptions) => Promise<ApiMiddleware>;
    readonly requireSession: () => AuthSession;
    readonly resolveOperationOptions: <T extends RallarOperationOptions>(
        options: T
    ) => T & RallarOperationOptions;
    readonly resolveOperationScope: (scope?: StateScope) => StateScope | undefined;
    readonly resolveDefaultRoom: () => string | GroupRef | undefined;
    readonly resolveDefaultRoomRef: () => GroupRef | undefined;
    readonly runAuthAwareOperation: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly acceptSnapshots: (
        context: ApiMiddleware,
        clients: readonly ClientSnapshot[],
        groups: readonly GroupSnapshot[],
        scope?: StateScope
    ) => Promise<void>;
}

function createBrowserRallarRooms(
    input: CreateBrowserRallarRoomsInput
): CreateRallarRoomsFacadeOptions;

interface RallarRoomStateStorePort {
    state(): RallarRoomState;
    emit(state: RallarRoomState): void;
    onChange(
        listener: RallarStateListener<RallarRoomState>,
        options?: RallarOnChangeOptions
    ): RallarUnsubscribe;
    onCacheChange(listener: () => void | Promise<void>): RallarUnsubscribe;
    resolveCurrentRoomRef(): GroupRef | undefined;
    readGroupSnapshots(): GroupSnapshot[];
    findGroupSnapshot(room: string | GroupRef | undefined): GroupSnapshot | undefined;
    resolveRoomMinSnapshotVersion(
        room: string | GroupRef | undefined,
        explicitMinSnapshotVersion?: number
    ): number | undefined;
    setCurrentRoom(snapshot: GroupSnapshot): void;
    clearCurrentRoomIfMatches(room: string | GroupRef, clearCurrent: boolean): void;
    toRoomId(room: string | GroupRef | undefined): string | undefined;
    resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined;
    resolveGroupRefFromRoomId(roomId: string, scope?: StateScope): GroupRef | undefined;
}

interface RallarRoomEventsPort {
    list(input: RallarListRoomEventsInput): Promise<readonly GroupEvent[]>;
    listPage(input: RallarListRoomEventsInput): Promise<StateEventPage<GroupEvent>>;
    replay(
        input: RallarReplayRoomEventsInput,
        listener?: RallarRoomEventListener
    ): Promise<RallarReplayEventsResult<GroupEvent>>;
    onEvent(listener: RallarRoomEventListener, options: RallarRoomEventOptions): RallarUnsubscribe;
    dispatch(message: RallarMessage<GroupEvent>): Promise<void>;
}
```

These are internal capability contracts, not new public package exports. The
entry input names every existing dependency instead of accepting a generic
service bag. `RallarRoomStateStorePort` names one cohesive state owner: room
views and listeners, cache-change observation, current-room selection, snapshot
lookup/version resolution, current-room mutation, and room identity conversion.
It contains no unrelated service, transport, workflow, or public-facade
capability. `state-events.ts` retains the one WS inbox subscription and calls
only `RallarRoomEventsPort.dispatch` for group events. The room facade receives
the other four room-event operations directly.

The eight methods missing from the original plan inventory were `emit`,
`onCacheChange`, `resolveCurrentRoomId`, `resolveRoomMinSnapshotVersion`,
`isSameRoomRefOrId`, `toRoomId`, `resolveRoomRef`, and
`resolveGroupRefFromRoomId`. All eight existed on the predecessor
`rallar-runtime/state-store.ts` owner and were preserved through the structure
pass. Task 7's repo-wide current-consumer review then proved that
`resolveCurrentRoomId` and `isSameRoomRefOrId` had become unused private
pass-throughs, so the approved behavior-neutral alignment removes them. The
retained state store and lifecycle use `emit`; room presence uses
`onCacheChange`; messaging uses minimum-snapshot-version and room identity
resolution; RTC, director, and calls use room ID/reference resolution; and
composition uses the group-reference conversion for defaults and scoped
identity. The resulting thirteen-method contract changes no caller or behavior.

### 5.2 Target test tree

```text
packages/tests/shared-web/
  api-workflows.test.ts                       # retained public compatibility coverage
  rallar-auth-session-compat.test.ts          # retained module-path mock
  rallar-calls-compat.test.ts                 # retained module-path mock
  rallar-director-relay-compat.test.ts        # retained module-path mock
  rallar-facade-defaults.test.ts              # retained module-path mock
  rallar-media-sources-compat.test.ts         # retained module-path mock
  rallar-message-send-compat.test.ts          # retained module-path mock
  rallar-realtime-send-listen-compat.test.ts  # retained module-path mock
  rallar-rtc-recovery-compat.test.ts           # retained module-path mock
  rallar-rtc-wait-compat.test.ts               # retained module-path mock
  rallar-startup-lifecycle.test.ts             # retained module-path mock
  rallar-targeted-channel-compat.test.ts       # retained module-path mock
  rallar-workflow-options-compat.test.ts       # retained old module-mock compatibility
  rallar-ws-lifecycle-compat.test.ts           # retained module-path mock
  shared-web-app-import-boundaries.test.ts
  shared-web-browser-bundle-boundaries.test.ts
  shared-web-browser-entrypoints.test.ts
  shared-web-public-api-snapshots.test.ts
  people/
    people-event-test-runtime.ts              # shared setup for preserved people event cases
    people-events-compat.test.ts              # every existing people event case preserved
    people-state-compat.test.ts               # every existing people state case preserved
  rooms/
    create-and-join-room.test.ts
    join-room.test.ts
    leave-room.test.ts
    rallar-room-realtime-channel.test.ts
    rallar-rooms-facade.test.ts
    room-code-standard.test.ts                # source ownership/name/size/parameter ratchet
    room-event-test-runtime.ts                # shared setup for room event cases
    room-events-list-and-page.test.ts
    room-events-replay.test.ts
    room-events-subscription.test.ts
    room-group-state-mutation-workflows.test.ts
    room-group-state-request-translation.test.ts
    room-group-state-translation.test.ts
    room-group-state-workflows.test.ts
    room-membership.test.ts
    room-membership-group-state-workflows.test.ts
    room-presence.test.ts
    room-session.test.ts
    room-state-store-current-room.test.ts
    room-state-store.test.ts
    room-target.test.ts
    room-workflow-compat.test.ts
    room-workflow-test-runtime.ts             # shared deterministic API/command setup
    update-room.test.ts
```

The split test files preserve every existing assertion from the mixed room/
people suites. The two exact feature-named test-runtime files own only repeated
setup; `room-workflow-test-runtime.ts` similarly owns deterministic workflow
API/command setup. `room-group-state-request-translation.test.ts` owns create,
update, join, raw JSON omission/order, lifecycle, metadata, invite/governance,
presence/leave, and their request-return compatibility; the retained
`room-group-state-translation.test.ts` owns summary/state projection, ordering,
current selection, members, snapshot identity, and facade/view compatibility.
`room-state-store-current-room.test.ts` owns current-room/member projection,
duplicate-principal revision selection, default-scope acceptance/rejection, and
cross-scope retained current-room behavior; the retained
`room-state-store.test.ts` owns initialization, scope filtering, active-room
ordering, and summaries. Assertion sequences remain in the behavior-named test
files. Each resulting test and test-runtime module remains at most 400 lines.

This human-authorized, test-only four-way split resolves the final review's sole
Important test-size finding without changing behavior, production ownership, or
foundation files.

### 5.3 Exact current-to-target map

| Current file                                                                                                                               | Target treatment                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser/rallar-rooms-facade.ts`                                                                                                           | Move contracts/factory to `rooms/rallar-room-contracts.ts` and `rooms/rallar-rooms-facade.ts`; replace old file with one-hop compatibility re-export.                                                                                                                           |
| `browser/rallar-runtime/rooms.ts`                                                                                                          | Remove after distributing existing methods among `browser-rallar-rooms.ts`, `create-and-join-room.ts`, `join-room.ts`, `leave-room.ts`, `room-membership.ts`, `room-presence.ts`, `room-session.ts`, `room-target.ts`, and `update-room.ts`; no old-path shim.                  |
| room sections of `browser/api-workflows.ts`                                                                                                | Move unchanged workflow bodies into `rooms/room-group-state-workflows.ts`, `rooms/room-group-state-mutation-workflows.ts`, and `rooms/room-membership-group-state-workflows.ts`; re-export their old public names from `api-workflows.ts`.                                      |
| private `requireWorkflowResult`, `tolerateNotFound`, `isNotFoundApiError`, and `toWorkflowRequestId` helpers in `browser/api-workflows.ts` | Move once into `browser/state-workflow-support.ts` as `requireStateWorkflowResult`, `tolerateStateWorkflowNotFound`, `isStateWorkflowNotFoundError`, and `toStateWorkflowRequestId`; both retained and moved workflows import this file directly, preventing a re-export cycle. |
| private `toSlug` in `browser/api-workflows.ts`                                                                                             | Move its exact algorithm into `room-group-state-translation.ts` as private `toRoomGroupStateSlug`; it is called only by `toCreateGroupStateRequest` and is not exported.                                                                                                        |
| room sections of `rallar-runtime/state-store.ts`                                                                                           | Move room state/listener/projection ownership into `rooms/room-state-store.ts`; leave cache acceptance and people state in the narrowed source file.                                                                                                                            |
| room sections of `rallar-runtime/state-events.ts`                                                                                          | Move room list/page/replay/filter/dedupe ownership into `rooms/room-events.ts`; keep one shared inbox lifecycle and people event behavior in the narrowed source file.                                                                                                          |
| `rallar-runtime/contracts.ts`                                                                                                              | Replace broad mixed room members with explicit room ports imported from the owning room modules; do not change runtime values.                                                                                                                                                  |
| `rallar-runtime/composition.ts`                                                                                                            | Wire `createBrowserRallarRooms`, room state, and room events; preserve construction and lifecycle order.                                                                                                                                                                        |
| facade import consumers                                                                                                                    | Update repository-owned internal imports to the new owning file; keep public export names unchanged.                                                                                                                                                                            |
| `rallar-rooms-facade.test.ts` and `rallar-room-realtime-channel.test.ts`                                                                   | Move to the mirrored `rooms/` test path.                                                                                                                                                                                                                                        |
| mixed room/people state and event tests                                                                                                    | Split into the exact `rooms/` and `people/` target files, preserving all cases and assertions.                                                                                                                                                                                  |
| `api-integration.ts`, apps, examples, API-v1, shared-server                                                                                | Verify only; no planned edits.                                                                                                                                                                                                                                                  |

Private `rooms.ts` helpers also have locked destinations:

- `toRallarRefreshOptions` and `isStateScope` move with refresh assembly to
  `browser-rallar-rooms.ts`;
- `isGroupRefInput` moves to `room-target.ts`;
- `toRoomSessionRealtimeDefaults` moves to `room-session.ts`;
- `uniquePeerIds` and `isTerminalReadinessWaitResult` move to
  `room-presence.ts`;
- `createRoomSwitchPartialFailureError` moves to
  `create-and-join-room.ts` and is called directly by `join-room.ts`;
- `toDefinedRecord` is removed only after every request-field omission is
  reproduced explicitly inside the translation functions and their literal
  fixtures are green.

### 5.4 Filename and primary-symbol contract

The following names are locked. A file shown with one primary symbol must keep
that exact symbol. A capability file intentionally has several directly
exported, related candidates and therefore must not gain an unrelated primary:

| Target file                                | Required primary symbol or cohesive exported capability                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `browser-rallar-rooms.ts`                  | `createBrowserRallarRooms`                                                                                       |
| `create-and-join-room.ts`                  | `createAndJoinRoom` plus its create-and-switch companion                                                         |
| `join-room.ts`                             | `joinRoom` and `enterRoom`                                                                                       |
| `leave-room.ts`                            | `leaveRoom`                                                                                                      |
| `rallar-room-contracts.ts`                 | the intentionally shared `RallarRoom*` facade/input/session contracts; no runtime export                         |
| `rallar-rooms-facade.ts`                   | `RallarRoomsFacade`, `CreateRallarRoomsFacadeOptions`, and `createRallarRoomsFacade`                             |
| `room-events.ts`                           | `createRoomEvents` and its explicit room event port                                                              |
| `room-group-state-mutation-workflows.ts`   | update, lifecycle, and metadata group-state workflows only                                                       |
| `room-group-state-translation.ts`          | the exact `to*GroupStateRequest`, `toRallarRoomSummary`, and `toRallarRoomState` boundary functions in Section 6 |
| `room-group-state-workflows.ts`            | create/join/leave/presence group-state workflows only                                                            |
| `room-membership-group-state-workflows.ts` | invite and member-governance group-state workflows only                                                          |
| `room-membership.ts`                       | room invite/member facade operations only                                                                        |
| `room-presence.ts`                         | `waitForRoomPresence` and its presence-wait lifecycle                                                            |
| `room-session.ts`                          | `createRoomSession` and its bound message/realtime defaults                                                      |
| `room-state-store.ts`                      | `createRoomStateStore` and its explicit room state port                                                          |
| `room-target.ts`                           | `toRoomTarget` and room target validation                                                                        |
| `update-room.ts`                           | `updateRoom` plus lifecycle and metadata facade operations                                                       |
| `state-workflow-support.ts`                | exactly the four renamed state workflow support functions in Section 5.3                                         |

Test basenames mirror the owned capability from Section 5.2. Renaming any
locked target file or primary symbol, or adding a fourth workflow bucket,
requires a material plan revision and new human approval.

## 6. Named Translation Boundary Contract

The one browser-to-authoritative boundary is exactly:

```text
packages/shared-web/browser/rooms/room-group-state-translation.ts
```

No other file under `packages/shared-web/browser/rooms/**` may directly import
an authoritative named contract covered by
`layout.browser-room-boundary`. `GroupRef` and `roomRef` retain their explicit
checker and protocol exemptions. The boundary module is pure, performs no I/O,
reads no environment/global state, calls no clock/random source, and remains at
most 400 physical lines.

### 6.1 Required inputs and functions

The boundary uses named, data-only inputs. Operation policies, scope, API
functions, commands, clocks, random sources, caches, and listeners are not
members of these inputs. The exact shared input vocabulary is:

The following request-carrying input amendment was authorized during Task 3
review. It preserves the original plan approval while making the higher-level
legacy compatibility rule explicit: the exact caller request is data at the
boundary, and its serialized field set and insertion order must survive the
move unchanged.

```ts
interface RoomGroupStateMutationActorInput {
    readonly actorPrincipalId: string;
    readonly actorSessionId: string;
    readonly requestId: string;
}

interface RoomGroupStateRequestInput<TRequest> extends RoomGroupStateMutationActorInput {
    readonly request: TRequest;
}

type RoomCreateGroupStateFields = Pick<
    RallarCreateRoomInput,
    | 'displayName'
    | 'description'
    | 'joinMode'
    | 'maxMembers'
    | 'maxSessionsPerMember'
    | 'metadata'
    | 'expiresAtEpochMs'
    | 'purgeAfterEpochMs'
>;

interface RoomJoinGroupStateFields {
    readonly inviteToken?: string;
    readonly joinCode?: string;
}

interface ToCreateGroupStateRequestInput extends RoomGroupStateMutationActorInput {
    readonly room: RoomCreateGroupStateFields;
    readonly groupId: string;
}

function toCreateGroupStateRequest(input: ToCreateGroupStateRequestInput): CreateGroupRequest;

interface ToUpdateGroupStateRequestInput extends RoomGroupStateMutationActorInput {
    readonly request: UpdateGroupRequest;
}

function toUpdateGroupStateRequest(input: ToUpdateGroupStateRequestInput): UpdateGroupRequest;

interface ToJoinGroupStateRequestInput extends RoomGroupStateMutationActorInput {
    readonly room: RoomJoinGroupStateFields;
}

function toJoinGroupStateRequest(input: ToJoinGroupStateRequestInput): JoinGroupRequest;

interface ToRoomLifecycleGroupStateRequestInput
    extends RoomGroupStateRequestInput<Omit<UpdateGroupRequest, 'status'>> {
    readonly status: 'archived' | 'deleted';
}

function toRoomLifecycleGroupStateRequest(
    input: ToRoomLifecycleGroupStateRequestInput
): UpdateGroupRequest;

interface ToRoomMetadataGroupStateRequestInput extends RoomGroupStateMutationActorInput {
    readonly currentMetadata: Readonly<Record<string, unknown>>;
    readonly patch: Readonly<Record<string, unknown>>;
}

function toRoomMetadataGroupStateRequest(
    input: ToRoomMetadataGroupStateRequestInput
): UpdateGroupRequest;

type ToCreateRoomInviteGroupStateRequestInput = RoomGroupStateRequestInput<
    CreateGroupInviteRequest
>;

function toCreateRoomInviteGroupStateRequest(
    input: ToCreateRoomInviteGroupStateRequestInput
): CreateGroupInviteRequest;

function toAcceptRoomInviteGroupStateRequest(
    input: RoomGroupStateMutationActorInput
): AcceptGroupInviteRequest;

type ToRemoveRoomMemberGroupStateRequestInput = RoomGroupStateRequestInput<
    RemoveGroupMemberRequest
>;

function toRemoveRoomMemberGroupStateRequest(
    input: ToRemoveRoomMemberGroupStateRequestInput
): RemoveGroupMemberRequest;

type ToBanRoomMemberGroupStateRequestInput = RoomGroupStateRequestInput<BanGroupMemberRequest>;

function toBanRoomMemberGroupStateRequest(
    input: ToBanRoomMemberGroupStateRequestInput
): BanGroupMemberRequest;

type ToUnbanRoomMemberGroupStateRequestInput = RoomGroupStateRequestInput<UnbanGroupMemberRequest>;

function toUnbanRoomMemberGroupStateRequest(
    input: ToUnbanRoomMemberGroupStateRequestInput
): UnbanGroupMemberRequest;

type ToSetRoomMemberRoleGroupStateRequestInput = RoomGroupStateRequestInput<
    SetGroupMemberRoleRequest
>;

function toSetRoomMemberRoleGroupStateRequest(
    input: ToSetRoomMemberRoleGroupStateRequestInput
): SetGroupMemberRoleRequest;

type ToTransferRoomOwnershipGroupStateRequestInput = RoomGroupStateRequestInput<
    TransferGroupOwnershipRequest
>;

function toTransferRoomOwnershipGroupStateRequest(
    input: ToTransferRoomOwnershipGroupStateRequestInput
): TransferGroupOwnershipRequest;

function toLeaveRoomMemberGroupStateRequest(
    input: RoomGroupStateMutationActorInput
): UpsertGroupMemberRequest;

interface ToConnectRoomPresenceGroupStateRequestInput extends RoomGroupStateMutationActorInput {
    readonly principalId: string;
    readonly generationId: string;
}

function toConnectRoomPresenceGroupStateRequest(
    input: ToConnectRoomPresenceGroupStateRequestInput
): ConnectGroupPresenceSessionRequest;

interface ToDisconnectRoomPresenceGroupStateRequestInput extends RoomGroupStateMutationActorInput {
    readonly principalId: string;
    readonly generationId: string;
}

function toDisconnectRoomPresenceGroupStateRequest(
    input: ToDisconnectRoomPresenceGroupStateRequestInput
): DisconnectGroupPresenceSessionRequest;

interface ToRallarRoomSummaryInput {
    readonly snapshot: GroupSnapshot;
    readonly currentRoomRef?: GroupRef;
    readonly sessionId?: string;
}

function toRallarRoomSummary(input: ToRallarRoomSummaryInput): RallarRoomSummary;

interface ToRallarRoomStateInput {
    readonly groupSnapshots: readonly GroupSnapshot[];
    readonly clientSnapshots: readonly ClientSnapshot[];
    readonly currentRoomRef?: GroupRef;
    readonly currentRoom?: GroupSnapshot;
    readonly sessionId?: string;
}

function toRallarRoomState(input: ToRallarRoomStateInput): RallarRoomState;
```

Each operation-specific function produces one existing authoritative request
contract. `toRallarRoomSummary` and `toRallarRoomState` are the only
authoritative-to-product projections; member projection remains private inside
the same module. `RallarCreateRoomInput`, `RallarUpdateRoomInput`,
`RallarRoomSummary`, and `RallarRoomState` remain public facade contracts, not
new aliases. No generic translator, callback, service bag, or exported union is
introduced.

The existing compatibility workflow types are aliases only to the exact
data-only shapes above: `CreateAndJoinStateGroupOptions` aliases
`Omit<RoomCreateGroupStateFields, 'displayName'>`, and
`JoinStateGroupIntent` aliases `RoomJoinGroupStateFields`. The public workflow
signatures do not change. Legacy positional wrappers and new room use cases
both call the same named-input implementation, so there is no second
compatibility-only request constructor.

The boundary type-exports exactly these existing authoritative names for use by
room-owned modules: `GroupEvent`, `GroupEventType`, `GroupJoinMode`,
`GroupMemberStatus`, `GroupRef`, `GroupRole`, `GroupSnapshot`, `GroupStatus`,
`StateEventCursor`, `StateEventPage`, `StateScope`, `AcceptGroupInviteRequest`,
`BanGroupMemberRequest`, `ConnectGroupPresenceSessionRequest`,
`CreateGroupInviteRequest`, `CreateGroupRequest`,
`DisconnectGroupPresenceSessionRequest`, `JoinGroupRequest`,
`RemoveGroupMemberRequest`, `SetGroupMemberRoleRequest`,
`TransferGroupOwnershipRequest`, `UnbanGroupMemberRequest`,
`UpdateGroupRequest`, and `UpsertGroupMemberRequest`. It must not rename them,
weaken required fields, or export a new product snapshot contract through
`rallar.ts`, `rallar-core.ts`, `rallar-realtime.ts`, or `mod.ts`.

`ClientSnapshot` remains a direct browser client-state type and is not in the
governance checker's authoritative group-state name set. `GroupRef` and
`roomRef` remain eligible for their exact protocol exemptions, but this child
uses the boundary type export where the surrounding room module already needs
other translated group-state types. Namespace and default imports from any of
the three authoritative checker modules are prohibited.

The type dependency is explicit: `rallar-room-contracts.ts` imports
authoritative compatibility names only as types from this boundary, while this
boundary imports the four existing `Rallar*` input/view names shown above only
with `import type` from `rallar-room-contracts.ts`. This is an erased
compile-time type cycle, not a runtime module cycle. The bundle-boundary test
must prove that neither emitted browser module imports the other at runtime.
Replacing it with a direct authoritative import, an untracked re-export, a
duplicate structural view type, or a third contract module is not approved.

### 6.2 Exact existing mapping rules to preserve

- Create trims an optional requested group ID before the boundary and otherwise
  generates it once with the current `crypto.randomUUID()` call.
- Every request ID remains generated once with
  `toStateWorkflowRequestId` (the moved private `toWorkflowRequestId`) using
  the same operation prefix and parts at the same workflow point. Captured IDs
  are passed into translation and are never regenerated by a retry.
- `toCreateGroupStateRequest` emits `groupId`, the current slug conversion,
  `displayName`, `kind: 'room'`, `joinMode: room.joinMode ?? 'invite-only'`,
  `metadata: room.metadata ?? {}`, every other listed optional create field,
  `createdByPrincipalId: actorPrincipalId`, both actor fields, and `requestId`.
- `toUpdateGroupStateRequest` emits only listed room update values that are not
  `undefined`, then both actor fields and `requestId`. It retains `false`, `0`,
  an empty string, an empty object, and any meaningful `null` already allowed
  by the current contract.
- `toJoinGroupStateRequest` emits `inviteToken` and `joinCode` only when
  currently supplied, plus both actor fields and the captured join request ID.
- `toRoomLifecycleGroupStateRequest` spreads the exact existing caller request
  (`Omit<UpdateGroupRequest, 'status'>`) first, adds the selected exact status
  at the same point as the legacy archive/delete wrapper, then applies the
  actor, session, and captured request-ID overrides. It preserves every valid
  update field, `traceId`, omission behavior, and legacy property-insertion
  order.
  `toRoomMetadataGroupStateRequest` shallow-merges `currentMetadata` then
  `patch`, and emits the merged metadata plus both actor fields and request ID.
- Create-invite and member-governance translators spread their exact existing
  operation-specific caller request first, preserving `traceId`, reason,
  operation fields, omission behavior, and caller insertion order, then apply
  the same actor, session, and captured request-ID overrides. Accept-invite
  emits only the actor fields and request ID.
- Presence connect emits `principalId`, `generationId`, actor fields, and the
  captured presence request ID. Leave disconnect and leave-member reproduce
  the exact legacy `JSON.stringify` property order, including fixed
  `reason: 'left-group'` before each request ID; leave-member also emits
  `status: 'left'` first.
- State scope and route target IDs remain workflow/API arguments. They are not
  inserted into a request body or hidden inside the translation boundary.
- Room view projection preserves active-group filtering, display-name ordering,
  current-room selection, member display ordering, current/joined flags,
  online session IDs, and the original `GroupSnapshot` on every public room
  summary/current-room property.
- The boundary validates or defaults nothing beyond behavior already present at
  the exact old call site. Moving a rule into the boundary must be proven by a
  before/after literal fixture.

### 6.3 Required literal and compatibility fixtures

Before moving implementation, tests capture:

1. minimal create output, including exact slug, `kind`, invite-only default,
   empty metadata, actor fields, and caller-supplied IDs;
2. fully populated create output with every optional property;
3. update omission behavior with valid nested `false` and `null` values plus
   other falsy values retained, without widening an authoritative type;
4. join with invite token, join code, actor, session, and request ID, plus a
   workflow assertion that scope is forwarded unchanged outside translation;
5. archive/delete with optional update fields and `traceId`, plus create-invite
   and every member-governance caller request with applicable `traceId`;
6. presence connect/disconnect and leave-member literals, stable request IDs,
   and exact raw property order;
7. room summary/state ordering, complete joined/current flags, multiple online
   sessions, members, and original snapshot identity for every projected room;
8. compile-time assertions that every `RallarRoomsFacade` return and public
   property remains assignable to its current authoritative type;
9. old positional workflow imports and new owning-path workflow imports produce
   byte-for-byte equivalent raw `JSON.stringify` request bodies, API calls, and
   return values for every moved workflow;
10. zero `layout.browser-room-boundary` findings outside the exact boundary.

## 7. Public Compatibility Decisions

### 7.1 `RallarRoomsFacade` return types are fixed

The master program already decided this migration preserves public facade
return-type compatibility. The exact locked surface is:

| Facade member                                                                                                                                                                                    | Exact retained return type                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `state`                                                                                                                                                                                          | `RallarRoomState`                               |
| `list`                                                                                                                                                                                           | `readonly RallarRoomSummary[]`                  |
| `refresh`                                                                                                                                                                                        | `Promise<RallarRoomState>`                      |
| `listEvents`                                                                                                                                                                                     | `Promise<readonly GroupEvent[]>`                |
| `listEventPage`                                                                                                                                                                                  | `Promise<StateEventPage<GroupEvent>>`           |
| `replayEvents`                                                                                                                                                                                   | `Promise<RallarReplayEventsResult<GroupEvent>>` |
| `create`, `createAndSwitch`, `join`, `update`, `archive`, `delete`, `invite`, `acceptInvite`, `removeMember`, `banMember`, `unbanMember`, `setMemberRole`, `transferOwnership`, `updateMetadata` | `Promise<GroupSnapshot>`                        |
| `enter`                                                                                                                                                                                          | `Promise<RallarRoomSession>`                    |
| `session`                                                                                                                                                                                        | `RallarRoomSession`                             |
| `leave`                                                                                                                                                                                          | `Promise<GroupSnapshot \| undefined>`           |
| `waitForPresence`                                                                                                                                                                                | `Promise<RallarRoomPresenceWaitResult>`         |
| `current`                                                                                                                                                                                        | `GroupSnapshot \| undefined`                    |
| `onChange`, `onEvent`                                                                                                                                                                            | `RallarUnsubscribe`                             |

`RallarRoomSummary.snapshot` remains `GroupSnapshot`; `RallarRoomState.currentRoom`
and `RallarRoomSession.snapshot()` remain `GroupSnapshot | undefined`.
`GroupRef`, `roomRef`, method overload shapes, defaults, optional inputs, and
the create-and-switch fallback remain unchanged. Public API snapshots must
have no added, removed, or renamed value/type exports.

Product-named public snapshot/view replacement is explicitly out of scope and
requires a separate breaking-release child plan.

### 7.2 Approved-by-plan temporary re-export inventory

Human approval of this exact plan approves only these two one-hop compatibility
structures; it does not approve any additional shim.

| Old compatibility surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | One-hop target                                                                                               | Known consumers                                                                                                                                                | Removal condition                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared-web/browser/rallar-rooms-facade.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                | `packages/shared-web/browser/rooms/rallar-rooms-facade.ts` plus type exports from `rallar-room-contracts.ts` | The 11 direct repository consumers in Section 2.3 at the start of the move; after internal migration, the compatibility test and unknown external deep imports | A separate breaking-release plan is approved after repository imports use the owning path, public entrypoint/bundle snapshots define the replacement, downstream consumers are inventoried, and removal impact is reviewed. |
| `createAndJoinStateGroup`, `updateStateGroupMetadata`, `updateStateGroupDetails`, `archiveStateGroup`, `deleteStateGroup`, `createStateGroupInvite`, `acceptStateGroupInvite`, `removeStateGroupMember`, `banStateGroupMember`, `unbanStateGroupMember`, `setStateGroupMemberRole`, `transferStateGroupOwnership`, `joinStateGroup`, `leaveStateGroup`, `StateGroupWorkflowValue`, `JoinStateGroupIntent`, and `CreateAndJoinStateGroupOptions` from `packages/shared-web/browser/api-workflows.ts` | The three exact room-owned workflow files in Section 5.1                                                     | `packages/shared-web/mod.ts`, `api-workflows.test.ts`, current room code, compatibility mocks, and unknown external deep imports                               | A separate breaking-release plan is approved after internal callers use room-owned modules, public mod exports and test mocks have an approved replacement, and downstream deep imports are inventoried.                    |

Both old surfaces remain a single hop. Do not create a re-export from old path
to an intermediate barrel to the owning file. `rallar-runtime/rooms.ts` is
private, has only `composition.ts` as a direct consumer, and receives no shim.

The old facade path uses explicit named re-exports, not `export *`. From
`rooms/rallar-room-contracts.ts` it type-exports exactly
`RallarRoomSummary`, `RallarRoomMember`, `RallarRoomState`,
`RallarRoomPresenceWaitOptions`, `RallarRoomPresenceWaitResult`,
`RallarCreateRoomInput`, `RallarRoomTargetInput`, `RallarUpdateRoomInput`,
`RallarRoomLifecycleOptions`, `RallarRoomInviteOptions`,
`RallarRoomGovernanceOptions`, `RallarJoinRoomOptions`,
`RallarJoinRoomInput`, `RallarRoomSwitchOperation`,
`RallarRoomSwitchPartialFailureError`, `RallarLeaveRoomOptions`,
`RallarRoomEventOptions`, `RallarListRoomEventsOptions`,
`RallarListRoomEventsInput`, `RallarReplayRoomEventsOptions`,
`RallarReplayRoomEventsInput`, `RallarRoomEventListener`,
`RallarRoomSessionRealtimeInput`, `RallarRoomSessionMessageDefinition`, and
`RallarRoomSession`. From `rooms/rallar-rooms-facade.ts` it type-exports
`RallarRoomsFacade` and `CreateRallarRoomsFacadeOptions` and value-exports
`createRallarRoomsFacade`. These are all 28 current exports; no new old-path
export is added.

The second row resolves to these exact one-hop targets:

- `room-group-state-workflows.ts`: `createAndJoinStateGroup`,
  `joinStateGroup`, `leaveStateGroup`, `StateGroupWorkflowValue`,
  `JoinStateGroupIntent`, and `CreateAndJoinStateGroupOptions`;
- `room-group-state-mutation-workflows.ts`: `updateStateGroupMetadata`,
  `updateStateGroupDetails`, `archiveStateGroup`, and `deleteStateGroup`;
- `room-membership-group-state-workflows.ts`: `createStateGroupInvite`,
  `acceptStateGroupInvite`, `removeStateGroupMember`, `banStateGroupMember`,
  `unbanStateGroupMember`, `setStateGroupMemberRole`, and
  `transferStateGroupOwnership`.

`api-workflows.ts` re-exports those names explicitly with separate value and
type export lists. It does not use a wildcard or route through another barrel.

Known direct users of those names are the current
`rallar-runtime/rooms.ts`, `api-workflows.test.ts`, the `mod.ts` star export,
and the public API snapshot. These 14 compatibility tests mock the exact
`api-workflows.ts` module path and therefore remain path consumers even when
their selected runtime operation is not a moved room workflow:

```text
packages/tests/shared-web/rallar-auth-session-compat.test.ts
packages/tests/shared-web/rallar-calls-compat.test.ts
packages/tests/shared-web/rallar-director-relay-compat.test.ts
packages/tests/shared-web/rallar-facade-defaults.test.ts
packages/tests/shared-web/rallar-media-sources-compat.test.ts
packages/tests/shared-web/rallar-message-send-compat.test.ts
packages/tests/shared-web/rallar-realtime-send-listen-compat.test.ts
packages/tests/shared-web/rallar-rooms-people-events.test.ts
packages/tests/shared-web/rallar-rtc-recovery-compat.test.ts
packages/tests/shared-web/rallar-rtc-wait-compat.test.ts
packages/tests/shared-web/rallar-startup-lifecycle.test.ts
packages/tests/shared-web/rallar-targeted-channel-compat.test.ts
packages/tests/shared-web/rallar-workflow-options-compat.test.ts
packages/tests/shared-web/rallar-ws-lifecycle-compat.test.ts
```

Director, people, heartbeat, and middleware import the same module but use
retained non-room exports; their regression tests prove narrowing the file did
not change the module object. Unknown external deep imports are the reason the
one-hop exports cannot be removed in this child.

**Protected compatibility review evidence:** the already-present exact
five-line room workflow mocks in `rallar-auth-session-compat.test.ts` and
`rallar-director-relay-compat.test.ts`, plus the exact 23-line three-owning-
workflow-module mocks in `rallar-workflow-options-compat.test.ts`, are
necessary module-path wiring after approved internal import moves. They do not
authorize any other protected-suite edit, cleanup, formatting, assertion
change, restructuring, or mock growth; their old `api-workflows.ts` mocks and
all existing assertion bodies/sites remain preserved.

## 8. Structural Movement Versus Behavior Changes

### 8.1 Structure-and-boundary pass: permitted

- add characterization and public-surface tests before a move;
- move facade contracts/factory and update direct internal imports;
- split room controller, state, events, and group workflow bodies along the
  target ownership map;
- create the one named pure translation boundary and move existing request/view
  mapping into it without changing a literal;
- split/move direct tests into the mirrored tree;
- add exactly the two approved one-hop compatibility structures;
- rename private primary symbols to match target filenames;
- update composition and explicit ports without changing construction order;
- use Git rename detection and compare before/after behavior fixtures.

The structure PR establishes the final request/view translation module; it does
not add an empty architecture stub. Existing mapping logic moves into that
boundary only after literal characterization is green and remains behaviorally
identical.

### 8.2 Code-standard alignment pass: permitted

- retain and rerun the literal boundary fixtures from the structure pass;
- replace newly moved plain-object `type` declarations with `interface` where
  alias behavior is not required;
- replace newly owned functions with more than three positional parameters by
  named input interfaces while keeping legacy public wrappers compatible;
- reduce new/moved files and functions at coherent responsibility boundaries;
- remove wrapper-only private hops created by the old controller chain.

### 8.3 Behavior changes: none are approved

Both implementation PRs are structural. The second applies the already-published
code standard only to newly owned code; it is not a semantic pass. The
following changes are prohibited without a revised plan and new human
approval:

- any public return, export, import-path removal, or request/response contract
  change;
- any new public room snapshot contract;
- default, validation, scope, authorization, request-ID, UUID, clock, retry,
  operation-order, caching, event, timeout, or error behavior changes;
- replacement of expected exceptions with `Either` or any failure-flow change;
- API URL/method/body changes, OpenAPI edits, AppInbox/server edits, persisted
  data changes, or performance redesign;
- cleanup of unrelated browser, people, director, realtime, RTC, messages, app,
  or test debt.

If code-standard alignment would require one of these semantic changes, stop
the alignment pass and request a plan revision. This child intentionally
contains no approved production behavior change.

## 9. Implementation Tasks

### Task 0: Reconstruct Approval And Create The Structure Branch

**Files:** No content changes before approval reconstruction.

- [x] **Step 1: Verify exact approval and repository state**

  Read `AGENTS.md`, all three linked program plans, this child plan, the current
  PR/handoff evidence, and Git status. Verify that the human approved the exact
  child-plan Git blob recorded in the approval prompt. Do not infer approval
  from this draft or from the master program.

- [x] **Step 2: Create one child-specific goal**

  Create a goal for this browser child only. The goal covers both approved
  implementation PRs and the later completion handoff, not the server/API
  children.

- [x] **Step 3: Create and publish the structure branch**

  Start from then-current successful `origin/main`, not from this planning
  branch. Use exact branch
  `codex/rallar-room-group-state-boundary-structure`, push it immediately, and
  open a draft PR after the first meaningful commit. Do not commit or push the
  default branch.

### Task 1: Characterize The Current Browser Room Surface First

**Files:**

- Add missing characterization only in the bounded target room/people tests
  from Section 5.2, initially through current public paths.
- Treat `api-workflows.test.ts`, `rallar-workflow-options-compat.test.ts`,
  `shared-web-public-api-snapshots.test.ts`, and the 14 module-path consumers
  in Section 7.2 as unchanged regression evidence; do not grow these active
  over-400-line files.
- The already-present owning-path mocks are authorized only as necessary
  module-path wiring after internal imports moved to approved owners:
  `rallar-auth-session-compat.test.ts` and
  `rallar-director-relay-compat.test.ts` retain their exact five-line room
  workflow mocks, while `rallar-workflow-options-compat.test.ts` retains its
  exact 23-line mocks for the three owning workflow modules. This authorizes
  no further growth, assertion change, test restructuring, formatting, or
  hard-tier cleanup; preserve the old `api-workflows.ts` mocks and every
  assertion body and site.
- Put every new event/state literal directly in its already-planned bounded
  replacement test, initially through the current public facade; do not edit a
  mixed suite that Task 5 removes.
- Modify this plan and the two program progress ledgers only with evidence
  already known before the structure-tree freeze.

- [x] **Step 1: Record current layout and size evidence**

  Run the detailed browser layout command from Section 2.4, `wc -l` on every
  current source/test file in Sections 2.1-2.2, and a 40/50/60 manual review of
  changed functions. Store the exact baseline in the draft PR and plan task
  evidence.

- [x] **Step 2: Add missing characterization assertions**

  Add assertions for the exact facade return types, create/join/leave order,
  create-and-switch partial failure, state ordering/current selection, event
  list/replay/dedupe, presence timeout/abort, workflow options, and all current
  request literals only in bounded target tests. These behavior assertions
  must pass against the current implementation before movement. New owning-
  path and translation-boundary assertions are introduced red only in the task
  that immediately makes them green. Existing hard-tier compatibility and
  snapshot tests remain byte-for-byte unchanged; only the mixed event suite is
  later replaced by the exact bounded target files.

- [x] **Step 3: Run the focused baseline**

  ```bash
  npx vitest run packages/tests/shared-web/rooms
  npx vitest run \
    packages/tests/shared-web/rallar-rooms-facade.test.ts \
    packages/tests/shared-web/rallar-rooms-people-state.test.ts \
    packages/tests/shared-web/rallar-rooms-people-events.test.ts \
    packages/tests/shared-web/rallar-room-realtime-channel.test.ts \
    packages/tests/shared-web/rallar-workflow-options-compat.test.ts \
    packages/tests/shared-web/api-workflows.test.ts \
    packages/tests/shared-web/shared-web-browser-entrypoints.test.ts \
    packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
  ```

  Expected: all current behavior is green. A failing current-behavior assertion
  is a blocker, not a baseline to carry forward.

- [x] **Step 4: Commit the characterization milestone**

  Suggested commit:

  ```text
  test: characterize browser room compatibility
  ```

### Task 2: Move The Facade Behind The Approved Compatibility Path

**Files:**

- Create: `packages/shared-web/browser/rooms/rallar-room-contracts.ts`
- Create: `packages/shared-web/browser/rooms/rallar-rooms-facade.ts`
- Modify into shim: `packages/shared-web/browser/rallar-rooms-facade.ts`
- Modify owning imports and public boundary tests named in Sections 2.1-2.3.

- [x] **Step 1: Prove both paths before moving**

  Add a failing test that requires the new owning path to expose the same
  runtime factory and type surface while the old path remains callable. Put
  the assertion in the bounded facade/entrypoint tests; do not edit the
  780-line public snapshot.

- [x] **Step 2: Move without changing the public contract**

  Preserve every method, parameter, overload, default, and return type. Split
  contracts only to keep each file cohesive and at most 400 lines. Replace the
  old file with the exact one-hop compatibility re-export approved in Section
  7.2.

- [x] **Step 3: Update internal consumers to the owning path**

  Repository-owned production imports use `rooms/rallar-rooms-facade.ts` or
  `rooms/rallar-room-contracts.ts`. Only compatibility tests deliberately
  import the old path.

- [x] **Step 4: Run facade and public-surface tests**

  ```bash
  npx vitest run \
    packages/tests/shared-web/rallar-rooms-facade.test.ts \
    packages/tests/shared-web/shared-web-browser-entrypoints.test.ts \
    packages/tests/shared-web/shared-web-public-api-snapshots.test.ts \
    packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts \
    packages/tests/shared-web/shared-web-app-import-boundaries.test.ts
  ```

  Expected: both public paths work, and aggregate exports are identical.

### Task 3: Establish The Translation Boundary And Move Room Workflows

**Files:** Create `state-workflow-support.ts`, the three room-owned workflow
modules, `room-group-state-translation.ts`, and the five exact workflow/
boundary tests plus test runtime from Section 5.2; narrow `api-workflows.ts`.
Do not move the room controller, state store, or event implementation in this
task.

- [x] **Step 1: Characterize every moved workflow export first**

  Create `room-workflow-test-runtime.ts` for deterministic API/command setup;
  create the three production-mirrored workflow tests and the bounded
  `room-workflow-compat.test.ts` against the current `api-workflows.ts` path.
  Capture the exact function/type exports in Section 7.2, positional call
  signatures, generated request-ID prefixes, API call order, partial-failure
  behavior, parsed request bodies, and raw serialized request bodies. Prove
  every moved legacy and owning-path call against hand-written predecessor
  literals. Run the existing `api-workflows.test.ts` and
  `rallar-workflow-options-compat.test.ts` unchanged.

  Preserve the Task 1-authorized owning-path mock wiring in the three protected
  compatibility suites exactly as recorded there; it is required only because
  the internal imports now resolve through approved owners.

- [x] **Step 2: Add the boundary fixtures red**

  Create
  `packages/tests/shared-web/rooms/room-group-state-request-translation.test.ts`
  and retain `room-group-state-translation.test.ts` for projection fixtures in
  Section 6.3, then add the new owning-path import to
  `room-workflow-compat.test.ts`. Record failures caused only by the absent
  boundary/workflow modules; do not alter an expected literal to match new
  code.

- [x] **Step 3: Move shared support and workflow bodies without a cycle**

  Move the four shared private functions to `state-workflow-support.ts` exactly
  as mapped in Section 5.3. Move only the room-consumed public workflow bodies
  into the three exact room workflow files. Preserve every old public name and
  positional signature as a one-hop `api-workflows.ts` re-export; retained and
  moved workflows import support directly, never through `api-workflows.ts`.

- [x] **Step 4: Make the named boundary the only request-construction owner**

  Implement the exact operation-specific functions in Section 6. Generate
  UUIDs and request IDs at the same workflow point and pass the captured values
  into the pure boundary. Route every authoritative type used by a room-owned
  workflow through this module. Lifecycle, create-invite, and governance inputs
  carry the exact existing caller request as data so every field and raw
  property order survive before actor/session/request-ID overrides. Do not move
  I/O, command orchestration, retries, cache mutation, or listener state into
  the boundary.

- [x] **Step 5: Prove compatibility and the intermediate ratchet**

  ```bash
  npx vitest run \
    packages/tests/shared-web/rooms/room-group-state-workflows.test.ts \
    packages/tests/shared-web/rooms/room-group-state-mutation-workflows.test.ts \
    packages/tests/shared-web/rooms/room-membership-group-state-workflows.test.ts \
    packages/tests/shared-web/rooms/room-group-state-request-translation.test.ts \
    packages/tests/shared-web/rooms/room-group-state-translation.test.ts \
    packages/tests/shared-web/rooms/room-workflow-compat.test.ts \
    packages/tests/shared-web/api-workflows.test.ts \
    packages/tests/shared-web/rallar-workflow-options-compat.test.ts
  node scripts/repo-style-check.mjs \
    --root packages/shared-web/browser \
    --layout-only \
    --layout-details
  ```

  Expected: tests pass; checker exit is warning-only `0`; no new room workflow
  is a boundary finding; the sole remaining
  `layout.browser-room-boundary` finding is the not-yet-moved
  `rallar-runtime/rooms.ts` finding. No other detailed count increases.

### Task 4: Split Browser Room Operations Behind The Facade

**Files:** Create `browser-rallar-rooms.ts` and all room operation modules in
Section 5.1; remove `rallar-runtime/rooms.ts`; update composition, contracts,
and the exact operation tests in Section 5.2. Do not split the mixed state or
event implementations in this task.

- [x] **Step 1: Mirror operation tests before moving bodies**

  Move each existing facade/controller behavior case to its exact operation
  test path, preserving its literal expectations and assertion sites. Add red
  owning-path tests for `createBrowserRallarRooms` and each operation primary
  symbol; prove the red results are missing-module/name failures only.

- [x] **Step 2: Move one operation responsibility per target file**

  Move the current create/switch, join/enter, leave, membership, session,
  target, presence, and update/lifecycle/metadata bodies to the exact files in
  Section 5.1. Preserve evaluation order, defaults, validation paths, error
  objects, current-room mutation, snapshot acceptance, and partial-failure
  behavior. Room operations call the room-owned workflows from Task 3.

- [x] **Step 3: Replace the controller forwarding chain**

  `createBrowserRallarRooms` becomes the obvious feature entry and returns the
  same `CreateRallarRoomsFacadeOptions`. It assembles the same operation object
  without the `RallarRoomsController.operations` forwarding object.
  `createRallarRoomsFacade` remains the public package-boundary wrapper.
  Composition order and every injected dependency remain unchanged.

- [x] **Step 4: Prove operation behavior and the final boundary count**

  ```bash
  npx vitest run packages/tests/shared-web/rooms
  npx vitest run \
    packages/tests/shared-web/api-workflows.test.ts \
    packages/tests/shared-web/rallar-workflow-options-compat.test.ts
  node scripts/repo-style-check.mjs \
    --root packages/shared-web/browser \
    --layout-only \
    --layout-details
  ```

  Expected: behavior is unchanged; warning-only checker exit is `0`;
  `layout.browser-room-boundary=0`; no unexplained detailed count increases.

- [x] **Step 5: Inspect rename and scope evidence**

  ```bash
  git diff --find-renames --summary
  git diff --check
  ```

  Expected: coherent moves/splits are visible and no app, API-v1,
  shared-server, dependency, GitHub Actions workflow-definition, or unrelated
  plan edit exists.

### Task 5: Separate Room State And Events From Mixed Runtime Files

**Files:**

- Create: `rooms/room-state-store.ts`, `rooms/room-events.ts`
- Modify: `rallar-runtime/state-store.ts`, `state-events.ts`, `contracts.ts`,
  and `composition.ts`
- Split mixed tests into the exact room/people test tree in Section 5.2.

The independent Task 5 fix review requires this exact private composition tree:

```text
rallar-runtime/
  composition.ts
  composition/
    browser-runtime-composition.ts
    browser-communication-composition.ts
    browser-product-composition.ts
    browser-lifecycle-composition.ts
    browser-session-composition.ts
    browser-facade-assembly.ts
```

`composition.ts` keeps `createBrowserRallarFacade` as the directly readable
root. `browser-runtime-composition.ts` owns, in order,
`createBrowserRuntimeFoundation`, `createBrowserStateComposition`, and
`createBrowserStateEventComposition`: the runtime ports and lifecycle object,
the room plus retained cache state owners, then the room plus retained state
event owners and single WebSocket inbox. `browser-communication-composition.ts`
owns `createBrowserMessagingComposition` followed by
`createBrowserRealtimeComposition`, preserving messages, WebSocket status,
RTC, realtime, and media construction order.

`browser-product-composition.ts` owns
`createBrowserRoomPeopleStatsComposition` followed by
`createBrowserCallsDirectorComposition`, including the existing after-state-
emit director callback. `browser-lifecycle-composition.ts` owns
`registerBrowserStateLifecycle` for orders 10 through 20 followed by
`registerBrowserTransportLifecycle` for orders 30 through 90.
`browser-session-composition.ts` owns `createBrowserSessionComposition` and
preserves data, session, connection/auth, startup, and CRDT construction order.
`browser-facade-assembly.ts` owns `createBrowserFacadeAssembly`, including
channels and the single public facade object.

The root calls those phases in this exact order: runtime foundation; state;
state events; messaging; realtime/media; rooms/people/stats; calls/director;
state lifecycle; transport lifecycle; data/session/connection/auth/startup/
CRDT; channels/public facade. Inputs and multi-value results use precise named
interfaces. Every phase function remains at most 60 physical lines and every
composition file remains at most 400. The split adds no public package export,
barrel, generic dependency bag, hidden default, runtime cycle, duplicated
state, callback, or lifecycle and does not change any injected object,
late-bound callback point, construction order, or lifecycle position.

- [x] **Step 1: Preserve every mixed-suite assertion**

  Inventory test names and assertion counts before splitting. After the split,
  prove that each old room and people behavior case has one corresponding new
  case; do not silently delete a duplicate-looking assertion. Add the new room
  owning-path imports and record missing-module failures for
  `createRoomStateStore` and `createRoomEvents` before extracting either
  implementation. People compatibility cases remain green during that red
  step.

- [x] **Step 2: Extract room state ownership**

  Move active-group filtering, room summaries, current-room resolution,
  membership projection, room listeners, and room lookup behavior as one
  responsibility. Keep cache acceptance and people state in the retained
  runtime store. Preserve one cache-change emission sequence. Resolve the
  current snapshot independently from the default-scope room list and pass it
  as the locked optional `currentRoom: GroupSnapshot | undefined` data carrier
  through `room-group-state-translation.ts`; the boundary remains the sole
  current-room and member projection owner.

  Preserve all fifteen `RallarRoomStateStorePort` capabilities authorized by
  the pre-Task 6 amendment. In addition to the original seven-method plan
  inventory, retain the predecessor's `emit`, `onCacheChange`,
  `resolveCurrentRoomId`, `resolveRoomMinSnapshotVersion`,
  `isSameRoomRefOrId`, `toRoomId`, `resolveRoomRef`, and
  `resolveGroupRefFromRoomId` methods for the current retained runtime,
  composition, messaging, RTC, room-presence, identity, and cache-emission
  consumers. This is ownership relocation, not a new behavior or public
  capability.

  Task 7 later reviews the two private pass-throughs
  `resolveCurrentRoomId` and `isSameRoomRefOrId` against current consumers. Its
  explicitly approved behavior-neutral alignment may remove them only after a
  repo-wide usage ratchet proves that no consumer remains; the final internal
  owner is then the thirteen-method contract in Section 5.1.

- [x] **Step 3: Extract room event ownership**

  Move room list/page/replay/subscription matching and group-event dedupe as one
  responsibility. Preserve the existing single WS inbox registration lifecycle,
  subscription order, dedupe limit, replay page limits, and people behavior.

- [x] **Step 4: Run the split focused suites**

  ```bash
  npx vitest run \
    packages/tests/shared-web/rooms/room-state-store.test.ts \
    packages/tests/shared-web/rooms/room-state-store-current-room.test.ts \
    packages/tests/shared-web/rooms/room-events-list-and-page.test.ts \
    packages/tests/shared-web/rooms/room-events-replay.test.ts \
    packages/tests/shared-web/rooms/room-events-subscription.test.ts \
    packages/tests/shared-web/people/people-state-compat.test.ts \
    packages/tests/shared-web/people/people-events-compat.test.ts
  ```

- [x] **Step 5: Record and enforce the fixed Task 5 headless bundle budget**

  The exact Task 5 base rebuild measured `190.406250 KiB`; the initial Task 5
  implementation measured `191.036133 KiB`; and the retained behavior-neutral
  `#private` optimization measured `190.901367 KiB`. For Task 5 only, require
  the headless entry to remain strictly below `192 KiB`. The accepted Task 5
  measurement therefore leaves approximately `1.099 KiB` of headroom. This is
  a fixed Task 5 budget exception: it permits no later increase and does not
  approve any broader toolchain or performance exception.

  ```bash
  npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts
  ```

**Pre-Task 6 internal-contract review evidence:** A fresh review of exact base
`9ab6f460239ca4bbe1d84019a99006549599e506` through feature head
`53fbb55a1e686c1eb92959a8acbc0368ebd14647` found no public, runtime,
compatibility, lifecycle, or state regression, but identified the stale
seven-method plan inventory as one Important structural-plan mismatch. Direct
predecessor and consumer inspection proved that the eight omitted methods are
the behavior-preserving capabilities recorded above. The human authorized only
this plan correction; the implementation and tests remain unchanged and must
receive a fresh scoped review before Task 6 resumes.

### Task 6: Freeze, Review, And Publish The Structure/Boundary PR

- [x] **Step 1: Run structure-focused validation**

  ```bash
  npx tsc -p packages/shared-web/tsconfig.json --noEmit
  npx vitest run packages/tests/shared-web/rooms packages/tests/shared-web/people
  npx vitest run packages/tests/shared-web
  npx vitest run \
    packages/tests/shared-web/api-workflows.test.ts \
    packages/tests/shared-web/rallar-workflow-options-compat.test.ts \
    packages/tests/shared-web/shared-web-browser-entrypoints.test.ts \
    packages/tests/shared-web/shared-web-public-api-snapshots.test.ts \
    packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts \
    packages/tests/shared-web/shared-web-app-import-boundaries.test.ts
  npm run check:repo-style
  npm run check:repo-style:layout
  npm run check:repo-style:layout-details
  npm run check:repo-style:output-contracts
  npm run check:repo-style:object-interfaces
  npm --workspace ar-eye-hunter-v1 run build
  npm --workspace relic-hunters-v1 test
  npm --workspace relic-hunters-v1 run build
  npm --workspace rallar-black-box run build
  npm --workspace @ar-eye-hunter/shared-test run build
  ```

- [x] **Step 2: Run the repository completion gates on the frozen tree**

  Format only in-scope files, run `git diff --check`, stage only the approved
  structure/boundary files, record `git write-tree`, and run without another
  in-scope edit:

  ```bash
  npm run test:unit
  npm run test:ci
  npm run build
  ```

- [x] **Step 3: Human Review Point A — structure/boundary merge**

  The human reviews the exact tree, literal boundary fixtures, the four-way
  request/projection and store/current-room test ownership split,
  `layout.browser-room-boundary=0`, public snapshots, both compatibility
  structures, app builds, rename evidence, size/function review, and absence
  of behavior changes. Only the human authorizes merge. Branch Release Gate
  must pass for the exact final structure/boundary SHA; after merge, **Run
  Hetzner Supported Distributed Manifests** must pass for the exact resulting
  `main` SHA.

- [x] **Step 4: Stop if structure publication is not complete**

  Do not create the alignment branch until the structure/boundary PR is merged
  and its exact default-branch workflow is green.

### Task 7: Create The Code-Standard Alignment Branch Test-First

- [x] **Step 1: Start from the exact successful structure merge SHA**

  Create and publish
  `codex/rallar-room-group-state-boundary-alignment` from that exact
  `origin/main`. Keep the same child-specific goal; open a separate draft PR
  after the first meaningful commit.

- [x] **Step 2: Write the scoped source-structure ratchet before alignment**

  Create `packages/tests/shared-web/rooms/room-code-standard.test.ts`. Using the
  existing source-analysis test support, assert the exact target file list,
  matching primary names, absence of direct authoritative imports outside the
  boundary, at most three positional parameters on newly owned functions, and
  at most 400 physical lines for each new/moved source and test module. Record
  the initial red assertions against remaining structure-pass code-standard
  debt. Ratchet every legacy positional compatibility exception by exact owning
  file, function name, parameter count, and single occurrence; do not weaken
  thresholds to obtain green.

- [x] **Step 3: Align only the newly owned room code**

  Apply `interface`/`type`, named input, file ordering, 100-column, and 40/50/60
  rules to new or materially rewritten room code. Keep legacy public positional
  workflow signatures in the approved compatibility re-export surface; their
  room-owned implementations receive named input records.

  Review the retained internal `resolveCurrentRoomId` and
  `isSameRoomRefOrId` pass-throughs. Remove them only when the source ratchet
  proves they are private and unused, without changing room identity behavior
  or the cohesive state-store ownership model.

  Keep the exact direct `extends RoomGroupStateMutationActorInput` heritage for
  both room-presence request inputs. Those two 103/106-character declarations
  are an explicit 100-column guidance tradeoff: do not add an alias hop or
  change the locked interface declarations solely to shorten them.

- [x] **Step 4: Verify the source ratchet and unchanged behavior**

  ```bash
  npx vitest run \
    packages/tests/shared-web/rooms/room-code-standard.test.ts \
    packages/tests/shared-web/rooms/room-group-state-translation.test.ts \
    packages/tests/shared-web/rooms/room-workflow-compat.test.ts \
    packages/tests/shared-web/api-workflows.test.ts \
    packages/tests/shared-web/rallar-workflow-options-compat.test.ts
  node scripts/repo-style-check.mjs \
    --root packages/shared-web/browser \
    --layout-only \
    --layout-details
  ```

  Expected: all source ratchets and behavior suites pass;
  `layout.browser-room-boundary=0`; no unexplained default or detailed layout
  count increases; every checker command remains warning-only and exits `0`.

- [x] **Step 5: Perform a scoped independent re-review**

  Review for hidden behavior changes, extra hops, mismatched names, direct
  authoritative imports, lost tests, over-threshold files/functions, and public
  surface drift. A material finding returns to the affected test-first step.

### Task 8: Freeze, Review, And Publish The Alignment PR

- [x] **Step 1: Run all focused and repository completion gates**

  On the final unchanged alignment tree, run Prettier on in-scope files,
  `git diff --check`, then this exact final focused set:

  ```bash
  npx tsc -p packages/shared-web/tsconfig.json --noEmit
  npx vitest run packages/tests/shared-web/rooms packages/tests/shared-web/people
  npx vitest run packages/tests/shared-web
  npx vitest run \
    packages/tests/shared-web/api-workflows.test.ts \
    packages/tests/shared-web/rallar-workflow-options-compat.test.ts \
    packages/tests/shared-web/shared-web-browser-entrypoints.test.ts \
    packages/tests/shared-web/shared-web-public-api-snapshots.test.ts \
    packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts \
    packages/tests/shared-web/shared-web-app-import-boundaries.test.ts
  node scripts/repo-style-check.mjs \
    --root packages/shared-web/browser \
    --layout-only \
    --layout-details
  npm run check:repo-style
  npm run check:repo-style:layout
  npm run check:repo-style:layout-details
  npm run check:repo-style:output-contracts
  npm run check:repo-style:object-interfaces
  npm --workspace ar-eye-hunter-v1 run build
  npm --workspace relic-hunters-v1 test
  npm --workspace relic-hunters-v1 run build
  npm --workspace rallar-black-box run build
  npm --workspace @ar-eye-hunter/shared-test run build
  ```

  Expected: all focused commands pass; the checker remains warning-only with
  `layout.browser-room-boundary=0` and no unexplained detailed-count increase.
  Then run the repository completion gates:

  ```bash
  npm run test:unit
  npm run test:ci
  npm run build
  ```

- [x] **Step 2: Freeze non-circular feature evidence**

  Stage only authorized files, record the exact `git write-tree`, commit the
  same tree, push non-forced, and require Branch Release Gate for that exact
  alignment SHA. Put future merge/default-workflow facts only in the PR and
  Mandatory Completion Handoff.

- [x] **Step 3: Human Review Point B — alignment merge**

  The human reviews the exact boundary module, every literal mapping test,
  public return compatibility, warning counts, target tree, call trace, size
  review, and all gates. Only the human authorizes merge.

- [x] **Step 4: Verify the resulting default branch**

  After human merge, resolve the exact resulting `main` SHA and require **Run
  Hetzner Supported Distributed Manifests** success for that exact SHA. The
  implementation reaches `complete` only when both the structure/boundary and
  alignment publication envelopes are green.

  Completion evidence: frozen tree `0061bce118c30759d9a71beb867692dc97c0bf84`;
  feature SHA `ec49e76b95160d2a2d0fb54b140963cd144f3dcd`; Branch Release Gate
  `30513466787` attempt 1 success; PR #54; resulting `main` SHA
  `d807b602ad0b400c5bfc10b8da955093df57f5ce`; and **Run Hetzner Supported
  Distributed Manifests** `30516918807` attempt 1 success for that exact SHA.

### Task 9: Publish The Later Evidence Ledger Separately

- [x] **Step 1: Start a separately authorized ledger task**

  Do not edit the frozen alignment tree. After the implementation is
  `complete`, obtain separate human authorization for a ledger branch based on
  the exact successful alignment merge SHA.

- [x] **Step 2: Record only already-known implementation evidence**

  Modify only this child plan, the master program, and the execution plan.
  Record both frozen implementation trees, final feature SHAs, Branch Release
  Gate runs, PRs, resulting main SHAs, and exact successful default-workflow
  runs. Mark implementation complete and ledger publication pending.

- [ ] **Step 3: Freeze and publish the ledger independently**

  Run focused governance tests and repository completion gates, record its own
  tree, commit, draft PR, branch gate, human merge, and default workflow in the
  external ledger publication envelope. Do not put the ledger's own future
  merge SHA or workflow result into the tree that produces them.

## 10. Validation Matrix

### Planning/governance changes only

```bash
npx prettier --check \
  plans/rallar-room-group-state-translation-boundary-plan.md \
  plans/repo-human-traceability-refactoring-program-plan.md \
  plans/repo-human-traceability-program-execution-plan.md
git diff --check
npx vitest run \
  packages/tests/repo/rallar-skill-integrity.test.ts \
  packages/tests/repo/repo-code-style-integrity.test.ts \
  packages/tests/repo/repo-style-layout-rules.test.ts \
  packages/tests/repo/repo-style-check.test.ts
```

These commands validate this draft. They do not validate or execute production
movement.

### Structure/boundary and alignment focused gates

Use the exact focused commands in Tasks 1-8. At minimum, final validation
includes all mirrored room tests, preserved people regressions, workflow
compatibility, public entrypoint/snapshot/bundle/import boundaries, shared-web
typecheck, all enumerated consumer builds/tests, every warning-only checker
mode, and all three repository completion gates.

Any in-scope edit after a successful gate invalidates that gate. A warning-only
checker exit `0` is feedback, not proof of human traceability.

## 11. Non-Circular Completion Evidence

This two-PR child extends the execution protocol without changing it:

1. **Structure/boundary feature tree and envelope.** Freeze the exact
   structure/boundary tree, run local gates without edits, commit/push the same
   tree, and record branch SHA/gate, human merge, resulting main SHA, and
   default workflow in the structure/boundary PR/handoff.
2. **Alignment feature tree and envelope.** Start only from the successful
   structure/boundary main SHA. Freeze and publish the alignment tree the same
   way. The alignment PR/handoff records its later external evidence.
3. **Implementation completion.** The child is `complete` only after both
   envelopes are green for their exact SHAs. A structure success cannot cover
   an alignment failure, and a later alignment success does not erase the
   structure/boundary evidence.
4. **Later ledger tree and envelope.** A separate authorized branch records the
   already-known evidence from both implementation PRs. Its own future tree,
   commit, merge, and workflow evidence remains in its PR/handoff. Once that
   envelope is green, the child becomes `ledger-published` and only then may
   the server child be drafted.

A content correction invalidates only the tree it changes. No plan file is
required to predict its own future SHA, merge, or workflow.

## 12. Exact Human Review Points

1. **Plan approval:** review this exact plan blob, target trees, compatibility
   hops, the erased boundary/contracts type edge, fixed public return decision,
   boundary mappings, prohibited behavior, task sizes, tests, and evidence
   contract. Approval starts no server/API work.
2. **Structure/boundary PR merge:** inspect rename/split evidence, both
   compatibility surfaces, literal boundary fixtures, preserved tests,
   unchanged public snapshots, absence of a runtime boundary/contracts cycle,
   consumer builds, final tree/SHA, and Branch Release Gate. Explicit merge
   approval is required.
3. **Between PRs:** verify the exact structure/boundary merge/default workflow
   before starting the already-approved alignment pass from it.
4. **Alignment PR merge:** inspect the source-structure ratchet, retained
   literal mapping fixtures, `layout.browser-room-boundary=0`, no hidden
   behavior changes, final tree/SHA, and Branch Release Gate. Explicit merge
   approval is required.
5. **Ledger publication:** separately authorize the three-plan evidence ledger
   only after the alignment default workflow passes.

## 13. Acceptance Checklist

- [x] The exact target room and mirrored test trees exist with no empty stubs.
- [x] `browser-rallar-rooms.ts` is the obvious browser room entry.
- [x] Every new/moved primary symbol matches its descriptive filename or the
      file clearly owns a cohesive multi-export capability.
- [x] The one translation boundary is exact and at most 400 lines.
- [x] Browser room modules have zero direct authoritative imports outside the
      named boundary, except established `GroupRef`/`roomRef` identities.
- [x] Every current facade method and public export remains present.
- [x] `RallarRoomsFacade` returns and properties retain exact current
      authoritative type compatibility.
- [x] Both approved one-hop compatibility structures are tested and no third
      shim exists.
- [x] Internal consumers use owning paths; apps/examples require no source edit.
- [x] Current API methods, URLs, requests, IDs, ordering, and server continuation
      remain unchanged.
- [x] Room state ordering/current/member behavior remains unchanged.
- [x] The exact thirteen-method internal `RallarRoomStateStorePort` remains one
      cohesive non-public room-state owner and contains no unrelated dependency
      or behavior.
- [x] Room event list/replay/subscription/dedupe behavior remains unchanged.
- [x] Presence and create/join/leave partial-failure behavior remains unchanged.
- [x] Every existing mixed-suite room and people case/assertion remains covered.
- [x] New/moved source and test files are at most 400 lines; changed functions
      pass 40/50/60 review; no hard-tier exception is introduced.
- [x] Focused, type, app, repository, branch, merge, and default-workflow gates
      are recorded for each exact implementation tree.
- [ ] Later ledger evidence is independently frozen and externally published.

## 14. Risks And Reserved Decisions

| Risk                                                                | Mitigation / human decision                                                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deep-import consumers are not enumerable                            | Preserve both old public paths with the explicit one-hop structures; removal requires a separate breaking-release plan.                                     |
| Splitting state/events could change subscription or emission order  | Characterize order/dedupe first; retain one shared inbox/cache lifecycle; no merge without literal regression evidence.                                     |
| Moving group workflows could regenerate IDs or reorder operations   | Generate all volatile values at the same existing point and pass them into pure translation; assert request literals and call order.                        |
| A product alias could look compatible while changing declarations   | Keep `GroupSnapshot`/`GroupEvent` names and add compile-time/public snapshot assertions; no new public room snapshot type.                                  |
| The boundary/contracts type edge could become a runtime cycle       | Permit only the documented erased `import type` cycle and assert emitted bundle edges; no runtime import may cross in both directions.                      |
| A stale internal-port inventory could hide predecessor capabilities | Record the structure pass's fifteen-method preservation, then keep the exact thirteen-method Task 7 contract and its consumer-usage ratchet in Section 5.1. |
| File-size pressure could create pass-through modules                | Use the exact ownership map and independent review; stop if the responsibilities do not fit cohesively.                                                     |
| Structure/boundary and alignment diffs could obscure each other     | Require two PRs and successful default publication between them.                                                                                            |
| Existing consumers could rely on untested behavior                  | Build both apps, black-box UI, and shared-test; run Relic tests plus public/bundle and repository gates for each frozen tree.                               |

No behavior choice is reserved for silent implementation judgment. A discovered
behavior change, additional compatibility path, target filename change,
boundary split, public contract change, or new hard-tier exception requires a
material plan revision and new explicit human approval.

## 15. Progress Record

| Milestone                       | Status                | Evidence                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Governance/checker prerequisite | `ledger-published`    | Implementation PR #47 and later ledger PR #51 evidence in the planning status above; exact ledger default workflow `30407710853` passed for `7a6c8e0c2cfb3413b4c0fbaaf0af31af2571c015`.                                                                                                                                         |
| Browser child inventory         | complete for drafting | Current source/tests/exports/consumers/examples/API calls and representative create-to-AppInbox trace recorded in Sections 2-4.                                                                                                                                                                                                 |
| Browser implementation          | complete              | Human approval binds exact plan blob `37861202ce25c3cd5832663a5a3f6d7e2e4a0e4e` plus only the explicitly recorded amendments; both implementation publication envelopes are complete.                                                                                                                                           |
| Internal state-store contract   | aligned               | The structure pass preserved fifteen predecessor capabilities; Task 7's consumer ratchet removes only two unused private pass-throughs and retains the exact thirteen-method owner.                                                                                                                                             |
| Human approval                  | complete              | Approval covers the two locked implementation PRs and the explicitly recorded narrow amendments; it does not approve later child plans.                                                                                                                                                                                         |
| Structure/boundary PR           | complete              | Frozen tree `a43c05ee5046a2a5fec6c7bc7223dfaec5868365`; feature `ca6c907c50d12a5d52a2b54ebf81e81cff2c4a54`; Branch Release Gate `30505292166` attempt 1 success; PR #53 merged as `a0baa7ed77c9759e9a3c2c3c3c5da4c5ca845960`; default run `30506826362` attempt 1 succeeded.                                                    |
| Alignment implementation PR     | complete              | Frozen tree `0061bce118c30759d9a71beb867692dc97c0bf84`; feature `ec49e76b95160d2a2d0fb54b140963cd144f3dcd`; Branch Release Gate `30513466787` attempt 1 success; PR #54 merged as `d807b602ad0b400c5bfc10b8da955093df57f5ce`; default run `30516918807` attempt 1 succeeded; final Brotli `191.817383 KiB` is below `<192 KiB`. |
| Later evidence ledger           | pending               | This separately authorized three-plan ledger records only already-known implementation evidence; its own tree and publication envelope remain external until Step 3 completes.                                                                                                                                                  |
| Server/API-v1 children          | blocked by sequence   | Must not begin under this plan.                                                                                                                                                                                                                                                                                                 |

## 16. Draft Self-Review Record

Self-review completed on 2026-07-29. The planning agent verified:

- no placeholder, TODO, invented file, stale current path, or inconsistent
  target name remains;
- every current public surface and known repository consumer is represented;
- both compatibility re-exports name consumers and removal conditions;
- the public facade return-type decision matches the master program;
- the boundary is singular, exact, pure, deterministic, and size-bounded;
- structure/boundary and code-standard alignment passes are independently
  reviewable;
- no runtime behavior, server/API work, production implementation, strict
  checker change, dependency change, or unrelated plan change is authorized;
- every production movement task has a red-before-green test step, and the
  freeze/publication tasks have exact focused commands, repository completion
  gates, publication gates, and human merge points;
- the two implementation trees and later ledger use non-circular evidence;
- the server and API-v1 children remain untouched and sequenced after this
  child reaches `ledger-published`.

The only deliberate design tradeoff is the documented erased type-only edge
between the translation boundary and public room contracts. It is visible in
the plan, has a bundle assertion, and is an exact human approval point. No
placeholder or implementation choice remains for that edge.
