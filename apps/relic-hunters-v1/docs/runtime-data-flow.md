# Runtime Data Flow

Last reviewed: 2026-05-18.

## Modules

- `src/game/relic-hunters-runtime.ts` is the browser runtime facade around
  Rallar auth, rooms, room listeners, WS snapshot listeners, RTC snapshot
  repair, and REST relic API calls.
- `src/game/useRelicHunters.ts` adapts the runtime into React state and exposes
  phases, diagnostics, room summaries, the current room id, and the accepted
  relic snapshot.
- `src/game/api.ts` performs authenticated REST calls to the relic server.
- `apps/relic-hunter-server-v1/src/relic-game-service.ts` persists game state,
  serializes commands per game id, and publishes snapshots through Rallar WS.
- `packages/relic-hunters/src/rules.ts` is the canonical command and round
  resolution logic.

## Connection Path

1. The hook restores an auth session.
2. The runtime calls `rallar.connect()`.
3. It installs a Rallar WS snapshot listener.
4. It installs a Rallar RTC snapshot listener.
5. It installs a Rallar rooms change listener.
6. It refreshes room state.
7. If a room is current, it fetches the room snapshot over REST.
8. The hook accepts or ignores snapshots through `shouldAcceptRelicSnapshot`.
9. Diagnostics track auth, middleware, room, snapshot, WS listener, room
   listener, RTC readiness, snapshot source, ignored snapshots, and last error.

Legacy or mocked snapshots may omit `adminPlayerId`; the SPA treats the first
snapshot player as the keeper/admin in that case. The shared server rules still
normalize `adminPlayerId` when applying commands.

## Command Path

The browser uses REST as the authoritative gameplay command transport:

```text
join expedition -> REST command -> server applyCommand -> persisted state -> WS snapshot publish -> REST response snapshot
start expedition -> REST command -> server applyCommand -> persisted state -> WS snapshot publish -> REST response snapshot
submit action -> REST command -> server applyCommand -> persisted state -> WS snapshot publish -> REST response snapshot
force resolve timed-out round -> REST command -> server applyCommand -> persisted state -> WS snapshot publish -> REST response snapshot
set round limit -> REST command -> server applyCommand -> persisted state -> WS snapshot publish -> REST response snapshot
reset -> REST reset endpoint -> persisted new game -> WS snapshot publish -> REST response snapshot
```

The server still defines the Rallar WS command topic for compatibility/future
experiments, but the SPA does not send gameplay commands over that topic.

## Timed-Out Round Recovery

Stale or disconnected expedition players remain in the game state after start.
They are still counted as active until they escape, are defeated, or the room is
reset. To avoid permanent turn blocking, the shared rules accept a
`force-resolve-round` command after `roundStartedAtEpochMs + roundTimeLimitMs`.
Any active hunter can send it. The server resolves the round with the plans that
were already submitted and skips missing plans for active hunters who did not
lock one.

The SPA exposes this command only during planning, only after the timer reaches
zero, and only when at least one active hunter is still waiting. This does not
remove stale players from the expedition; it lets the current round advance.
Reset remains the roster-rebuild path.

After a planning deadline is reached while active hunters are still waiting, the
SPA also starts a narrow authoritative snapshot repair poll for the current
room. This is a fallback for missed WS/RTC timeout-resolution snapshots, not a
new command path. Repaired snapshots use source `timeout-repair`, pass through
the same snapshot ordering policy, and stop the stale timed-out UI once the
server snapshot has advanced the round.

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
regress phase or contain less complete event, submission, or
room-investigation state. Explicit REST reset responses are allowed to
semantically regress to a fresh lobby snapshot.

Development diagnostics now track the latest accepted snapshot metadata and the
last ignored snapshot reason. Development builds also expose
`window.__relicHuntersRuntime` with compact room, diagnostics, and snapshot
metadata for browser tests.

Current browser coverage verifies REST command submission, REST snapshot
hydration, Rallar WS bootstrap, server HTTP APIs, and scene/UI response in a
single browser context. `tests/playwright/relic-hunters/full-stack-propagation.spec.ts`
adds a gated two-browser propagation path against the paired Relic server/Rallar
runtime. It compares both clients' room id, phase, round, active player count,
submitted player ids, event ids, and accepted snapshot metadata after join,
start, submit/wait/resolve, reload recovery, reset, and rejoin. The spec is
skipped by default, runs with `RELIC_HUNTERS_FULL_STACK=1`, and has passed
against the paired local Relic server.

The propagation fix crossed into Rallar server code: the WS state-sync publisher
now writes client and group snapshots into the in-process recipient cache before
queuing broadcast work. That prevents a room-scoped relic snapshot from racing
ahead of a recent room join and missing the newly joined browser. The SPA also
persists the current room id and rejoins it during reload hydration before
fetching the authoritative relic snapshot.

## RTC Position Flow

`src/game/scene/networking.ts` sends local position updates through Rallar RTC
only when the runtime marks RTC as ready. It also subscribes to remote position
updates and writes them into the scene runtime's `remotePositions` map. These
updates are cosmetic live-presence signals and do not drive authoritative game
state.

The RTC adapter publishes world-space room coordinates plus local roam offset.
This keeps remote avatar interpolation aligned with the Babylon room grid while
leaving authoritative room movement in the turn-based snapshot.

Outbound avatar position messages are explicitly routed to
`rallar.rtc.readyPeerIds()` through `nextHopPeerIds`. Each payload carries the
game room, the avatar's current room, absolute world coordinates, and
room-relative offsets. Receivers prefer the room-relative form and resolve it
against their own scene map, falling back to absolute coordinates for older
payloads. Rallar `messages.rtc` returns `no-route` for untargeted sends, so the
scene skips broadcasts until at least one reliable RTC lane is open and leaves
the broadcast throttle untouched while no peer is routable.

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

## Known Data-Flow Gaps

- The two-browser propagation spec is gated, but the real local full-stack run
  now passes. Lower-level middleware or WS disruption recovery is still not
  separately simulated.
- Stale active expedition players can block round resolution because active
  player count is based on game state, not live room membership. Iteration 13's
  first pass makes this recoverable after the timer expires, but does not remove
  stale players from the expedition automatically.
- Runtime diagnostics are useful in development, but the production UI has no
  concise player-facing explanation when a room is joined but the snapshot is
  missing or degraded.
