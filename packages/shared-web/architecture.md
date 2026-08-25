# Shared-Web Architecture Notes

`packages/shared-web` is the browser-facing Rallar package. It has the broad
browser facade at `browser/rallar.ts` plus feature-owned HTTP and workflow
modules for rooms, state reads, sessions, connection, RTC, CRDT, statistics,
data, middleware, transport engines, RallarAI, and game helpers.

## Current Public Surfaces

- `browser/rallar.ts` is the full canonical browser facade and application
  entry point. The beginner path is `rallar.setup(...)`, then
  `rallar.rooms.enter(...)`, then room-bound
  `message(...)` or `realtime(...)` channels. New-room flows that should leave
  the previous room use `rallar.rooms.createAndSwitch(...)`.
- Product HTTP operations live with their feature: connection config and ICE
  under `browser/connection/`, CRDT catch-up under `browser/crdt/`, room and
  presence mutations under `browser/rooms/`, topology and graph reads under
  `browser/rtc/`, client sessions under `browser/session/`, collections and
  events under `browser/state-read/`, and statistics under `browser/stats/`.
  Generic request execution, typed HTTP errors, state paths, and mutation
  contracts remain under `browser/api/`.
- `browser/rallar-core.ts` is the narrow core entry point for browser config,
  selectors, and the connection/startup, auth, room, people, and message
  contracts. It exports the room-session/setup types but does not export the
  full `rallar` singleton or a forwarding facade factory.
- `browser/rallar-realtime.ts` builds on the core entry point with realtime
  send/listen and RTC readiness/status contracts. It does not export the full
  `rallar` singleton or a forwarding facade factory.
- `browser/rallar-data.ts` is the intentional local-data public entry and owns
  facade/scope lifecycle; `browser/data/repository-backed-rallar-data-store.ts`
  owns repository-backed reads, writes, clearing, and disposal.
- `browser/rallar-crdt.ts` owns browser CRDT documents and transports.
- `browser/rallar-media-calls.ts` is the type-only calls and media source entry
  point. It does not export the full `rallar` singleton or a forwarding facade
  factory.
- `game/mod.ts` is the browser game helper barrel.
- `mod.ts` is the broad shared-web package barrel.

Use the smallest browser entry point that matches the feature area.

## Browser Facade Runtime

`browser/rallar.ts` owns the full browser facade and delegates construction to
[`createRallarFacade`](./browser/composition/create-rallar-facade.ts).
Top-to-bottom construction and facade assembly live under
`browser/composition/`. Runtime behavior stays with the feature-owned
`browser/calls/`, `browser/connection/`,
`browser/director/`, `browser/media/`, `browser/messages/`,
`browser/people/`, `browser/realtime/`, `browser/rooms/`,
`browser/rtc-diagnostics/`, `browser/rtc/`, `browser/session/`, and
`browser/state-cache/` modules. Game match lifecycle, egress, director, relay,
and status owners live under `game/`. Public barrels and narrow entry points do
not export those private runtime owners.

Public capability contracts stay beside their canonical browser capability:
message, people, room, auth, connection, calls, director, realtime, media, and
Data modules own their vocabulary. `rallar-shared-contracts.ts` contains only
shared subscription and listener primitives, while
`rallar-facade-contract.ts` composes the aggregate `RallarFacade` type.

Runtime dependencies point inward from the composer to narrow controller
ports. State, messages, WS inbox, WS, RTC, realtime, rooms/people/stats,
media/calls, and director do not import the full browser facade or the
composer. Higher-level controllers receive lower-level facade or state ports;
state notifies director through an after-emit observer, and state events plus
ordinary WS messages share the ordered WS inbox multiplexer.

`createRallarSessionController` constructs the transport connection lifecycle,
then the auth-session lifecycle, then the public connection/auth operations.
The auth owner handles expiry, 401 termination, login/logout, browser-local
cleanup, and notifications. The connection owner coalesces concurrent
connect/disconnect work and owns lifecycle attach/detach. Its ordered lifecycle
participants attach and detach in this fixed order: director cleanup, state
cache, RTC message inbox, WS inbox, WS status, realtime peer lifecycle, RTC
status, realtime lanes, and media. Detach is deliberately not reversed.
Connected notification remains state, then WS, then RTC; disconnected
notification runs only after middleware shutdown and runtime clearing.

The production-symbol construction, registration, invocation, and cleanup map
is maintained in [browser/README.md](./browser/README.md). Construction passes
completed dependencies top-to-bottom with no late-bound state, event, session,
or startup consumer. `BrowserTransportRuntime` is the single pending/active
middleware and transport-shutdown owner; callers use that connection-owned
runtime directly, with no duplicate browser-root context layer.

## Room Transport Product Helpers

- `rallar.setup(input)` is the browser golden-path bootstrap. It combines
  API-base configuration, facade defaults, and `start(...)`, defaulting to
  restored session, connect, room refresh, and no people refresh unless
  requested.
- `rallar.rooms.enter(room, options)` joins a room and returns a
  `RallarRoomSession`. `rallar.rooms.session(room?)` returns the same kind of
  handle for an explicit/default/current room without joining.
- `rallar.rooms.createAndSwitch(input)` creates a room, makes it current, and
  leaves the previous current room. `rallar.rooms.waitForPresence(...)` waits
  for active room sessions against a readiness expectation before game/realtime
  setup needs to proceed.
- `RallarRoomSession` binds room identity once. `room.realtime<T>(...)`
  delegates to `rallar.realtime.room<T>(...)` with the room ref applied, and
  `room.message<T>(...)` delegates to `rallar.messages.room<T>(...)` with the
  room ref applied. `room.message('chat')` derives route-safe
  `room.chat`/`room.chat.v1` IDs.
- `rallar.realtime.room<T>(defaults)` remains the underlying helper for
  room-scoped JSON motion/game payloads. It owns room RTC readiness, ready-peer
  targeting, stale-send options, and send diagnostics while still returning the
  underlying realtime send results.
- `rallar.messages.room<T>(definition)` remains the underlying typed room
  message helper when WS fallback or durable queuebox publication matters. It
  applies room defaults to typed RTC and WS sends and keeps the lower-level
  `messages.rtc`, `messages.ws`, and `messages.channel` APIs available for
  advanced use.
- Low-level `rallar.rtc.*`, `rallar.realtime.sendJson`, and
  `rallar.messages.*` remain stable advanced surfaces for diagnostics,
  black-box testing, targeted peer sends, and custom transports. Room RTC waits
  are expectation-aware and return ready/not-ready peer IDs plus missing/extra
  peer diagnostics, including `over-capacity`.
- `rallar.director.appoint(...)` uses the dedicated state API appointment route.
  It must not write `rallarDirector` through generic `rooms.updateMetadata(...)`;
  generic metadata updates stay owner/admin-only while Rallar Game can use the
  member fallback policy when owners/admins are offline and no director session
  is active.
- `browser/readiness.ts` owns the shared browser readiness expectation helpers
  used by room presence waits, RTC room-lane waits, and game readiness checks.

## Current App Usage

- `apps/ar-eye-hunter-v1` uses the full facade for startup, auth, rooms,
  realtime lanes, RTC readiness/diagnostics, director authority, egress status,
  Squad Link state, and local data. New arena creation uses
  `rallar.rooms.createAndSwitch(...)`; manual room joins use
  `rallar.rooms.enter`; room-scoped fallback game sends still use
  `rallar.realtime.room` because the app's match helper owns most transport
  behavior.
- `apps/relic-hunters-v1` uses the full facade through a runtime adapter for
  auth, rooms, WS/RTC messages, realtime motion, and RTC lane readiness.
  Its runtime adapter now maps joins through `rallar.rooms.enter` and keeps the
  rest of the game on a small app-owned `roomId` abstraction.
- `apps/rallar-black-box` intentionally imports the full facade dynamically as a
  conformance target. Its Rallar Server REST workbench now
  exposes only the scoped graph and topology endpoints.
- `examples/**` now teach the golden path first: `rallar.setup(...)`,
  `rallar.rooms.enter(...)`, `room.message(...)`, and `room.realtime(...)`.

## Bundle Measurement

Run the reporting-only browser bundle check with:

```bash
npm --workspace @ar-eye-hunter/shared-web run measure:browser-bundles
```

Run the enforcing budget check with:

```bash
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
```

The command bundles `browser/rallar.ts`, the narrow browser entry points, and
`mod.ts` to the system temp directory, then prints minified, gzip, and Brotli
sizes. The measurement command is reporting-only; the check command fails when
an entry exceeds its Brotli budget.

The full-facade ceiling is 162 KiB. It was raised from 161 KiB when the direct,
plan-compliant CRDT owners measured 161.3 KiB; retaining forwarding factories
or adding compression-only indirection would make the runtime harder to trace
for a negligible transfer-size difference.

Current measured sizes and budgets:

| Entry                           |  Minified |      Gzip |    Brotli |      Budget |
| ------------------------------- | --------: | --------: | --------: | ----------: |
| `browser/rallar.ts`             | 771.2 KiB | 196.3 KiB | 161.3 KiB | < 162.0 KiB |
| `browser/rallar-core.ts`        |   0.5 KiB |   0.3 KiB |   0.3 KiB | < 100.0 KiB |
| `browser/rallar-realtime.ts`    |   0.5 KiB |   0.3 KiB |   0.3 KiB | < 100.0 KiB |
| `browser/rallar-data.ts`        |  30.1 KiB |   7.1 KiB |   6.4 KiB |  < 20.0 KiB |
| `browser/rallar-crdt.ts`        |  79.1 KiB |  18.3 KiB |  16.4 KiB |  < 30.0 KiB |
| `browser/rallar-media-calls.ts` |   0.0 KiB |   0.0 KiB |   0.0 KiB |  < 10.0 KiB |
| `shared-web/mod.ts`             | 831.7 KiB | 210.0 KiB | 172.5 KiB |           - |

## Dependency Boundaries

- `@ar-eye-hunter/shared-web` does not declare `graphology`; graph/topology code
  belongs in `packages/shared-graph` or explicit app-level graph tooling.
- `browser/rallar-core.ts` and `browser/rallar-realtime.ts` must not bundle
  `graphology`, `@js-temporal/polyfill`, or the full `browser/rallar.ts`
  runtime composer.
- `@js-temporal/polyfill` remains declared by shared-web for now because shared
  queue/runtime modules consumed by the full facade still import Temporal
  directly. Moving that dependency behind app-level dependency policy is a
  separate shared queuebox/resilience refactor.
