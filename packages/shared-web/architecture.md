# Shared-Web Architecture Notes

`packages/shared-web` is the browser-facing Rallar package. It currently has a
broad compatibility facade at `browser/rallar.ts` plus focused modules for API
workflows, data, CRDT, middleware, transport engines, RallarAI, and game helpers.

## Current Public Surfaces

- `browser/rallar.ts` is the full compatibility facade and the canonical
  browser object. Existing apps import `rallar` from here. The beginner path is
  `rallar.setup(...)`, then `rallar.rooms.enter(...)`, then room-bound
  `message(...)` or `realtime(...)` channels. New-room flows that should leave
  the previous room use `rallar.rooms.createAndSwitch(...)`.
- `browser/api-integration.ts` is the low-level browser REST helper layer. It
  exposes scoped graph diagnostics and topology management helpers for
  `/api/state/apps/{applicationId}/workspaces/{workspaceId}/...`, returning the
  serialized DTO contracts from `@shared/api` and supporting authenticated
  `GET`, `PUT`, `POST`, and bodyless `DELETE` calls.
- `browser/rallar-core.ts` is the narrow core entry point for browser config,
  connection/startup, auth, rooms, people, message helpers, and WS/RTC message
  facade factories. It exports the room-session/setup types but does not export
  the full `rallar` singleton.
- `browser/rallar-realtime.ts` builds on the core entry point with realtime
  send/listen and RTC readiness/status facade factories. It does not export the
  full `rallar` singleton.
- `browser/rallar-data.ts` owns local browser data stores.
- `browser/rallar-crdt.ts` owns browser CRDT documents and transports.
- `browser/rallar-media-calls.ts` is the narrow calls and media source entry
  point. It does not export the full `rallar` singleton.
- `game/mod.ts` is the browser game helper barrel.
- `mod.ts` remains the broad shared-web compatibility barrel.

New app code should prefer the smallest browser entry point that matches the
feature area. Existing app imports from `browser/rallar.ts` and `mod.ts` remain
compatible; migration is intentionally gradual.

## Browser Facade Runtime

`browser/rallar.ts` is a compatibility entry point. It re-exports the existing
public contract and delegates construction to `browser/rallar-runtime/compose.ts`.
The implementation lives in unexported capability controllers under
`browser/rallar-runtime/`; public barrels and narrow entry points must not
export these modules.

Public capability types are owned by their existing `rallar-*-facade.ts`
modules. `rallar-shared-contracts.ts` contains only shared subscription and
listener primitives, while `rallar-facade-contract.ts` composes the aggregate
`RallarFacade` type and re-exports the compatibility type set.

Runtime dependencies point inward from the composer to narrow controller
ports. State, messages, WS inbox, WS, RTC, realtime, rooms/people/stats,
media/calls, and director do not import the compatibility entry point or the
composer. Higher-level controllers receive lower-level facade or state ports;
state notifies director through an after-emit observer, and state events plus
ordinary WS messages share the ordered WS inbox multiplexer.

Connection and auth are owned by the session controller. Its ordered lifecycle
participants attach and detach in this fixed order: director cleanup, state
cache, RTC message inbox, WS inbox, WS status, realtime peer lifecycle, RTC
status, realtime lanes, and media. Detach is deliberately not reversed.
Connected notification remains state, then WS, then RTC; disconnected
notification runs only after middleware shutdown and runtime clearing.

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
  compatibility and conformance target. Its Rallar Server REST workbench now
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

Current browser simplification measurement and budgets:

| Entry | Minified | Gzip | Brotli | Budget |
|---|---:|---:|---:|---:|
| `browser/rallar.ts` | 648.2 KiB | 165.5 KiB | 137.9 KiB | < 160.0 KiB |
| `browser/rallar-core.ts` | 3.2 KiB | 1.0 KiB | 0.9 KiB | < 100.0 KiB |
| `browser/rallar-realtime.ts` | 4.3 KiB | 1.2 KiB | 1.1 KiB | < 100.0 KiB |
| `browser/rallar-data.ts` | 28.9 KiB | 6.8 KiB | 6.1 KiB | < 20.0 KiB |
| `browser/rallar-crdt.ts` | 73.7 KiB | 17.4 KiB | 15.7 KiB | < 30.0 KiB |
| `browser/rallar-media-calls.ts` | 0.5 KiB | 0.3 KiB | 0.2 KiB | < 10.0 KiB |
| `shared-web/mod.ts` | 699.1 KiB | 177.5 KiB | 148.8 KiB | - |

## Dependency Boundaries

- `@ar-eye-hunter/shared-web` does not declare `graphology`; graph/topology code
  belongs in `packages/shared-graph` or explicit app-level graph tooling.
- `browser/rallar-core.ts` and `browser/rallar-realtime.ts` must not bundle
  `graphology`, `@js-temporal/polyfill`, or the full `browser/rallar.ts`
  runtime composer.
- `@js-temporal/polyfill` remains declared by shared-web for now because shared
  queue/runtime modules consumed by the full facade still import Temporal
  directly. Moving that dependency behind app-level compatibility policy is a
  separate shared queuebox/resilience refactor.
