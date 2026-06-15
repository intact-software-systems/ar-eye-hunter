# Shared Architecture Notes

`packages/shared` owns the runtime-agnostic Rallar contracts and reusable
building blocks. It should be safe to use from browser, server, tests, and apps
without pulling in DOM, HTTP-server, Postgres, or app-specific runtime wiring.

## Current Public Surface

- `mod.ts` is the broad compatibility barrel for shared Rallar contracts,
  protocols, helpers, and runtime-neutral services.
- `api/` defines shared auth, client, group, state, director, overlay, and
  message contracts. Scoped group identity should flow through `GroupRef` when a
  caller can operate across more than one app/workspace.
- `al-contracts/` and `alm/` define AL message shapes, QoS/admission policies,
  runtime stores, inbound/outbound message processing, multicast targeting, and
  WebSocket/RTC policy helpers.
- `queuebox/`, `services/`, `repository/`, `persistence/`, and `resilience/`
  provide runtime-neutral persistence, queue, retry, clock, and utility
  contracts used by browser and server packages.
- `crdt/` owns shared CRDT contracts, document health/recovery helpers, sync
  envelopes, backup/restore support, and retention/erasure primitives.
- `rallar-ai/` owns shared RallarAI contracts and deterministic helpers. Live
  browser/server provider implementations belong in consuming packages.
- `rallar-game/` and `rallar-motion/` own transport-neutral game authority,
  command, motion lane, and payload contracts consumed by shared-web and games.
- `webrtc/` owns shared WebRTC group, multicast, overlay, and signaling
  contracts that do not depend on browser APIs directly.

## Boundaries

- Do not add browser-only globals, Hono/API-v1 routes, Postgres adapters, or app
  configuration here.
- Do not depend on `graphology`; graph topology implementations live in
  `packages/shared-graph`.
- Prefer small exported functions, explicit options, `Readonly` types, and
  dependency injection for clocks, IDs, repositories, transports, random values,
  and side effects.
- Stateful objects are appropriate when they own lifecycle, caches,
  subscriptions, persistence, queue engines, or long-lived coordination.
- Public barrels should remain compatible unless an API removal is explicitly
  planned and tested.

## Reliability Truths

- Same `groupId` can exist in different application/workspace scopes. New
  shared protocols should preserve scoped identity with `GroupRef` rather than
  assuming a bare id is globally unique.
- AL multicast targets carry scoped `groupRef` for routing. Overlay and graph
  code should avoid bridging scoped topology through raw string ids.
- QueueBox and AL runtime stores are reusable primitives. They should stay
  deterministic and independently testable because browser and server packages
  compose them differently.
- CRDT health, backup/restore, quarantine, compaction, retention, and erasure
  helpers are package-level behavior, not app-only debug tooling.
- Game and motion helpers are reliability consumers of the realtime platform:
  idempotency, replay, lane freshness, authority resync, and disconnect handling
  belong in shared behavior tests.

## Validation

Common package-focused checks:

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
npx vitest run packages/tests/shared
```

For targeted changes, prefer the closest focused test file under
`packages/tests/shared/**` before running the broader package suite.
