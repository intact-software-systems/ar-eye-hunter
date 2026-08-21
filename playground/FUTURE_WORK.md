# Future Work

## Rallar And Multiplayer Games

Rallar is a strong foundation for browser-first, room-based multiplayer
applications. It already provides the main substrate pieces a multiplayer app
needs:

- Auth, session, people, presence, and room workflows.
- WebSocket message lanes for reliable room/application events.
- WebRTC message and realtime data-channel lanes for low-latency peer flows.
- Media helpers for voice/video style experiences.
- Browser-side custom data with IndexedDB persistence.
- Server-side custom app data with Postgres persistence.
- Server-side WebSocket topic definitions, validators, authorizers, proxying,
  NACKs, payload limits, and configurable fanout.

The current architecture separates the useful multiplayer planes:

- Control plane: REST/auth/tickets/room membership.
- Event plane: WebSocket topics and server policy.
- Realtime plane: WebRTC data channels and peer fanout.
- Persistence plane: client `rallar.data` and server `rallar.data`.

That makes Rallar suitable for non-trivial multiplayer products, but it is not
yet a complete authoritative game-server framework.

## Fit By Game Type

| Game Type                   | Fit Today         | Notes                                                                                              |
| --------------------------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| Turn-based multiplayer      | Strong            | Rooms, durable state, validation, reconnect, and event fanout map well.                            |
| Async/social multiplayer    | Strong            | Presence, group state, chat/events, local data, and app data are already good building blocks.     |
| Casual realtime small rooms | Good              | WebRTC realtime lanes are suitable for cursors, avatars, lightweight co-op state, and party games. |
| Authoritative action game   | Medium foundation | Transport is present, but game authority, ticks, snapshots, and reconciliation must be added.      |
| Competitive twitch game     | Weak today        | Needs strict authority, binary protocol tuning, anti-cheat, rate limits, and load testing.         |
| MMO / large world           | Not ready         | Needs sharding, zones, spatial interest management, and higher-volume infrastructure.              |

## Recommended Direction

Treat Rallar as the multiplayer substrate, then add a game layer above it.

Recommended shape:

- `rallar-server`: auth, rooms, WebSocket policy, app data, persistence.
- Game server service: authoritative match state, command validation, tick loop,
  snapshots, and result persistence.
- `rallar.realtime`: ephemeral low-latency peer/client updates.
- `rallar.messages.ws`: accepted commands, server events, snapshots, and lobby
  events.
- `server.data`: durable match metadata, save state, inventory, player progress,
  and match results.

Example topic split:

- `app.matchmaking.request` / `matchmaking.request.v1`
- `app.matchmaking.result` / `matchmaking.result.v1`
- `room.game.command` / `game.command.move.v1`
- `room.game.event` / `game.event.accepted.v1`
- `room.game.snapshot` / `game.snapshot.v1`
- `room.chat` / `chat.message.v1`

## Missing Game Authority Layer

The most important missing piece is game authority, not transport.

Future work:

- Add an authoritative match/session service.
- Add a fixed tick or command-processing loop.
- Add command/input sequence validation.
- Add server-generated snapshots.
- Add client-side interpolation and reconciliation helpers.
- Add reconnect state reconstruction for active matches.
- Add match lifecycle states: pending, starting, running, paused, finished,
  abandoned.
- Add result persistence and idempotent result publication.
- Add per-room and per-player rate limits.
- Add basic anti-cheat policy hooks.

## Server Topic Work

The server WebSocket facade is useful now, but games need stronger topic
ergonomics and observability.

Future work:

- Add a game-topic helper API on top of `server.ws.defineTopic(...)`.
- Add topic presets for command, event, snapshot, input, chat, and telemetry
  flows.
- Add topic-level metrics: messages accepted, rejected, proxied, dropped, NACKed,
  and fanout count.
- Add per-topic rate limits and payload budgets.
- Add optional binary payload support for high-frequency messages.
- Add stricter default behavior for game topics: explicit registration,
  validation required, and no implicit topic acceptance.
- Add test fixtures for room-scoped topic authorization and rejected-message
  NACK behavior.

## Realtime Work

The WebRTC realtime lane is well aligned with ephemeral game state, but it needs
game-facing helpers.

Future work:

- Add typed realtime lanes for common game traffic:
  - position/state deltas
  - input samples
  - cursor/avatar updates
  - voice/video side channels
- Add helpers for replace-by-key state streams.
- Add client-side stale-message dropping by sequence/time.
- Add heartbeat/health exposure per peer and lane.
- Add fallback policy from RTC to WS when peer lanes are closed.
- Add room-level realtime diagnostics.

## Persistence Work

Rallar now has browser and server app data. Games need conventions for what
should live where.

Future work:

- Define recommended storage categories:
  - local preferences and local drafts in browser `rallar.data`
  - authoritative match state on the game server
  - durable match metadata/results in server `rallar.data`
  - middleware state only in Rallar system repositories
- Add examples for saved games, player profiles, inventories, and match results.
- Add compare-and-set or optimistic concurrency support for server app data if
  concurrent writers become common.
- Add app-data repository metrics and expiration maintenance.

## Scaling Work

Before using Rallar for larger multiplayer loads, the runtime needs operational
proof.

Future work:

- Add load tests for:
  - many rooms
  - many sessions per room
  - high-frequency room messages
  - mixed RTC and WS traffic
  - reconnect storms
- Add backpressure and overload policies per topic.
- Add horizontal fanout strategy across multiple server processes.
- Add stronger Postgres queue/runtime-state performance tests.
- Add tracing across REST command, WS message, QueueBox entry, and fanout.
- Add structured logs for topic rejection and proxy decisions.

## Practical Milestones

1. Build a small authoritative turn-based sample using `server.ws` and
   `server.data`.
2. Build a casual realtime room sample using `rallar.realtime` for ephemeral
   state and WS for accepted events.
3. Add a `GameSessionService` abstraction in shared-server or an app package.
4. Add command validation, snapshot publication, and reconnect hydration.
5. Add topic metrics and rate limits.
6. Load test a realistic room scenario.

## Bottom Line

Rallar can already support complex room-based multiplayer applications and is
especially well suited to turn-based, social, collaborative, and casual realtime
browser games.

For authoritative action games, Rallar is a solid substrate but still needs a
dedicated game-server layer. For competitive twitch games or MMO-scale worlds,
substantial game-specific infrastructure remains.
