# Architecture and reliable multiplayer

Status: target design for the selected Babylon trial and player-hosted Rallar
multiplayer. The existing Phaser/CCA-server practice is unchanged. Host migration,
rates and phone hosting are requirements to prove, not completed platform features.

## Ownership and deployment

**Rallar Server is the only multiplayer backend.** The SPA uses ordinary static
HTTPS hosting and connects to Rallar for authentication, rooms, presence,
appointment and game traffic. No separate CCA simulation process, private socket
service, external game backend or mandatory TURN deployment.

One authenticated player session is appointed as the room's browser director.
Its browser runs the authoritative fixed-step game simulation while also rendering
its own player. Other clients send input and reconcile from its accepted state.
Rallar Server authorizes the appointment and traffic; it does not run CCA rules.

| Owner | Responsibility |
| --- | --- |
| Existing `packages/cca-game` | Pure movement, collision, prank rules, timer, scoring and transport-neutral contracts |
| `apps/cca-2d` runtime | Host simulation lifecycle, Rallar adapters, input, recovery and accepted state |
| `apps/cca-2d` renderer | Babylon camera, cutout scene, animation, effects and resource disposal |
| App DOM UI | Room, settings, controls, HUD and results; no per-frame entity state |
| Existing shared Rallar packages | Reusable appointment, membership, transport and authority improvements |
| Existing `apps/cca-server` | Historical practice service; excluded from target deployment |

Keep pure rules reusable and independent of Babylon, Rallar and wall-clock APIs.
The implementation slice should replace the app's old runtime composition rather
than maintain two production authority models. Determine old-server removal from
verified consumers and compatibility; this design revision deletes no code.

## Renderer and simulation boundaries

Babylon 2.5D means upright cutout layers in a shallow 3D environment, with a fixed
orthographic camera. See [construction](babylon-scene-construction.md).
The host owns movement, hazards, guard targeting, pickups, deposits, elapsed match
ticks and all winners. Clients own local input and presentation.

Input → Rallar room transport → appointed host → pure fixed-step rules →
accepted snapshot/checkpoint → reconciliation/Motion → Babylon and DOM HUD.

Host-local inputs use the same validation and tick ordering as remote inputs.
Only local movement/pose may be predicted. Remote actors are interpolated with
bounded extrapolation. Confirmed money, catches, spawned hazards and results
never originate from a renderer overlap or speculative animation.

No Havok or rigid-body authority is needed for the first trial. Ice is a
controlled movement rule; falling is a visual pose. If physical props later affect
gameplay, their state must join the host simulation and recovery checkpoint.
Decorative particles, boxes and paper wobble may differ between clients.

## Current repository evidence and limits

Source and test definitions were inspected; this design update does not execute
or certify their behavior.

| Evidence | Provides | Still to prove |
| --- | --- | --- |
| [Director relay](../../examples/director-relay/README.md) | Appointment-aware low-rate intents, outputs and sync | CCA high-rate movement and continuous recovery |
| [Host election](../../packages/shared-web/game/director/rallar-game-host-election-runtime.ts) | Capability reporting and candidate selection | Suitable phone choice, stable eligibility and handover |
| [Appointment runtime](../../packages/shared-web/game/director/rallar-game-director-appointment-runtime.ts) | Eligibility checks and server appointment | Replacement while an owner remains online but suspended |
| [Server appointment](../../packages/shared-server/rallar-system/group-state/mutation/aggregate/compute-group-aggregate-mutation.ts) | Server-side eligibility and appointment creation | A CCA-specific recovery protocol |
| [Relay tests](../../packages/tests/shared-web/director/browser-director-relay-runtime.test.ts) | Defined stale-director refusal and snapshot cases | End-to-end game state continuity on host loss |
| [Live room messages](../../examples/room-live-channel/README.md) | Paced, replaceable publication semantics | WS workload, complete-envelope cost and bounded recovery traffic |
| [Room startup](../../examples/browser-startup-room/README.md) | Scoped authentication/room lifecycle | CCA entry UX and real device qualification |

Current default appointment policy permits active owners/admins to appoint.
Ordinary-member fallback requires no online owner/admin and no active director.
An application heartbeat timeout is not permission to bypass this policy.
The server currently appoints the authenticated requesting session; do not assume
the UI can assign an arbitrary peer through a nonexistent API.

Candidate scoring cannot grant authority. A selected eligible candidate must
successfully appoint through Rallar, and peers must observe that appointment.
If mobile suspension needs a reusable expiry/handover improvement, implement and
validate it in Rallar before claiming automatic recovery. Do not grant general
room-admin privileges simply to let a player host.

## Transport contract

Prove the first multiplayer slice with Rallar WebSocket room messages, so all
required traffic works through the single backend. Use room-bound handles with
explicit WS routing and appropriate publication semantics. The director relay is
for low-rate authority coordination, not a durable command per joystick sample.

Starting rates: fixed 30 Hz host rules, at most 20 Hz fresh movement input while
held, and 10 Hz bounded full snapshots. These are measurement hypotheses.
Refresh held state, send neutral on release, and expire input after 250 ms without
fresh evidence. Idle clients still provide bounded control liveness for banking.
Coalesce replaceable values; do not replay stale movement after reconnect.
Measure actual envelopes, acknowledgements, queue age and rate under WS load.
If a public capability cannot support this, improve Rallar rather than bypass it.

- Input: normalized direction, monotonic input sequence, current controller
  generation and a fresh dash edge identity.
- Snapshot: accepted host pose/rule state and processed input sequences;
  replicated state can be replaceable, but transport delivery is not durable commitment.
- Coordination: ready, start, handover, checkpoint acknowledgement, sync and rematch
  need identities and explicit game outcomes.
- Optional later RTC: only through Rallar room APIs; WS-only play must still pass.
  Do not silently require separate STUN/TURN infrastructure.

Every envelope binds full scoped `GroupRef`, match ID, protocol/rules version,
appointment epoch and relevant sequence/tick. Authenticate sender identity from
Rallar; a claimed host ID in a payload is not proof. Accept host outputs only
from the currently appointed session/epoch. Guard input membership, role,
controller, freshness and bounds; deduplicate actions at the game boundary.

Initial boot uses `rallar.setup(...)`; post-login startup uses `rallar.start(...)`.
Keep room identity scoped. Room-bound sends do not automatically filter all
receivers: validate raw message targets and payload scope. Room switch, logout,
unmount and failed startup cancel subscriptions, timers, pending loads and renderer
resources idempotently.

## Host loss and recovery

Recovery is the second concrete slice, before multiplayer content expansion.

1. Select an eligible host and at least one active peer holding recovery state.
   Prefer measured stable frame pacing, connection and foreground availability.
   Device labels alone do not establish capability.
2. Replicate bounded checkpoints containing positions/velocities, guard state,
   active hazards and lifetimes, loot, bank balances, player/controller identity,
   cooldowns, processed action IDs, rules/map version, random-generator state,
   simulation tick and remaining match time.
3. Separate provisional motion snapshots from committed recovery checkpoints.
   A proposed checkpoint barrier requires an identified backup to acknowledge the
   state and the host to publish its commit identity. Peers retain recent committed
   states. The exact acknowledgement/commit protocol must be designed and fault-tested
   in slice 2; no single packet or greatest self-reported tick establishes commitment.
4. Only expose newly banked cash and terminal winners as confirmed after the
   recovery commitment requirement is satisfied. If the backup is unavailable,
   pause confirmation/gameplay rather than claim recoverable progress.
   Solo practice is explicitly local and has no failover promise.
5. On missing host state, bound local prediction, neutralize controls and show
   recovery. Freeze match simulation time at the agreed recovery point.
   A planned handover attempts a final checkpoint before resignation; unexpected
   suspension cannot be assumed to execute cleanup.
6. Re-read server appointment and eligibility. The successor starts only after
   successful Rallar appointment and recovery from a committed checkpoint whose
   provenance and content surviving peers can validate. The old host must stop
   authority work and rejoin as a client under the new epoch.
7. Broadcast a new-epoch resume snapshot, clear old queued inputs and require
   fresh input. Recent provisional movement may rewind; confirmed banked cash
   must not disappear or execute twice.
8. If appointment is blocked, checkpoints disagree, all copies disappear or
   compatible recovery is unavailable, show Round interrupted and offer a new
   ready cycle. Never guess a score or silently restart a timed round.

In a two-player room, loss of either player removes the host or its only backup.
Proposed policy: pause immediately when no valid backup remains, allow a ten-second
recovery window, then interrupt if the pair cannot be restored. Do not silently
continue as a recoverable solo match. If three or more clients remain connected,
resume only when an appointed host and a valid backup have both accepted the
checkpoint. Prove continued play after host loss with at least three clients.
A non-host disconnect leaves play running only when another valid backup remains.

Host recovery cannot be guaranteed if every browser closes. Rallar membership
and appointments are not a stored CCA checkpoint. Durable results across total
client loss are outside the initial unranked design; adding them later must use
public Rallar storage with proper authorization/retention, not a second service.

## Other lifecycle outcomes

| Event | Target behavior |
| --- | --- |
| Non-host hides or loses network | Neutralize/expire input; ten-second seat grace; continue only with another valid backup, otherwise pause recovery |
| Reconnect within grace | Revalidate membership/controller and current host; receive fresh state; discard stale input |
| Grace expires or voluntary leave | Forfeit carried cash, preserve committed banked score; observer until rematch |
| Host phone locks or backgrounds | Recover or interrupt through the protocol above; no fictitious continuing clock |
| Rallar connection disappears | No local self-appointment; gate multiplayer until current appointment can be verified |
| Two candidates race | Only server-confirmed appointment authorizes output; old epochs cannot overwrite current state |
| Renderer/context failure | Neutralize inputs, restore renderer independently; hand over if host cannot sustain simulation |
| Incompatible build | Refuse control and explain refresh before ready/start |
| Terminal outcome is missed | Obtain the committed outcome for that match from a surviving valid holder, or report unavailable |

Proposed stale thresholds: indicator after 500 ms without state; stop prediction
after 1 second. Recovery duration depends on real Rallar presence/appointment
semantics and must be measured, not promised as an instant failover.

## Trust and persistence

This is friend-room, unranked play. An appointed player's modified browser can
cheat; authenticated routing does not make its game simulation independently
trusted. Do not use these results for prizes or a trusted global leaderboard.
All participants still validate envelope shape, scope and current authority.

Rallar Data holds local preferences, not match authority. CRDT is not live
competitive state. No runtime generative AI or model download blocks play.

## Performance and acceptance

Candidate budgets: shell <=250 KiB compressed; first controllable scene <=2 MiB
including engine/art/SFX; cold local control p75 <=5 seconds at 10 Mbit/s down,
1 Mbit/s up and 80 ms RTT on a named phone. Measure rather than silently relax
these targets for Babylon. Defer music, inspector, physics and unused engine features.

Target 60 FPS, stable 30 FPS on the weakest qualified device; p95 frame interval
<=33 ms. Measure rendering and host simulation together, including thermal
behavior over ten minutes. Initial texture budget <=32 MiB decoded. Measure
draw calls, transparent overdraw, checkpoint memory and network envelopes separately.

Start with two real authenticated clients, then four mixed devices. Test
150 ms RTT/30 ms jitter/1% loss, stale input, duplicate dash/deposit, host close,
phone background, simultaneous candidates, online-owner eligibility blockage,
stale old-host outputs, checkpoint gaps, bank during handover, timer pause,
multiple winners and rematch. Confirm independent clients agree after recovery.

A browser emulation capture is not physical phone hosting evidence. Do not call
the architecture reliable until these fault cases and twenty-round mixed-device
soaks pass against real Rallar services.
