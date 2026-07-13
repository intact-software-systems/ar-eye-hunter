# Cash Chase Arena — Engineering Standards

Updated: July 13, 2026

## Document authority

This document is the engineering-policy source of truth for Cash Chase Arena
(CCA). It applies to `packages/cash-chase-arena`, `apps/cash-chase-arena`, CCA
tests, and any generic Rallar capability added for CCA.

Product outcomes remain authoritative in
`Cash_Chase_Arena_Product_Owner_Document.md`; runtime and dependency boundaries
remain authoritative in `Cash_Chase_Arena_Rallar_React_Three_Plans.md`; task
order remains authoritative in `Cash_Chase_Arena_Implementation_Plan.md`.

When this document conflicts with a nearby implementation pattern, preserve
existing public compatibility and record the exception. Do not silently copy a
weaker pattern into new CCA code.

## Engineering principles

- Rallar owns application communication, scoped identity, room membership,
  election, appointment, ordering, readiness, fallback, diagnostics, Motion,
  approved local Data, AI lifecycle, and CRDT collaboration.
- CCA owns only game rules, game payloads, presentation, input, content, and the
  adapters needed to compose public Rallar APIs.
- Keep one canonical implementation of every algorithm. Workers, renderers,
  React components, and Rallar adapters translate to or from that
  implementation; they do not reimplement it.
- Prefer explicit, reviewable branches over compact or clever code when
  correctness depends on identity, scope, authority, ordering, expiry, or
  delivery guarantees.
- Optimize only from representative profiles or benchmarks. A static concern is
  a hypothesis until measured.
- Add no runtime dependency without a documented capability gap, alternatives,
  bundle/runtime cost, lifecycle owner, license, and removal plan.

## Module and dependency rules

### Pure package

`packages/cash-chase-arena`:

- contains deterministic rules, protocol payload types and validators,
  configuration, snapshots, checkpoints, arena/content validation, and
  renderer-neutral presentation derivation;
- may import only platform-neutral TypeScript modules and deliberately approved
  shared contracts;
- must not import React, a renderer, browser globals, storage, Rallar browser or
  server runtime code, AI providers, or transport implementations;
- exposes public consumer concepts deliberately through `mod.ts`;
- keeps internal helpers unexported unless a real consumer or testable package
  contract requires them.

### Browser app

`apps/cash-chase-arena`:

- composes public Rallar facades and the pure CCA package;
- keeps React on low-frequency DOM state and out of simulation and per-frame
  transforms;
- keeps renderer, audio, worker, Rallar, input, and UI ownership in separate
  focused modules;
- does not deep-import Rallar internals to avoid using a public API;
- moves reusable generic capability into the appropriate Rallar package instead
  of duplicating it locally.

### Code shape

- Use pure data-in/data-out functions for validation, parsing, simulation,
  derivation, routing decisions, hashes, policies, and setup conversion.
- Use a factory returning a narrow plain interface for private mutable behavior
  that does not require inheritance or complex lifecycle coordination.
- Use a class only when it owns a long-lived lifecycle, subscriptions,
  connection state, caches, browser resources, or persistence.
- Inject clocks, RNG state, IDs, transports, repositories, storage, loggers,
  retry policy, workers, and renderer/audio factories through explicit options.
- No ambient singleton mutable game state.
- Normalize and validate unknown data once at the boundary, then pass typed data
  internally.

## TypeScript and naming rules

- Use strict TypeScript and explicit `Readonly` inputs, outputs, and public state.
- Use discriminated unions and narrow result objects for status-heavy behavior.
- Do not use unreviewed `any`, unchecked casts, or non-null assertions at
  protocol, storage, worker, AI, or Rallar boundaries.
- Prefer `unknown` plus a validator at untrusted boundaries.
- Name units explicitly: `tick`, `durationTicks`, `timeoutMs`, `sentAtEpochMs`,
  `positionMillimetres`, and `yawTurnUnits` rather than unitless time or scalar
  names.
- Keep transport identity separate from display names. Use `peerId`,
  `participantId`, `matchId`, `roomRef`, and `directorEpoch` consistently.
- Use descriptive domain names; abbreviations are limited to established terms
  such as RTC, RTT, HUD, RNG, GLB, and AI.
- Comments explain invariants, compatibility constraints, or surprising
  decisions. Do not narrate obvious assignments.

## Deterministic simulation contract

### Time, numbers, and ordering

- The authoritative clock is an integer simulation tick at the configured fixed
  rate. Wall-clock time never changes a simulation outcome.
- Convert durations to integer ticks before match start. Do not accumulate
  floating-point frame deltas in authoritative state.
- Validate finite input numbers, clamp them, and quantize once at the simulation
  boundary.
- Initial authoritative quantization is 1 millimetre for linear position and
  1/4096 of a turn for yaw. Tuning may change these values only through a
  protocol/configuration version and parity fixtures.
- Quantize authoritative position, velocity, and orientation after each mutation
  that could introduce floating drift. Presentation may use unquantized floats.
- Do not use locale, platform time, object property enumeration, unstable sort,
  or arrival order to decide gameplay.
- Sort participants, entities, collisions, simultaneous events, and input
  application by explicit stable keys before resolving ties.
- Use a named seeded 32-bit RNG algorithm with serializable unsigned state. The
  MVP algorithm is `xorshift32`; an input seed/state of zero normalizes to
  `0x6d2b79f5` before the first step, and fixture tests lock the resulting
  sequence.
- Authoritative trigonometric results are quantized immediately. If the agreed
  Node/Chromium/Firefox/WebKit parity fixture differs, replace the operation with
  an integer or lookup-table implementation before Gate 1 exits.

### Hashes and serialization

- State hashes use one canonical field order, stable entity ordering, explicit
  integer/quantized scalar encoding, and `fnv1a64-v1` over the canonical UTF-8
  bytes, formatted as 16 lowercase hexadecimal digits.
- The state hash is a deterministic corruption/parity sentinel, not a
  cryptographic authenticity proof or anti-cheat boundary.
- Do not treat ordinary `JSON.stringify` of arbitrary objects as a canonical
  state encoding.
- Derived presentation values, transient diagnostics, wall-clock timestamps,
  and cache contents do not participate in authoritative hashes.
- Snapshot/checkpoint restore reconstructs or clears every derived cache; no
  hidden state may survive restore.
- Equal seed, configuration, ordered inputs, protocol version, and tick count
  must produce the same hash in Node and all supported browser engines.

## Protocol and compatibility policy

- Every CCA message, worker message, snapshot, checkpoint, setup commit, content
  manifest, and state hash declares its schema or protocol version.
- Major protocol versions are exact-match within an active room. A client with
  an unsupported major version remains in the lobby with an actionable refresh
  or incompatibility message.
- Validators reject unknown discriminators, forbidden trusted fields, non-finite
  numbers, excess properties where they could conceal trusted data, and payloads
  above their documented bounds.
- Optional additive fields are compatible only when their absence has a defined
  default and the validator explicitly permits them.
- A room pins `protocolVersion`, `simulationVersion`, `contentManifestVersion`,
  `compatibilityId`, and the director build identifier in `SetupCommit`. They
  cannot change during a round or migration. Participant build identifiers may
  differ only when an explicit compatibility fixture permits the pair.
- Checkpoint restore supports only explicitly listed schema versions. Unsupported
  checkpoints interrupt the round without a result.
- Any supported rolling deployment must include compatibility tests against the
  previous supported client. Otherwise deployment is hard-cut: cached old
  clients must refresh before readying.
- Protocol changes require a decision record, fixture changes, public API
  review, and mixed-version failure tests.

## Error and lifecycle model

### Errors

- Expected operational failures return a typed discriminated result with a
  stable code, retryability, user-safe summary, and bounded diagnostic context.
- Exceptions indicate programmer errors, violated internal invariants, or
  impossible states. Error boundaries convert them into a safe fatal state.
- Stable error families are `CCA-AUTH`, `CCA-ROOM`, `CCA-READY`, `CCA-RTC`,
  `CCA-PROTOCOL`, `CCA-WORKER`, `CCA-RENDER`, `CCA-AUDIO`, `CCA-RECOVERY`, and
  `CCA-STORAGE`.
- User messages never expose tokens, credentials, raw SDP/ICE data, full payloads,
  provider prompts, or stack traces.
- No catch block may silently discard a failure. It must return, transition,
  retry under a bounded policy, or emit a capped diagnostic.

The common public shape is:

```ts
export type CashChaseOperationError = Readonly<{
  code: `CCA-${string}`;
  retryable: boolean;
  summary: string;
  diagnostic?: Readonly<Record<string, string | number | boolean>>;
}>;

export type CashChaseOperationResult<T> =
  | Readonly<{ status: "ok"; value: T }>
  | Readonly<{ status: "error"; error: CashChaseOperationError }>;
```

Each domain narrows the code union; arbitrary runtime strings are not a substitute
for a documented code.

### Cancellation and disposal

- Every long-running start/load/join/setup operation accepts or owns an
  `AbortSignal` or equivalent generation token.
- Room switch, logout, match replacement, unmount, and dispose invalidate prior
  generations. Stale asynchronous completion must not mutate current state.
- `dispose()` and `stop()` are idempotent and safe after partial initialization.
- Every subscription, timer, animation frame, worker, message listener, Motion
  track, audio node/context, renderer object, GPU resource, and WebGL event
  listener has exactly one disposer owner.
- Disposal runs in reverse ownership order and remains bounded when one disposer
  fails.
- Worker and main-thread message queues are bounded. Catch-up work is capped;
  background recovery pauses instead of simulating an unbounded backlog.

## Browser lifecycle policy

- `visibilitychange`, `pagehide`, `pageshow`, offline/online, auth expiry, RTC
  degradation, audio interruption, and WebGL context loss are explicit runtime
  events with tested transitions.
- A backgrounded non-director stops sending edge actions and resumes through
  current-state validation. A backgrounded director triggers the same stale and
  migration policy as an unhealthy director when freshness expires.
- WebGL context loss pauses presentation, not simulation authority. Recovery
  rebuilds renderer-owned resources from the latest presentation frame or shows
  an actionable fallback.
- Audio resume always requires browser-compliant user activation and cannot block
  gameplay or communicate essential state alone.

## Rallar composition rules

- Use `GroupRef`/`roomRef` whenever application/workspace scope matters.
- Prefer `rallar.realtime.room<T>(...)`, `rallar.messages.room<T>(...)`, and
  Rallar Game handles before lower-level readiness or send primitives.
- Rallar envelope sender, room, match, sequence, send time, and appointment epoch
  are the transport source of truth. CCA payloads do not duplicate trusted
  identity or ordering fields.
- Rallar Game owns capability reporting, election, appointment, lanes,
  backpressure, ordering, readiness, sync, results, and generic migration
  orchestration.
- Rallar Motion owns presentation smoothing only. Rallar Data owns approved local
  latest-value state only. Rallar AI outputs proposals only. Rallar CRDT owns
  authored collaboration only.
- A missing generic Rallar capability is implemented and tested in its Rallar
  package with public compatibility checks before CCA consumes it.

## Diagnostics and observability

- Diagnostic events are structured, bounded, and tagged where available with
  `roomRef`, `matchId`, `participantId`, `directorEpoch`, `tick`, build ID, and
  stable error/event code.
- Severity is one of `debug`, `info`, `warning`, or `error`; user-visible status
  is derived separately.
- Do not log per-frame transforms or every input in normal operation. Use sampled
  counters, histograms, and bounded trace capture.
- Cap local logs by entries, bytes, and TTL. Redact secrets, player text where not
  required, IP-like addressing, SDP, ICE credentials, and AI prompts.
- Operator diagnostics show authority freshness, backup, epoch, lane readiness,
  egress, RTT, snapshot age/size, worker tick, Motion mode, renderer resources,
  audio voices, and recovery phase.
- Product telemetry remains off until consent, purpose, field list, aggregation,
  retention, deletion, and export policy are separately approved.

## Testing and review rules

- Write behavior tests before implementation for new game rules, protocol
  behavior, recovery paths, and regressions.
- Use deterministic seeds, fake clocks, fake providers/repositories, and thin
  Rallar fakes. Do not make pure tests depend on live time or services.
- Test observable outcomes and invariants, not private call order.
- Required layers are pure unit/property tests, worker parity tests, Rallar
  adapter tests, multi-context browser tests, black-box recipes, visual QA,
  accessibility checks, performance/traffic measurement, and soak tests.
- Add fuzz/property cases for validators, arenas, input sequences, checkpoint
  corruption, migration ticks, and simultaneous-event ordering.
- Every public Rallar surface change includes API snapshots, browser bundle
  boundaries, focused package tests, and existing game consumer builds.
- Reviews start with correctness and boundary violations, then lifecycle,
  security/accessibility, and measured performance. Style-only comments do not
  obscure higher-severity findings.

## Tooling and formatting

- CCA uses the repository TypeScript, Vite, Vitest, Playwright, ESLint, and
  Prettier toolchain; it does not introduce a competing formatter or test runner.
- Gate 0 selects the exact CCA formatting/lint configuration paths and commands;
  the first pure-package scaffold checks in `prettier.cca.config.mjs` and
  `eslint.cca.config.mjs`, and each workspace exposes `format:check`, `lint`,
  `typecheck`, `test`, and `build` scripts where applicable.
- Formatting is automatic and non-negotiable; style choices are not manually
  re-litigated in reviews.
- Static boundary checks enforce forbidden imports/globals, no raw game
  transports, no app-local election/lease, and no server/local match authority.
- Lockfile changes are reviewed with dependency changes. Production dependencies
  must be pinned through the existing workspace policy.

## Product validation discipline

- Every playtest records the exact client/Rallar build, protocol/configuration,
  arena seed, browser/device/network profile, participant count, and facilitator
  script.
- State the product hypothesis before the session. Gate 4 prioritizes lobby
  success, objective recognition within 5 seconds, completion, rematch intent,
  route/cash-out diversity, and whether spectating remains understandable.
- Separate observed behavior from participant opinion and facilitator inference.
  Do not tune from one anecdote without recording it as a hypothesis.
- Collect only consented fields. Redact exports, define who can access them, and
  delete them on the schedule named in the playtest protocol.
- A renderer or AI feature cannot compensate for an unclear or unfun debug core
  loop; Gate 5 requires recorded product evidence, not implementation momentum.

## Security, dependencies, and assets

- Validate authentication, scope, sender, phase, authority epoch, ordering,
  coordinates, rates, cooldowns, proximity, counts, sizes, and text before
  mutation.
- Room-trusted browser-director play is not an anti-cheat boundary. Do not add
  ranked, durable, or reward-bearing outcomes without Rallar server authority.
- Apply CSP and explicit allowed origins appropriate to the selected renderer,
  workers, Rallar endpoints, and assets. Keep provider and TURN credentials
  server-side.
- Review direct and transitive dependency licenses and known vulnerabilities
  before release. Record exceptions and mitigations.
- Every shipped asset has recorded source, license, authoring/export version,
  compression settings, cache key, size budget, and deterministic fallback.
- Generated content is proposal data until schema and domain validation accept
  it; generated HTML is never rendered.

## Release and decision governance

- Record material decisions as short ADRs under
  `apps/cash-chase-arena/docs/decisions/` once the app exists. Status is
  `proposed`, `accepted`, `superseded`, or `rejected`.
- Initial ADRs cover authority/trust/migration, deterministic numeric encoding,
  protocol compatibility/deployment, and the measured renderer choice.
- Staging records client build, Rallar server build, protocol versions, browser
  versions, ICE/TURN mode, renderer, reference hardware, and test recipe.
- Release requires a rollback path, cache invalidation policy, health checks,
  supported-browser matrix, TURN capacity check, and explicit resolution of
  skipped live tests.
- A feature flag may disable optional renderer effects, AI, or diagnostics
  capture. It cannot change authoritative rules or protocol interpretation
  during an active round.

## Definition of ready for implementation

Gate 1 implementation may start when:

- the product, architecture, presentation, implementation, prompt, review, and
  engineering-standards documents agree;
- gameplay lifecycle and tie-break rules are explicit;
- deterministic numeric/hash fixtures and supported engine matrix are defined;
- protocol version and hard-cut deployment behavior are accepted;
- CCA formatting, linting, type-check, test, and boundary commands are named;
- no unresolved runtime framework dependency is assumed.

Renderer work may start only after the debug core loop is worth continuing and
the migration feasibility spike proves checkpoint delivery, acknowledgement,
promotion, restore, higher-epoch rejection, and bounded abort without 3D.
