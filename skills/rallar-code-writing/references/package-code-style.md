# Rallar Package Code Style

## Core Preferences

- Favor single-purpose modules with exported functions, constants, and explicit `Readonly` types.
- Keep public inputs and outputs obvious; avoid functions that secretly read mutable process or browser state.
- Use discriminated unions and narrow result objects for status-heavy behavior.
- Keep helpers close to their domain, then export through existing barrels only when the API is meant for consumers.
- Preserve existing exports and import paths unless removal is explicitly requested.

## Functional First

- Prefer data-in/data-out helpers for validation, parsing, routing, snapshot derivation, topology keys, hashes, diagnostics, policies, and game rules.
- Normalize data near the boundary, then pass typed values through the rest of the flow.
- Compose small helpers rather than adding broad manager modules.
- Keep deterministic helpers in shared packages when both apps and packages can reuse them.

## Stateful Code

- Stateful objects are acceptable for repositories, read-through caches, facades, queue/runtime services, browser adapters, server middleware, WebSocket/RTC coordination, and persistence.
- Stateful code should isolate ownership: callers should know which state it owns, how to create it, and how to observe or dispose of it.
- Prefer constructor or factory options for dependencies such as `now`, storage, repositories, loggers, sockets, providers, and retry policy.
- Do not add ambient singleton state unless the package already exposes that repository/cache pattern.

## Testability

- Add behavior tests for generated code, especially edge cases, retries, idempotency, scoped identity, expiry, routing, and fallback paths.
- Use deterministic seeds, fake providers, fake repositories, and injected clocks instead of relying on real time or live services.
- Tests should prove observable product behavior, not only implementation details.
- When changing a public package surface, add regression tests that fail against the previous behavior.

## Reuse Before New Code

- Search for existing helpers before adding one: scoped group identity, RallarAI schema/provider utilities, state sync routing, motion buffers/gates, game authority, repositories, graph/topology, and test harnesses.
- Prefer adding a narrow helper in the existing domain folder over creating a new top-level concept.
- Keep app code thin when package code can own reusable behavior.

## Human Readability

- Use descriptive names over compact cleverness.
- Keep branch conditions explicit when correctness depends on scope, expiry, authorization, or delivery guarantees.
- Use comments sparingly for non-obvious invariants; avoid narrating obvious assignments.
- Split large facades internally by domain while preserving external compatibility.
