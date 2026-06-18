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
  compatibility and conformance target.
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
| `browser/rallar.ts` | 674.3 KiB | 166.9 KiB | 139.6 KiB | < 160.0 KiB |
| `browser/rallar-core.ts` | 2.4 KiB | 0.8 KiB | 0.7 KiB | < 100.0 KiB |
| `browser/rallar-realtime.ts` | 3.5 KiB | 1.1 KiB | 0.9 KiB | < 100.0 KiB |
| `browser/rallar-data.ts` | 28.5 KiB | 6.7 KiB | 6.0 KiB | < 20.0 KiB |
| `browser/rallar-crdt.ts` | 73.7 KiB | 17.4 KiB | 15.7 KiB | < 30.0 KiB |
| `browser/rallar-media-calls.ts` | 0.5 KiB | 0.3 KiB | 0.2 KiB | < 10.0 KiB |
| `shared-web/mod.ts` | 713.8 KiB | 176.1 KiB | 147.8 KiB | - |

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
