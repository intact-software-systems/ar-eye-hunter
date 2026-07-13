---
name: building-rallar-apps
description: Use when creating, bootstrapping, scaffolding, or architecting a new Rallar browser application, React/Vite SPA, or Three.js, React Three Fiber, or Babylon game, including authority, runtime, room, renderer, lifecycle, and test boundaries.
---

# Building Rallar Apps

## Start Here

Read `references/app-scaffolding.md` before creating files. For a 3D app, also
read `references/react-3d-architecture.md`. Use
`references/example-map.md` to inspect the smallest current examples that match
the requested capabilities.

Inspect the public code and focused tests behind every selected example. Code
and tests are authoritative when prose differs.

In every plan, name the smallest selected evidence paths and preserve the
initial `rallar.setup(...)` versus post-login `rallar.start(...)` distinction.

## Required Decisions

1. Choose browser-director, server-authoritative, or collaborative authored
   state before selecting transports.
2. Define the pure domain, Rallar runtime, React UI, presentation, and renderer
   boundaries.
3. Use `rallar.setup(...)` for initial boot and preserve `roomRef` in scoped
   application/workspace flows.
4. Prefer room-bound `room.message<T>(...)` and `room.realtime<T>(...)`
   handles before low-level transport wiring.
5. Make logout, room switch, unmount, hot reload, and renderer replacement
   cancel stale work and dispose resources idempotently.
6. Add one end-to-end vertical slice and focused tests before expanding the
   capability set.

Room handles scope sends, peer selection, and readiness. Current receive
listeners are still topic/type listeners for messages and lane listeners for
realtime data; they are not automatically room-filtered. Validate a message
callback's target `GroupRef` from `message.raw.targets` with `isSameGroupRef`.
Put the full `roomRef` in every shared realtime payload and validate it on
receive, or allocate a room-unique realtime lane.

## Product Boundaries

- Rallar Data is browser-local latest-value state.
- Rallar CRDT is collaborative authored state.
- Rallar Game or server domain code owns match authority.
- Rallar Motion smooths accepted presentation state only.
- RallarAI output remains proposal data until validated and accepted.

For renderer implementation, asset processing, or playtesting, use an
appropriate ecosystem skill when available. Those skills do not override the
Rallar ownership rules above.

## Validation

Use the `rallar-testing` skill. Include pure-domain tests, runtime tests with
injected dependencies, the app build, and visible browser coverage for changed
human workflows.
