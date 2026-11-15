# Architecture and reliable multiplayer

Status: proposed architecture with an explicit early feasibility gate. This document
does not claim the existing platform already satisfies CCA's rates or recovery needs.

## Selected approach and tradeoffs

Propose Phaser + TypeScript + Vite for the 2D playfield, React/DOM for the application
shell and accessible controls, and Rallar for all application communication. Keep
the simulation independent of Phaser and React. Use the current repository's
language, formatter, test, and package standards rather than the old CCA plan's tooling.

Choose a server-owned match. It accepts bounded intent and owns movement, collision,
guard decisions, pickups, banking, time, and results. No player's browser is a
director. This costs server capacity and deployment work, but avoids making phone
backgrounding or host departure a room-wide failure.

Browser-director play would reduce server simulation work but adds authority
migration and makes mobile lifecycle a match dependency. Peer lockstep would add
synchronization and slow-peer problems. Neither is the initial recommendation.
Server authority still requires failure handling; it is not a promise of uptime.

## Proposed owners

These are future paths, not existing implementations or a scaffolding instruction.

| Owner                           | Responsibility                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cca-2d`               | Canonical pure rules, collision, configuration, snapshot/input schemas, deterministic tests; consumed by browser prediction and server |
| `packages/cca-2d/server`        | Game-specific authoritative runtime and lifecycle; server-only import boundary                                                         |
| `apps/cca-2d`                   | Composition, Rallar runtime adapter, Phaser presentation, input, React shell, shipped assets                                           |
| `apps/cca-2d-server`            | Thin deployment composition of the game owner and public Rallar server capabilities                                                    |
| Existing shared Rallar packages | Reusable authority, transport, room, ordering, admission, Motion, and lifecycle improvements                                           |
| `packages/shared-test`          | Reusable black-box game protocol fixtures and distributed scenarios                                                                    |

One lifecycle-owned browser runtime connects accepted state to presentation. React
subscribes to low-frequency view state; entity poses are not copied through React
every frame. Phaser renders accepted/predicted poses and emits input actions; scene
callbacks do not decide scores or authoritative collisions.

Keep the representative path direct:

```text
touch / keyboard / mouse
  -> normalized player intent
  -> Rallar authenticated room transport
  -> game authority validates and advances pure rules
  -> accepted snapshot / outcome
  -> browser reconciliation + Rallar Motion
  -> Phaser world and DOM score/connection state
```

## Current repository evidence and limits

Inspected source and focused test definitions on 15 November 2026; tests were not
executed for this design-only task. Reinspect before implementation.

| Evidence                                                                                                                                                                                                  | What it establishes                                                                              | What it does not establish                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [Browser setup and rooms](../../examples/browser-startup-room/README.md)                                                                                                                                  | Existing auth, scoped room entry, invitation, and room handles                                   | CCA onboarding speed or guest multiplayer                                             |
| [Authority client](../../packages/shared-web/game/authority/rallar-game-authority-client.ts) and [tests](../../packages/tests/shared-web/rallar-game-authority-client.test.ts)                            | WS authority commands, scope checks, accepted snapshots, pending outcomes; receipt-tracked sends | Affordable continuous input at CCA rates or measured latency                          |
| [Authority server installer](../../packages/shared-server/game/install-rallar-game-authority-server.ts) and [tests](../../packages/tests/shared-server/game/install-rallar-game-authority-server.test.ts) | Server command/sync topics, envelope validation, snapshot publication                            | A ready-made game loop, durable CCA lifecycle, capacity, or automatic server failover |
| [Server-authoritative example](../../examples/server-authoritative-game/README.md)                                                                                                                        | AppInbox-owned mutation and retry pattern, current Relic consumer                                | A high-frequency action-game implementation                                           |
| [Motion example](../../examples/motion-smoothing/README.md)                                                                                                                                               | Existing smoothing concepts and presentation boundary                                            | Correct CCA collision or a current copy-paste boot configuration                      |

Some examples and skill maps have older API shapes or filenames. Follow current
public source/tests and the initial setup rule below. In particular, do not copy
bare room identity or a historical lane configuration from an example without checking it.

The receipt semantics of the authority client are a specific feasibility risk.
Do not send every joystick sample through an expensive durable operation merely
because the generic command method accepts a payload. Inspect acknowledgement
audiences, coalescing, queue bounds, stale-message expiry, and publication cost.
Any needed generic improvement belongs in Rallar, with focused tests and public
surface review, rather than an app-local socket or a private transport fork.

## First practice implementation

The first app consumes Rallar room-bound live messages for input and reserved
server-only room publications for snapshots. This uses existing public APIs rather
than receipt-tracked game commands for every joystick sample. The room helper was
fixed to preserve the caller's live publication policy. Inputs retain only the
newest value at 50ms cadence with an 8KiB envelope drain budget; the complete message is
limited to 8KiB at server ingress. The 2KiB initial drain budget was too small for
the full Rallar envelope, so uplink targets require measurement and optimization.

Practice has one ephemeral server owner, two seats per room, sixteen-room capacity,
and no persisted game state or results. Rallar authenticates and authorizes room
traffic; scores and pickups belong to the server simulation. This deliberately
implements the requested four-verb practice slice, not the complete round-lifecycle
contract below. Production ownership fencing, terminal results, prediction/replay
and impaired-network qualification remain release work.

## Transport and authority contract

Use the existing server authority path over Rallar WS for the first slice. RTC is
not required for admission or core play. Peer RTC cosmetics or accepted-snapshot
repair may be considered later only if useful and validated; peers never mint
authoritative snapshots. Do not introduce a second networking service or raw
WebSocket/WebRTC implementation in CCA.

Starting workload hypothesis: 30 simulation ticks/second, input updates capped at
20/second while movement or Bank is held, and 10 full snapshots/second. Refresh
unchanged held state at that cadence too: a sustained direction and a stationary
0.9-second Bank hold both need fresh input. Send prompt neutral input on release
and expire server-held input within 250 ms without fresh samples. Idle neutral
players need no 20 Hz gameplay stream. Measure the full active-player refresh load,
not only direction-change traffic.
Snapshots begin as bounded full state; deltas/binary encoding require measurements.

Separate delivery semantics:

- Movement and held Bank state: replaceable, expiring input with controller
  generation and monotonic sequence. Drop stale queued input instead of replaying
  it after reconnect. Queue pressure must be visible and bounded.
- Dash: a sequenced action edge with bounded identity, cooldown enforcement, and
  freshness. Repeated delivery cannot cause another dash; old edges are discarded.
- Join runner, ready, start, takeover, and rematch: validated commands with exact
  identity and outcome semantics. Transport admission is not game acceptance.
- Deposits and catches: consequences of server simulation, never client-submitted
  positions, balances, or victory claims. Snapshots carry enough accepted outcome
  information to resolve a missed event without granting the effect twice.
- Sync: fresh authorized full snapshot including the current round and controller
  status. A delayed old command acknowledgement cannot replace newer state.

All shared payloads bind the full `GroupRef`, match ID, protocol/rules version,
authority incarnation, and appropriate tick/sequence. Existing envelopes should
own identity/order where they already do; extend a canonical contract if essential
scope is absent, rather than creating competing fields. Validate authenticated
sender/session, player role, active membership, controller generation, bounds,
freshness, and match phase before game logic. Recheck revocation during long rounds.

Initial boot uses `rallar.setup(...)` once. After login use `rallar.start(...)`.
Keep scope and any lane options defined before connecting. Use room-bound message
handles; validate full room targets on receive because a room-bound send handle
does not by itself filter every listener. Room/session change aborts old work and
disposes subscriptions, audio, Motion buffers, and renderer resources idempotently.

## Authoritative lifetime and persistence

Propose a bounded, server-owned live simulation for an ephemeral unranked round.
It is the sole owner of live match truth, not a browser cache or a durable-state
cache pretending to be authoritative. Database-backed admission and any persisted
round lifecycle/results must use AppInbox; follow the canonical
[service rules](../../.agents/skills/rallar-code-writing/references/convergent-service-writing.md).
Do not write a database row or create a durable receipt for every render tick.

One game owner serves each match incarnation. The initial deployment can have one
game-owner process with a bounded room limit; this is a stated availability limit.
Multiple API processes must not accidentally instantiate multiple simulations.
Use a server-owned current-round binding to fence ownership, match incarnation,
controller generation, and admission; creation/replacement and any persisted
terminal outcome use AppInbox conditional writes. Do not invent an app-local lease
service. If public Rallar cannot support that binding cleanly, the first slice must
establish the smallest reusable capability before expanding the game.

Persist only the minimal round binding and terminal outcome needed for reconnect
and ambiguous-result resolution; no progression or permanent leaderboard. Register
their room-owned retention through Rallar. Normal outcomes remain available for the
room's retention lifetime, including across a game-owner restart. A crash in an
active, uncheckpointed simulation interrupts that round; it cannot recreate a
plausible result. A finished screen is confirmed only after its terminal outcome
is committed, not merely when an in-memory timer expires.

Validate current room admission and authority at control boundaries and through
bounded ongoing checks. Revocation must stop new input acceptance and snapshot
access; room disappearance interrupts the match. Define the exact owner/expiry
binding and ingress authorization implementation in the first slice from current
Rallar capabilities. Never assume that trusting a client-supplied server ID fences
two writers.

Rallar Data stores local preferences only. CRDT has no role in match state. No
runtime AI, model download, or generated arena blocks the first round.

## Prediction and presentation

Predict only the local runner's movement and dash pose using the same pure movement
rules. Reconcile from accepted position and last processed input sequence; discard
acknowledged inputs and replay only still-valid input. Keep the replay buffer bounded.
Remote players and guards use interpolation; cap extrapolation and show connection
trouble rather than letting characters travel indefinitely without evidence.

Initial interpolation target is 100–150 ms, tuned against jitter and corrections.
Small local errors may blend; catch, respawn, room change, and large errors reset
presentation. Never interpolate through a solid wall to hide correction. Banked
scores and catches use accepted state only. Cosmetic feedback must distinguish
“pressed” or “pending” from “succeeded.”

## Disconnection and recovery

| Event                                               | Required outcome                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser hides, blurs, opens menu, or loses pointers | Neutralize locally; server expires held input within 250 ms even if no final packet arrives; the round continues                               |
| Network disappears                                  | Runner remains vulnerable and stationary after input expiry; no immunity or automatic bank; keep its seat for 10 seconds                       |
| Reconnect within 10 seconds                         | Authenticate, revalidate admission/controller, receive fresh state, clear old inputs, resume existing runner and any intervening catch/respawn |
| Reconnect after 10 seconds                          | Forfeit carried bag, preserve banked score, remove runner; return as spectator until rematch                                                   |
| Departure/removal                                   | Forfeit bag and runner seat; revoke old controller and prevent further input                                                                   |
| Second browser requests takeover                    | Explicit server-accepted generation change; old controller becomes observer; no second runner                                                  |
| Snapshot gap                                        | Request one bounded resync flow; never substitute a peer's invented result                                                                     |
| Renderer/context failure                            | Neutralize controls; attempt bounded renderer restoration and sync; otherwise offer return to room without changing server score               |
| Game-owner crash                                    | Active round becomes interrupted when loss is established; no winner; server recovery permits a new ready cycle, not silent old-round replay   |
| Terminal result acknowledgement is lost             | Read the committed outcome for that exact round; show Results only when confirmed                                                              |
| Old build returns                                   | Explain refresh requirement; refuse incompatible control before ready/start                                                                    |

Proposed client stale-state thresholds: connection indicator after 500 ms without
fresh snapshots; stop prediction and gate input after 1 second. At 10 seconds show
Retry/Return actions, but do not label a local outage as a globally interrupted
round until the server confirms it. Group-scoped authority incarnation plus match
identity rejects stale publication after a restart. There is no promised seamless
server migration in the first release.

## Performance and loading budgets

All numbers below are candidate gates, not results. Measure them in the first two
slices and revise explicitly if hardware or evidence requires a different target.

| Measure                          | Proposed acceptance target                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial shell transfer           | At most 250 KiB compressed JS before the renderer chunk                                                                                     |
| First playable transfer          | At most 2 MiB total compressed resources, including shell, renderer, map, critical art and SFX; music deferred                              |
| Cold actionable shell            | p75 at most 2.5 s on named phone with empty cache, 10 Mbit/s down, 1 Mbit/s up, 80 ms RTT                                                   |
| Cold local practice controllable | p75 at most 5 s in the same profile, after navigation; no authentication time hidden in this number                                         |
| Online entry                     | Report sign-in, room admission, assets, and match sync separately; restored-session ready-to-control p75 at most 3 s after assets are ready |
| Rendering                        | Target 60 FPS; low tier stable 30 FPS; p95 frame interval at most 33 ms on the weakest qualified device                                     |
| Game server                      | p95 simulation step under 4 ms at six players on named server hardware; publish admitted room capacity from load tests                      |
| Snapshot                         | At most 8 KiB at six players; average downlink under 100 KiB/s per client at target cadence                                                 |
| Input                            | Average uplink under 10 KiB/s per client; bounded queue age/count under impairment                                                          |
| Textures                         | At most 32 MiB decoded runtime texture allocation in the first release                                                                      |
| Soak                             | Twenty consecutive rounds without growing live scene/listener counts; inspect retained memory after warm-up                                 |

Record asset transfer, parse/decode, GPU texture allocation, frame pacing, server
CPU, transport overhead, and queue age separately. Do not equate compressed file
size with decoded memory. Use capped device-pixel ratio and reduced cosmetic effects
before sacrificing threat visibility or control responsiveness. Cache hashed assets;
do not add a service worker to the initial release merely to conceal a slow cold load.

## Reliability evidence required before release

Test two and four real clients first, then six and multiple concurrent rooms up to
an advertised capacity. A healthy run and impaired runs must use real Rallar
services. Include 80/150/250 ms RTT profiles, jitter and packet loss, reconnect,
duplicated/reordered application messages, wrong scope/match/controller, simultaneous
pickup, catch during deposit, deadline, server restart, and missed terminal outcome.

For the 150 ms RTT / 30 ms jitter / 1% loss profile, propose 20 consecutive complete
four-player rounds with identical accepted results, no duplicate bank, and no stuck
input. Target reconnect to current state within 3 seconds after connectivity and
authentication recover. In the 250 ms profile, require truthful degradation and
bounded queues; do not promise competitive fairness without playtest evidence.

Fault-injection must identify which transport is affected. Browser offline mode
alone is not proof of impaired RTC; if RTC is introduced, use the Rallar distributed
fixtures or OS-level shaping that actually affects that path. Keep failure artifacts
redacted and bounded. No silent player telemetry is required for this design.
