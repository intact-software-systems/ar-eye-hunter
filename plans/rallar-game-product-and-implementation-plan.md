# Rallar Game Product And Implementation Plan

Date: 2026-06-08

Status: Implementation-ready V1 plan for a browser-side Rallar Game product
surface.

## Purpose

This plan defines a new browser-side `Rallar Game` layer under
`packages/shared-web/game`. Its purpose is to provide reusable match
orchestration for browser-hosted realtime applications such as Cash Chase Arena
while keeping single responsibility and separation of concerns.

`Rallar Game` composes the existing Rallar browser facade. It must not create
raw `WebSocket`, `RTCPeerConnection`, or DataChannel objects, and it must not
own simulation, rendering, scoring, movement, AI, or game rules.

The core product decision:

> Rallar Game should make browser-hosted realtime match coordination easy
> without becoming a game engine.

## Current Code And Docs Checked

Primary local references:

- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/middleware.ts`
- `packages/shared/services/WebRtcConnectionService.ts`
- `packages/shared-web/mod.ts`
- `packages/tests/shared-web/*.test.ts`
- `docs/rallar-api-reference.md`
- `docs/rallar-quickstart-and-recipes.md`
- `docs/rallar-ai-skill.md`
- `projects/cash-chase-arena/*`

Current repo facts this plan relies on:

- `rallar.rooms.state()` exposes the current room, room members, and active
  member session IDs.
- `rallar.director` already supports appointment, freshness, relay, heartbeat,
  snapshot, and sync request.
- `rallar.realtime` already supports JSON/binary lane send/listen and lane
  health.
- `rallar.rtc` already exposes lane readiness, status, lifecycle, diagnostics,
  restart, and reconnect.
- `rallar.start(...)` already accepts `dataChannelLanes`.
- `packages/shared-web` is a flat browser-facing package exported through
  `packages/shared-web/mod.ts`.
- Existing shared-web tests live under `packages/tests/shared-web` and run in
  normal Vitest without browser automation.

## Product Boundary

Rallar Game owns:

- game lane presets
- generic game envelopes
- host capability reporting
- deterministic host and backup election
- director lifecycle orchestration
- input, intent, snapshot, event, and sync routing
- basic recovery status
- diagnostics aggregation

Rallar Game does not own:

- auth UI
- room creation UI
- game simulation
- app payload validation
- movement, combat, scoring, missions, AI, or rendering
- server-authoritative gameplay
- full seamless host migration in V1

Rallar Game should be reusable by Cash Chase Arena and by similar applications
with a browser-hosted director, low-latency input/snapshot traffic, reliable
events, and recovery/sync needs.

## Package Layout

Add:

```text
packages/shared-web/game/types.ts
packages/shared-web/game/lanes.ts
packages/shared-web/game/envelopes.ts
packages/shared-web/game/election.ts
packages/shared-web/game/diagnostics.ts
packages/shared-web/game/match.ts
packages/shared-web/game/mod.ts
```

Update:

```text
packages/shared-web/mod.ts
```

with:

```ts
export * from './game/mod.ts';
```

Add tests:

```text
packages/tests/shared-web/rallar-game-lanes.test.ts
packages/tests/shared-web/rallar-game-envelopes.test.ts
packages/tests/shared-web/rallar-game-election.test.ts
packages/tests/shared-web/rallar-game-diagnostics.test.ts
packages/tests/shared-web/rallar-game-match.test.ts
```

## Public API

Expose this entry point:

```ts
createRallarGameMatch<TInput, TIntent, TSnapshot, TEvent>(
    config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent>,
): RallarGameMatchHandle<TInput, TIntent, TSnapshot, TEvent>;
```

Expose lane preset builder:

```ts
createRallarGameLanePresets(
    options?: RallarGameLanePresetOptions,
): readonly RtcDataChannelLaneConfig[];
```

Expose pure helpers:

```ts
scoreRallarGameHostCapability(
    capability: RallarGameHostCapability,
): number;

electRallarGameHost(
    input: RallarGameHostElectionInput,
): RallarGameHostElectionResult;

createRallarGameEnvelope<T>(
    input: RallarGameEnvelopeCreateInput<T>,
): RallarGameEnvelope<T>;

isRallarGameEnvelope(
    value: unknown,
    protocol: string,
): value is RallarGameEnvelope<unknown>;

createRallarGameSequenceTracker(): RallarGameSequenceTracker;

deriveRallarGameDiagnostics(
    input: RallarGameDiagnosticsInput,
): RallarGameDiagnostics;
```

Define a minimal dependency surface:

```ts
type RallarGameRallarFacade = Pick<
    RallarFacade,
    | 'session'
    | 'subscriptions'
    | 'rooms'
    | 'people'
    | 'director'
    | 'rtc'
    | 'realtime'
    | 'messages'
>;
```

The factory should accept `RallarGameRallarFacade` through dependency
injection. It should not import the singleton `rallar` facade directly. This
keeps tests simple and makes Rallar Game usable with isolated facades.

## Core Types

Add these public types:

```ts
RallarGameLaneIds
RallarGameTypeIds
RallarGameMatchPhase
RallarGameMatchStatus
RallarGameHostCapability
RallarGameHostCandidate
RallarGameHostElectionInput
RallarGameHostElectionResult
RallarGameHostLease
RallarGameHostAppointResult
RallarGameEnvelope<T>
RallarGameEnvelopeKind
RallarGameEnvelopeCreateInput<T>
RallarGameSequenceTracker
RallarGamePeerReadiness
RallarGameLaneReadyOptions
RallarGameRecoveryState
RallarGameDiagnostics
RallarGameDiagnosticsInput
RallarGameSendResult
RallarGameStatusHandler
RallarGameEnvelopeHandler<T>
```

Default lane IDs:

```text
game-input
game-intent
game-snapshot
game-metrics
game-replication
```

Default type IDs derived from `topicId`:

```text
${topicId}.capability.v1
${topicId}.intent.v1
${topicId}.event.v1
${topicId}.snapshot.v1
${topicId}.sync-request.v1
${topicId}.heartbeat.v1
```

Suggested match phases:

```text
idle
lobby
electing
appointed
connecting
ready
active
recovering
ended
stopped
error
```

## Match Config

Use this shape:

```ts
type RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent> = {
    rallar: RallarGameRallarFacade;
    protocol: string;
    topicId: string;
    roomId?: string;
    roomRef?: GroupRef;
    laneIds?: Partial<RallarGameLaneIds>;
    typeIds?: Partial<RallarGameTypeIds>;
    heartbeatTtlMs?: number;
    capabilityTtlMs?: number;
    readCapability?: () => Omit<
        RallarGameHostCapability,
        'peerId' | 'reportedAtEpochMs'
    >;
    resolvePeerIds?: (roomState: RallarRoomState) => readonly string[];
    scoreHost?: (capability: RallarGameHostCapability) => number;
    readSnapshot?: () =>
        | TSnapshot
        | undefined
        | Promise<TSnapshot | undefined>;
    onInput?: RallarGameEnvelopeHandler<TInput>;
    onIntent?: RallarGameEnvelopeHandler<TIntent>;
    onSnapshot?: RallarGameEnvelopeHandler<TSnapshot>;
    onEvent?: RallarGameEnvelopeHandler<TEvent>;
    onSyncRequest?: RallarGameEnvelopeHandler<unknown>;
};
```

Default `resolvePeerIds`:

- read `rallar.rooms.state().members`
- include online members' `sessionIds`
- include the local `rallar.session()?.sessionId` if present
- dedupe and sort peer IDs for deterministic election

The match runtime should support both `roomId` and `roomRef`, but it should
prefer `roomRef` when available because current Rallar guidance recommends
scoped room references where scope matters.

## Match Handle

Use this shape:

```ts
type RallarGameMatchHandle<TInput, TIntent, TSnapshot, TEvent> = {
    start(): Promise<RallarGameMatchStatus>;
    stop(): void;
    status(): RallarGameMatchStatus;
    diagnostics(): RallarGameDiagnostics;
    reportCapability(
        capability?: Partial<RallarGameHostCapability>,
    ): Promise<RallarGameSendResult>;
    election(): RallarGameHostElectionResult;
    appointIfElected(): Promise<RallarGameHostAppointResult>;
    waitForReadyLanes(
        options?: RallarGameLaneReadyOptions,
    ): Promise<RallarGamePeerReadiness>;
    sendInput(input: TInput): Promise<RallarGameSendResult>;
    sendIntent(intent: TIntent): Promise<RallarGameSendResult>;
    publishSnapshot(
        snapshot: TSnapshot,
        options?: { reliable?: boolean },
    ): Promise<RallarGameSendResult>;
    publishEvent(event: TEvent): Promise<RallarGameSendResult>;
    requestSync(payload?: unknown): Promise<RallarGameSendResult>;
    onStatus(handler: RallarGameStatusHandler): RallarUnsubscribe;
};
```

## Behavior

### Startup And Subscriptions

`start()` subscribes to:

- room changes
- people changes
- director status
- RTC status
- capability messages
- realtime input lane
- realtime snapshot lane
- Director Relay callbacks

`stop()`:

- unsubscribes everything
- stops the Director Relay handle
- clears timers
- prevents later callbacks from invoking app handlers
- changes phase to `stopped`

### Capability Reporting

Capability reports are room-scoped WS messages using the configured capability
type ID. `reportCapability()` should:

- merge caller input with `readCapability()` if present
- attach local `peerId` from `rallar.session()?.sessionId`
- attach `reportedAtEpochMs`
- send through `rallar.messages.ws.send(...)`
- cache local capability immediately so local election is not blocked waiting
  for message echo

### Election

Election is pure and deterministic:

- use the configured peer list
- use fresh capabilities only
- ignore capabilities older than `capabilityTtlMs`
- allow missing capability but score it below a real report
- score with `scoreHost` or `scoreRallarGameHostCapability`
- tie-break by stable peer/session ID
- select backup as the next eligible candidate after host

`appointIfElected()` is safe to call on every client. Only the elected local
peer should call `rallar.director.appoint(...)`.

### Director Lifecycle

Use existing Rallar Director primitives:

- `rallar.director.status(...)`
- `rallar.director.onStatus(...)`
- `rallar.director.appoint(...)`
- `rallar.director.createRelay(...)`

Rallar Game should not create its own director metadata format. It should derive
game host state from Rallar director appointment, freshness, and epoch.

### Message Flow

Director Relay is used for:

- intents
- events
- reliable snapshots
- heartbeat
- sync request

High-rate input uses `game-input` and targets the fresh director only.

High-rate snapshots use `game-snapshot` and are accepted only from the fresh
director.

`sendInput()` should not fall back to WS by default. Input is high-rate and
stale quickly; apps that need reliable command semantics should use
`sendIntent()`.

`publishSnapshot(snapshot, { reliable: true })` should send through Director
Relay snapshot. Without `reliable: true`, it should use the realtime snapshot
lane.

### Envelope Rules

Every routed payload is wrapped in a generic envelope containing:

```text
protocol
kind
roomId
senderId
seq
sentAtEpochMs
directorEpoch
payload
```

Reject before app handlers run when:

- protocol does not match
- room does not match
- required sender is missing
- director epoch is stale
- sequence is duplicate or older for the sender/kind
- snapshot or event does not come from the fresh director

Rallar Game should not validate app payload schemas. Applications own app-level
payload validation.

### Recovery

If there is no fresh director, status becomes `recovering`.

V1 recovery is:

1. pause app-level match progression
2. re-elect
3. appoint if elected
4. request sync
5. receive reliable snapshot

Full seamless host migration and continuous backup-state promotion are deferred.

## Lane Presets

`createRallarGameLanePresets()` returns:

- `game-input`: unordered, `maxRetransmits: 0`, low queue, latest input can
  replace old input by sender key.
- `game-intent`: ordered reliable or near-reliable, for Director Relay
  client-to-director actions.
- `game-snapshot`: unordered, `maxRetransmits: 0`, replace-by-key, low queue.
- `game-metrics`: unordered, low priority, drop-old.
- `game-replication`: ordered reliable, optional backup state lane.

Apps must pass these lanes before connect/start:

```ts
await rallar.start({
    connect: true,
    refreshRooms: true,
    refreshPeople: true,
    dataChannelLanes: createRallarGameLanePresets(),
});
```

The match runtime should report missing lane readiness in diagnostics, but it
must not try to add lanes after Rallar has already connected.

## Implementation Order

1. Add pure types, lane presets, envelope helpers, sequence tracker, election,
   and diagnostics.
2. Add pure unit tests for those helpers.
3. Add `createRallarGameMatch(...)` with fake-Rallar tests only.
4. Export from `packages/shared-web/game/mod.ts` and
   `packages/shared-web/mod.ts`.
5. Add a short Cash Chase consumption section to this plan.
6. Only after V1 passes tests, wire Cash Chase-specific runtime code against the
   new API.

## Test Plan

Run:

```text
npm --workspace @ar-eye-hunter/shared-web run typecheck
npx vitest run packages/tests/shared-web/rallar-game*.test.ts
```

Test cases:

- lane presets produce exact expected IDs, labels, reliability, and flow
  control.
- host election is deterministic and selects backup correctly.
- missing capability sorts below fresh capability.
- stale capability is ignored after TTL.
- envelopes guard protocol, room, sender, epoch, kind, and sequence.
- match start subscribes to the expected Rallar surfaces.
- capability report sends a room WS message.
- local elected peer appoints itself as director.
- non-elected peer does not appoint itself.
- input sends only to a fresh director.
- snapshot from non-director is rejected.
- sync request delegates to Director Relay and sends `readSnapshot()` when
  available.
- stale director sets recovery state.
- `stop()` prevents later handler calls.

## Acceptance Criteria

- No direct use of raw browser networking APIs in `packages/shared-web/game`.
- No calls to `rallar.advanced.middleware()`.
- No simulation/game-domain logic in `packages/shared-web/game`.
- All public types are generic and Cash Chase-neutral.
- Cash Chase can express its input, snapshot, event, and intent payloads as
  generic parameters.
- Existing Rallar tests continue to pass.
- New Rallar Game tests pass in normal Vitest without browser automation.

## Cash Chase Arena Consumption

Cash Chase should consume Rallar Game as the communication coordination layer,
not as the game runtime.

Cash Chase should provide:

- `TInput`: compact player control input.
- `TIntent`: reliable actions such as ready, start, interact, cash out, and
  mission interaction.
- `TSnapshot`: authoritative director snapshot from the Cash Chase simulation.
- `TEvent`: reliable game events such as caught, cashed out, mission started,
  mission completed, and match ended.

Cash Chase remains responsible for:

- simulation tick loop
- movement, sprint, dash, vault, and collision
- Sentinel AI
- scoring
- missions
- arena layout validation
- rendering and camera
- app payload validation

Suggested Cash Chase usage shape:

```ts
const game = createRallarGameMatch<
    CashChaseInput,
    CashChaseIntent,
    CashChaseSnapshot,
    CashChaseEvent
>({
    rallar,
    protocol: 'cash-chase.v1',
    topicId: 'cash-chase.game',
    readCapability: readCashChaseHostCapability,
    readSnapshot: () => simulation.currentSnapshot(),
    onInput: ({ payload }) => directorRuntime.enqueueInput(payload),
    onIntent: ({ payload }) => directorRuntime.handleIntent(payload),
    onSnapshot: ({ payload }) => clientRuntime.acceptSnapshot(payload),
    onEvent: ({ payload }) => clientRuntime.applyEvent(payload),
});
```

Cash Chase should not create a separate raw networking layer once this API is in
place.

## Rallar Game Authority Follow-Up

The server-authoritative sibling product should be named **Rallar Game
Authority**, not Rallar GameServer. The server-side helper may use names such as
`RallarGameAuthorityServer`, but the umbrella product should stay authority
oriented so it does not imply that Rallar owns simulation, persistence, command
legality, scoring, movement, AI, or rendering.

The first hybrid authority model is **server core + peer assist**:

- commands and authoritative snapshots flow through server WS
- RTC presence is cosmetic
- RTC snapshot repair is opt-in and app-validated
- peer-assisted repair is not a security boundary
- server WS or an app-owned catch-up path remains the source of truth
