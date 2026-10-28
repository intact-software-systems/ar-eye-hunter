# Runtime Data Flow

Last reviewed: 2026-10-28.

## Modules

- `src/game/relic-hunters-runtime.ts` is the browser runtime facade around
  Rallar auth, rooms, room listeners, WS snapshot listeners, RTC snapshot
  repair, and REST relic API calls.
- `src/game/use-relic-hunters.ts` adapts the runtime into React state and exposes
  phases, diagnostics, room summaries, the current room id, and the accepted
  relic snapshot.
- `src/game/api.ts` performs authenticated REST calls to the relic server.
- `apps/relic-hunter-server-v1/src/relic-game-routes.ts` (`initRelicGameRoutes`) installs the
  authenticated REST routes. `apps/relic-hunter-server-v1/src/relic-game-service.ts` adapts REST and
  WS requests to `packages/relic-hunters/server` and reads the fresh authorized snapshot after completion.
- `RelicGameInboxService` owns durable request identity, fresh-attempt processing and atomic
  AppInbox completion. `RelicGameMutationService` reads session/room/save facts, computes and
  validates the result, then writes the group revision guard, save CAS, publication provenance
  and final WS outbox in the caller transaction. Every API worker registers the handler.
- `apps/relic-hunter-server-v1/src/relic-expedition-ai.ts` optionally creates
  initial game state from a server-side RallarAI expedition blueprint before
  gameplay begins. Disabled mode preserves the current static map; mock and
  Ollama modes validate generated JSON and fall back to procedural setup on
  failure.
- `packages/relic-hunters/src/expedition-blueprint.ts` owns blueprint schema,
  procedural setup, and domain validation for generated maze/castle/reward
  data.
- `packages/relic-hunters/src/rules.ts` is the canonical command and round
  resolution logic.

## Connection Path

1. `use-relic-hunters.ts` constructs one runtime and observes it with
   `useSyncExternalStore`. The runtime restores the initial auth session.
2. The shared room-entry owner captures an incoming link or saved scoped
   destination before startup. Signed-out pages retain it without issuing game reads.
3. `rallar.start` refreshes ordinary rooms only when no destination is pending.
   The connection generation and abort signal fence replaced sessions and stopped pages.
   Auth notifications and login completion share one startup flight.
4. The runtime installs WS, RTC, authority, and room subscriptions, then resumes
   the captured destination. Failed entry cannot silently restore another room.
5. Current-room changes install room-scoped transition/hunter listeners and hydrate
   the authoritative game snapshot. Room admission does not join the expedition.
6. Creation uses `rooms.createAndSwitch`, then waits for the initiating session's
   presence before completing hydration. An admitted room survives previous-room
   cleanup failure, with a visible explanation.
7. Cleanup aborts outstanding startup/readiness work and removes transport,
   room, auth, entry, and timer subscriptions. Late results cannot replace a new
   account or room.

Successful private entry stores only its scoped reference and principal identity
in tab-local storage. It clears the code. Reload rejoins using current membership,
so rotation does not eject an admitted member. A new invitation outranks this saved
return destination; denial offers retry, correction, or cancellation.

Snapshot acceptance belongs to `relic-hunters-runtime.ts` and
`relic-snapshot-ordering.ts`. Diagnostics record connection, room, snapshot,
transport receipt, accepted source, and ignored-result reasons.

## Command Path

The browser sends gameplay commands to the server itself on the Rallar WS `command` channel (`room.relic.command`, a
unicast to the WS server's peer id from `/api/config`, D57 as applied). The server's own ACK is the command's receipt:
the server admitted it. The server applies it under the sender's session username and publishes the new snapshot
through the outbox with receipts.

The command channel is `local-checkpoint` with `onStorageUnavailable: 'refuse'`: the command is admitted and sent from
memory, with no storage work on the send, and the session's checkpoint saves it within one interval (1 s by default); a
page that is hidden or frozen starts a checkpoint at once, and one started as the page unloads is best effort. A reload
after the save resumes the command under the same message id and deadline (30 s). A command admitted inside the last
interval before the page ends is lost with the page, and its handle reads `unobservable`. A checkpoint that lags past
its bound (10 s by default) makes the next command fail with `storage-unavailable` instead of being sent. There is no
command id in the gameplay model: the WS message ID supplies durable AppInbox request identity. The server
re-acknowledges a resumed command without applying it again; transport delivery also rejects messages past their
deadline. Changed command content under an existing request identity is refused. The reload-mid-command browser scenario exercises this boundary separately from ordinary
room restoration; its current result belongs in the PR validation evidence.

```text
command -> WS unicast -> AppInbox admission / server ACK -> fresh read / compute / validate -> group + save CAS / durable result / outbox commit -> WS snapshot
reset -> request-scoped REST -> AppInbox -> group + new save CAS / result / outbox commit -> fresh authorized REST snapshot
```

REST (`POST /api/relic/games/:gameId/commands/requests/:requestId`) is used only before the browser knows the WS
server's peer id, never after a WS attempt. The UI shows the command's receipt state and the applied snapshot's
arrival. Reset uses `POST /api/relic/games/:gameId/reset/requests/:requestId`. Each browser operation
captures one request ID and retains it through retries. A snapshot GET gives its initialization attempt a fresh
identity, then reads current authorized state; an older denied read cannot poison later admission.

Each command carries one trace. The browser sends a fresh `x-request-id` on every REST call, and the
REST routes pass that request's trace; the WS command path passes the command envelope's
`id.traceId`. The trace reaches AppInbox beside the command, never inside it:
`captureRelicGameCommand` keeps it out of the stored command, so the `relic:<sha(command)>` message
id and the request identity do not depend on it. Every publication the command writes, the room
snapshot and the hunter event included, carries that trace.

The server also tells the acting hunter what became of a command, on `room.relic.hunter` / `relic.hunter.v1`: a
principal broadcast in the room, receipted, that only the acting hunter's own live sessions in the room receive.
Relic keys its players by session, so the event names the session that sent the command (`playerId`) and only that
session uses it; the hunter's other sessions are other players and drop it. After a submitted plan it carries the
recorded action for the round (`action-recorded`), which the page does not render because the locked-plan card
already shows the plan it submitted; after a command a rule refused it carries the rule's text (`command-refused`),
which the page shows as the command error. Accepted phase, round or expedition changes expire that refusal;
a later action receipt also clears the displayed refusal while preserving unrelated transport failures.
Late refusal events cannot restore a stale gameplay error over the finale. The committed provenance captures
the private recipient audience; a session joining later does not receive historical feedback.
A storage or session failure on the WS path is still only logged: the server
sends no reply to a command. Rallar's reply channel (`handle.awaitReply`,
`message.reply`) exists, and the planning companion below is its one Relic user.

```text
submit-action -> applyCommand -> outbox snapshot (room) -> outbox hunter event (the hunter's principal in the room)
refused command -> outbox hunter event with the rule's text (the hunter's principal in the room)
```

## Expedition Setup Path

Initial expedition setup is server-owned and happens before a `RelicGameState`
is persisted. The Relic server captures setup proposals before AppInbox processing for room
hydration, reset, and command-created games; pure domain validation decides acceptance using a captured time.
Each writer first verifies the live room and its group revision, so a retired room or save cannot be recreated:

```text
off -> create static game -> persisted state -> normal public snapshot
mock/ollama -> RallarAI blueprint request -> schema validation -> Relic domain validation -> game state
mock/ollama failure -> procedural blueprint -> Relic domain validation -> game state
```

Generated setup changes only the initial `map`, `relics`, and safe setup
metadata. The browser receives normal public snapshots and submits commands through the
same WS/REST decision described above. The existing browser AI Companion remains an
advisory planning aid and does not drive authoritative setup.

## Timed-Out Round Recovery

Stale or disconnected expedition players remain in the game state after start.
They are still counted as active until they escape, are defeated, or the room is
reset. To avoid permanent turn blocking, the shared rules accept a
`force-resolve-round` command after `roundStartedAtEpochMs + roundTimeLimitMs`.
Any active hunter can send it. The server resolves the round with the plans that
were already submitted and skips missing plans for active hunters who did not
lock one. The resolved snapshot enters `phase: review`; it does not advance to
the next planning round until a `continue-review` command is accepted.

The SPA exposes this command only during planning, only after the timer reaches
zero, and only when at least one active hunter is still waiting. This does not
remove stale players from the expedition; it lets the current round advance.
Reset remains the roster-rebuild path.

After a planning deadline is reached while active hunters are still waiting, the
SPA also starts a narrow authoritative snapshot repair poll for the current
room. This is a fallback for missed WS/RTC timeout-resolution snapshots, not a
new command path. Repaired snapshots use source `timeout-repair`, pass through
the same snapshot ordering policy, and stop the stale timed-out UI once the
server snapshot leaves the timed-out planning state, including when it enters
review.

## Round Review Flow

Round resolution is now a two-step authoritative state transition:

```text
planning -> resolve submitted or timed-out plans -> review -> continue-review -> planning or finished
```

`packages/relic-hunters/src/rules.ts` owns both transitions. Resolving a round
applies all pending actions, ruin/noise effects, scoring, and event creation,
then clears `pendingActions`, clears `roundStartedAtEpochMs`, and publishes a
same-round review snapshot. While a snapshot is in review, new gameplay actions
are rejected so clients cannot silently start planning against different event
histories.

The runtime exposes `continueReview()` through `use-relic-hunters.ts`. It sends
`continue-review` through the same command transport decision and applies
resulting snapshots through the common acceptance policy. If another browser
continues first, WS or RTC snapshot repair can still converge peers onto the
next planning or finished snapshot.

## API Base URL

In Vite development, local absolute API URLs such as `http://localhost:8090` are
normalized to an empty base URL so browser calls go through the same-origin
`/api` proxy. Production builds keep the configured `API_BASE_URL` value. This
keeps local browser tests and development consistent while still allowing an
explicit deployed API origin.

## Snapshot Acceptance

Snapshots are rejected when they belong to a non-current expected room or when
they are older than the current same-room snapshot. Equal timestamp snapshots can
still converge between REST responses, WS echoes, and RTC repair messages, but
same-room candidates with the same timestamp and round are rejected if they
regress phase or contain less complete event, submission, or room-investigation
state. The phase order is `lobby -> planning -> review -> finished`; a newer
round can still move from review back to planning because round advancement is
checked before phase rank. Explicit REST reset responses are allowed to
semantically regress to a fresh lobby snapshot.

Development diagnostics now track the latest accepted snapshot metadata and the
last ignored snapshot reason. Development builds also expose
`window.__relicHuntersRuntime` with compact room, diagnostics, and snapshot
metadata for browser tests.

Browser coverage includes REST snapshot hydration, Rallar WS bootstrap, server HTTP APIs,
and visible controls. `full-stack-propagation.spec.ts` exercises two-browser gameplay,
reset, and reload. `full-stack-private-room-entry.spec.ts` exercises signed-out entry,
code sharing and rotation, participation, invitation revocation, destination replacement,
and reload. Both use the paired Relic server when `RELIC_HUNTERS_FULL_STACK=1`.

The WS state-sync publisher writes client and group snapshots into the in-process recipient
cache before queuing broadcasts. The shared scoped entry owner rejoins saved membership
before the SPA hydrates the authoritative Relic snapshot.

## RTC Position Flow

`src/game/scene/networking.ts` publishes cosmetic avatar motion through
`rallar.realtime.room(...).send(...)` on the `realtime` lane. The room facade
owns accepted peer selection and readiness. Relic does not retry through a raw
peer-targeted send. Authoritative gameplay remains in server commands and accepted game snapshots.

The scene checks the current group snapshot for `transportState: halted`
before advancing its motion sequence, sampling kinematics, or checking the send
gate. A known halt records a typed diagnostic and does no per-frame transport
work. An attempt already in flight retains its allocated sequence number if it
later fails or reports a halt, preserving unique sequence numbers across
concurrent frames. Only successful or partial delivery advances the send gate.

Motion uses the app-private `relic.motion.v2` protocol with `version: 2`. Each
payload carries a mandatory `roomRef` containing application, workspace, and
game-room identity. Its separate `roomId` identifies the player's dungeon room.
The sender requires that the current `roomRef` matches its game snapshot; the
room facade receives that complete reference. Incoming JSON must match the
protocol and complete scope, the current game snapshot, and the player's
current dungeon room before it can enter the Rallar Motion buffer. A dungeon
room missing from the authoritative map is rejected; there is no legacy
absolute-coordinate fallback. Version 2 omits its unused absolute `x`/`z`
fields and carries height plus room-relative offsets. Receivers
resolve room-relative offsets against the local scene map, then interpolate
and extrapolate the accepted samples for presentation.

The shared realtime lane does not filter incoming packets by room. Relic's
payload check owns that boundary and rejects other applications, workspaces,
and game rooms even when their player and dungeon-room IDs match. Version 1,
missing-scope, and mismatched-scope packets are dropped with no compatibility
fallback. Clients exchanging cosmetic motion must all use the updated app;
older clients must reload. This changes only ephemeral avatar motion, not
persisted game snapshots or authoritative commands.

## RTC Snapshot Repair

The SPA also uses Rallar RTC as a secondary snapshot repair path. When a client
accepts a public snapshot from bootstrap, room hydration, REST command/reset,
timeout repair, or WS, it publishes that snapshot to
`rallar.rtc.readyPeerIds()` with the regular Relic snapshot topic/type. While
RTC is ready, the current accepted snapshot is also republished periodically.
This is intentionally not a command path: peers do not apply actions from RTC,
they only accept public snapshots that pass the existing ordering and room
checks.

Incoming RTC snapshots use source `rallar-rtc`. They are ignored unless they
belong to the currently joined room, then pass through the same monotonic
snapshot acceptance policy as WS and REST. This keeps clients visually aligned
when WS fanout or room hydration lags, without allowing an older or less
complete peer snapshot to replace a richer local one.

## Browser AI Planning Companion

The browser AI companion is a client-side planning aid, not a command path. It
builds a compact context from the accepted public snapshot, view-model action
options, warnings, known investigations, recent public events, and the scene
objective recommendation. It does not pass the raw snapshot to the provider,
and it redacts unfound relic ids, names, exact hidden locations, and values into
UI-level signals such as `relicSignal`.

Generation is explicit: a player presses Ask while they are in `planning`, are
active, and have not submitted. The request is the RallarAI JSON request without
its `signal`, with a stable `baseStateRevision`. The planning contract (schema id
and version, suggestion schema, prompt, context and suggestion types,
`decodeRelicPlanningAiContext`, `decodeRelicPlanningAiSuggestion`, and the
deterministic `computeRelicPlanningAiSuggestion`) lives in `packages/relic-hunters`
and is shared by the browser and the server.

The server is asked first. `sendRelicPlanningRequest` returns at once when no
server peer id is known. Otherwise it sends the request on a room `command`
channel on `room.relic.ai.planning` / `relic.ai.planning-request.v1`, addressed to
the server peer over WS, and awaits the reply for 5 s with `handle.awaitReply`.
The Relic server (`relic-planning-ai-topic.ts`) installs the RallarAI WebSocket
topic with a deterministic provider: it decodes the context, answers
`computeRelicPlanningAiSuggestion`, and validates its own suggestion before
replying. It admits a request only in a Relic room (the request's room ref is the
Relic scope's `GroupRef` for its room id), only for the planning schema id and
version, and sends one reply, `relic.ai.planning-reply.v1`, to the asking session
alone (not to the hunter's other sessions), through the outbox. The reply carries
the request's trace. A request that is refused, or whose context cannot be decoded,
gets no reply.

The browser accepts a reply only when its result decodes, its `requestId`, schema
id and version are the request's, its `baseStateRevision` is still the current
revision (exactly), and the suggestion passes `decodeRelicPlanningAiSuggestion`
against the context that was asked. Any other outcome is a fallback reason: no
server peer, `timeout`, `undelivered` (a rejected send included) or an invalid reply. On a fallback, a build
with a local provider runs the local path below, and a build without one reads
Unavailable. A cancelled ask (the panel unmounts or Ask is pressed again) neither
falls back nor publishes. The local path uses the existing RallarAI browser facade
with a browser-only policy and rejects a stale result. Its provider is the
deterministic mock (`computeRelicPlanningAiSuggestion`) in development and tests,
chosen by `createDefaultRelicPlanningAiProvider`; a production build has no local
provider, so its suggestions come from the server, and Ask is enabled whenever a
server peer id is known. An Ollama-backed planner and a typed refusal reply are
not built.

Accepted suggestions, from the server or the local provider, become RallarAI
`proposed` envelopes and are sent over Rallar WS on `room.relic.ai.planning` / `relic.ai.planning-proposal.v1` as
a principal broadcast in the room: only the asking hunter's own sessions in the
room receive it, and other hunters never do. The panel's one suggestion card
shows the hunter's newest proposal, whichever of the hunter's sessions asked for
it. Only the local browser can prime its own suggestion into the existing draft
controls, and the normal Submit Plan command remains the authoritative submission path.

## Known Data-Flow Gaps

- Lower-level middleware and WS disruption recovery need their own acceptance
  evidence; private-entry success alone does not establish transport recovery.
- Stale active expedition players can block round resolution because active
  player count is based on game state, not live room membership. Iteration 13's
  first pass makes this recoverable after the timer expires, but does not remove
  stale players from the expedition automatically.
- Runtime diagnostics are useful in development, but the production UI has no
  concise player-facing explanation when a room is joined but the snapshot is
  missing or degraded.
- The review phase currently lets any active local player continue after
  watching the reveal. There is no per-player acknowledgement tracking yet, so a
  faster client can move everyone to the next turn before slower viewers finish
  watching their local animation queue.
