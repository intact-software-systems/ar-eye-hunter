# Development sequence, agents, and tools

Status: revised for the selected Babylon 2.5D and Rallar player-host direction.
The local Babylon trial, expanded square, personality pranks, three major incidents and ten-police chase/freeze/rescue loop are implemented. Phone feel and physical-device qualification remain open. The completed expansion retains its two-slice record; the Rallar gate below remains the next technical outcome.

## Existing foundation and change of direction

The [local Babylon trial](babylon-local-trial.md) now replaces the Phaser entry.
It implements movement, dash-and-drop, slippery surfaces, camera zoom and pause/reset,
plus six interactive owners, fruit spills, fountain spray, a rolling cart, cleanup,
powder, mini-zappers, birds/dogs/cats, bins/fish/toilet/hydrant, stains/washing,
a +50 bonus and ten-officer raids, plus a clearly labelled local bot companion.
It includes real browser captures and focused rule/browser tests. The historical
server prototype remains outside the app. Optional Rallar social entry and the first
shared player-hosted match are now implemented. Real-browser tests cover three-player
host-close succession and two-player recovery timeout; reconnect seat grace,
background-host behavior and full-round qualification remain under development.

The new visual target is [cutout market](visual-concepts/README.md), with a
[construction recipe](babylon-scene-construction.md). Retire the old square frame,
pixel-grid asset rules and separate Bank input in the trial. Carry forward useful
pure rules and input lessons, not the old authority boundary.

## Completed foundation: town square and major incidents

The user requested: **plan it in docs, implement it and provide a playable trial**.
The [town-square expansion plan](town-square-expansion.md) records the two implemented slices, with final acceptance and publication below:

1. A recognizable town with varied buildings, ordinary street furniture and the
   endorsed grumpy personalities/routines, preserving broad playable routes.
2. Fire-department response, a large poop bomb and an original absurd vomit event,
   with bounded effects, counterplay, real phone-sized captures and a working preview.

The earlier living-square/ten-police slice is implemented and remains the baseline.
The expanded request moves networking after this content iteration; it does not
remove the Rallar-only host/recovery requirements or claim networking is complete.

## Current next outcomes

The [multiplayer plan](rallar-multiplayer.md#first-live-shared-match-integration)
records the real ready/start/shared-movement flow. The next two concrete outcomes are:

1. Complete checkpoint/reconnect/host-succession reliability and full-round shared
   interaction, rescue, results and rematch browser evidence.
2. Qualify secure phone access, mixed viewport controls and phone hosting, then
   complete the existing draft PR's release validation.

## Release gate: Rallar-only hosting and recovery

**Outcome:** two authenticated players share the scene using only Rallar as
multiplayer backend, with one appointed browser running the rules.

Keep the separate historical CCA server outside the selected app composition.
Use Rallar WS room transport first, bounded input/snapshot publication, accepted
appointment/epoch validation and client reconciliation. Establish the checkpoint
commit protocol before promising retained scores across host loss.

Socket-close cleanup now permits a verified eligible successor under the existing
appointment policy. Still reproduce an owner host that backgrounds while appearing online
and prove authorized recovery or a bounded interruption.
Any generic missing capability belongs in Rallar and its focused tests; do not
bypass authorization or promote everyone to room admin.

**Acceptance:**

- Two independent sessions agree on movement, hazards, owner duties, alarms,
  authority catches, rescues, effect expiry and accepted scores.
- A phone hosts while rendering at an acceptable sustained frame rate.
- Host close/background and Wi-Fi loss produce bounded recovery or an explicitly
  interrupted round; confirmed scores and rescue/capture state never duplicate or silently disappear.
- Old-host return, competing candidates and delayed epochs cannot create two games.
- Input expires, queues stay bounded, resync uses current scope/appointment.
- Match clock and multiple-winner result contract survive checkpoint recovery in
  a minimal timed harness; confirm the exact target-win rule before complete-round UX.
- Two-player loss of the only backup pauses and then interrupts after the proposed
  ten-second window. A three-client fault test proves host replacement with a
  surviving backup and continued play.
- Healthy and impaired WS runs pass with real Rallar services; physical Safari
  backgrounding is recorded separately from browser emulation.

**Decision:** recovery is a release gate, not work deferred until after content.
If current appointment policy blocks it, the UI interrupts truthfully until the
reusable Rallar gap is fixed.

## Later outcomes

New discussion: the user supports the petty-rule personalities and wants a more
recognizable town square, plus fire-department, poop-bomb and exaggerated-vomit
possibilities. [Town and spectacle proposals](grumpy-town.md#brainstorm-a-recognizable-town-and-big-comic-incidents)
record the intended variety, witness behavior and counterplay. The user subsequently requested implementation of the full direction. The
two-slice expansion plan above now owns that work; retain the Rallar recovery gate.

Four-player mixed-device fun and repeated rounds; a complete authored market;
shared-win tuning and rematch; release accessibility/device qualification;
six players only if justified; deployment using static HTTPS SPA plus Rallar.
Additional prank types and physics-driven scenery require observed fun and
budget headroom. No new concrete third slice until the first two yield evidence.

## Tools and agent workflow

Existing Imagegen, browser/Playwright, repository skills and Babylon official docs
cover the first trial. Use game foundations/UI/playtest skills and the Rallar
app/realtime/code/testing specialists. There is no requirement for a Babylon MCP.
Blender is optional for later props; a physics engine is optional, not part of the
first load. Context7 authentication has failed; use official docs until repaired.

Physical phone/iPad testing remains the missing evidence capability. Use actual
devices and a shared HTTPS test URL; emulated viewports cannot certify them.
A device farm is optional, not a prerequisite to start. Audio can begin with short
procedural or licensed effects; no purchase/plugin installation is required.

One lead owns the integrated scene and contracts. Bounded art tasks return source
parts, pivots, atlas, provenance and an in-engine capture. Reliability tasks return
a reproduction, canonical owner/fix and focused evidence. Reviewers identify
concrete visual/lifecycle failures; the user judges the look and fun.

## Validation and delivery

Use existing workspace scripts after checking their current package definitions;
do not copy historical claims that CCA commands do not exist. Implementation
requires focused pure/runtime tests, builds, visible control flows and independent
authenticated clients. No app build validates a generated mockup.

Check local links and actual captures, run focused rules/browser tests and build
the SPA. Keep PR descriptions clear about the implemented local trial versus
proposed multiplayer; no claim that migration is complete. Keep design/implementation revisions in draft until the
relevant review and validation are complete.

No new issue is needed for the design pack itself. Host succession and checkpoint
semantics remain part of the later Rallar technical gate, not independent deferred issues.
