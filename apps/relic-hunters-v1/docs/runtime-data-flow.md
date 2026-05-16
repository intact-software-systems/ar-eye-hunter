# Runtime Data Flow

Last reviewed: 2026-05-16.

## Modules

- `src/game/relic-hunters-runtime.ts` is the browser runtime facade around
  Rallar auth, rooms, room listeners, WS snapshot listeners, and REST relic API
  calls.
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
4. It installs a Rallar rooms change listener.
5. It refreshes room state.
6. If a room is current, it fetches the room snapshot over REST.
7. The hook accepts or ignores snapshots through `shouldAcceptRelicSnapshot`.
8. Diagnostics track auth, middleware, room, snapshot, WS listener, room
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
set round limit -> REST command -> server applyCommand -> persisted state -> WS snapshot publish -> REST response snapshot
reset -> REST reset endpoint -> persisted new game -> WS snapshot publish -> REST response snapshot
```

The server still defines the Rallar WS command topic for compatibility/future
experiments, but the SPA does not send gameplay commands over that topic.

## API Base URL

In Vite development, local absolute API URLs such as `http://localhost:8090` are
normalized to an empty base URL so browser calls go through the same-origin
`/api` proxy. Production builds keep the configured `API_BASE_URL` value. This
keeps local browser tests and development consistent while still allowing an
explicit deployed API origin.

## Snapshot Acceptance

Snapshots are rejected when they belong to a non-current expected room or when
they are older than the current same-room snapshot. Equal timestamp snapshots are
accepted so REST responses and WS echoes can converge.

Current weakness: the ordering guard only compares update time and round. A
snapshot with the same timestamp and less complete event/submission data can
replace a richer snapshot. This is unlikely with normal server timestamps but
should be covered if propagation remains unstable under fast commands.

Current browser coverage verifies REST command submission, REST snapshot
hydration, Rallar WS bootstrap, server HTTP APIs, and scene/UI response in a
single browser context. It still does not prove two independent browser clients
converge on the same snapshot after each command. `improvement-plan.md`
Iteration 12 now tracks that proof explicitly before production performance
work resumes.

## RTC Position Flow

`src/game/scene/networking.ts` sends local position updates through Rallar RTC
only when the runtime marks RTC as ready. It also subscribes to remote position
updates and writes them into the scene runtime's `remotePositions` map. These
updates are cosmetic live-presence signals and do not drive authoritative game
state.

The RTC adapter publishes world-space room coordinates plus local roam offset.
This keeps remote avatar interpolation aligned with the Babylon room grid while
leaving authoritative room movement in the turn-based snapshot.

## Known Data-Flow Gaps

- No end-to-end browser test currently proves that two clients receive the same
  snapshots through REST plus WS after each command. This is the primary
  Iteration 12 follow-up.
- No reconnect recovery test currently proves that listeners are reinstalled and
  snapshots are rehydrated after middleware or WS disruption. This is also part
  of Iteration 12.
- Stale active expedition players can block round resolution because active
  player count is based on game state, not live room membership. This is now an
  explicit player-facing policy in the lobby/party-change UI: reset rebuilds the
  expedition roster, while continuing keeps stale joined players in the turn
  resolution set. Iteration 13 tracks the final policy decision.
- Runtime diagnostics are useful in development, but the production UI has no
  concise player-facing explanation when a room is joined but the snapshot is
  missing or degraded.
