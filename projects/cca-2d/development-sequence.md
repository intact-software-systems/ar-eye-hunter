# Development sequence, agents, and tools

Status: revised for the selected Babylon 2.5D and Rallar player-host direction.
Only the next two implementation slices are concrete. The local Babylon trial, varied square and chase/freeze/rescue loop are implemented; phone feel and device qualification remain open.

## Existing foundation and change of direction

The [local Babylon trial](babylon-local-trial.md) now replaces the Phaser entry.
It implements movement, dash-and-drop, slippery surfaces, camera zoom and pause/reset,
plus six interactive owners, fruit spills, fountain spray, a rolling cart, cleanup,
powder, mini-zappers, bounded raids and a clearly labelled local bot companion.
It includes real browser captures and focused rule/browser tests. The historical
server prototype remains outside the app; no new multiplayer is implemented.

The new visual target is [cutout market](visual-concepts/README.md), with a
[construction recipe](babylon-scene-construction.md). Retire the old square frame,
pixel-grid asset rules and separate Bank input in the trial. Carry forward useful
pure rules and input lessons, not the old authority boundary.

## Current slice 1: phone feedback on the local chase and rescue loop

**Implemented:** fruit, fountain and cart create different cleanup duties. Tidy
owners witness mischief and chase with dodgable score penalties. Three witnessed
actions trigger a four-second interruptible call, followed by a 20-second local
raid. Captures freeze for six seconds; proximity rescue and auto-thaw grant brief
protection. The orange BOT PAL demonstrates rescue without claiming multiplayer.

The local rules, actual touch-input captures and browser controls are checked.
The independent review found a corner-oscillation route bug; collision-clear routes
and a behind-stall arrival/rescue regression address it. No unrelated app changes
or broader CI investigation belong to this slice, following the user's direction.

**Remaining outcome:** establish whether this is funny and readable on a physical
phone before expanding content. Try these concrete tasks:

- Tip fruit, leave its cleaning owner behind, and escape the tidy neighbour.
- Redirect the fountain and release the cart; use the different hazards while escaping.
- Interrupt one call, then deliberately allow another raid and dodge its targets.
- Rescue the orange bot or let it rescue you. Compare six seconds frozen with ten.
- Rotate, zoom, pause/background and resume on phone/iPad; check thumb comfort and frame pacing.

**Working hypothesis:** individual mischief scores with shared survival during
raids; several players can eventually qualify. The local scene has points but no
round timer, target qualification or winners yet. Pure cooperation and competitive
optional rescue remain alternatives until real multiplayer playtests.

**Decision:** tune based on anticipation, readable consequences and voluntary
rescues. Keep laundry, toilet overflow, more personalities and larger crowds out
of the immediate scope. Stay in the draft PR while this design is being tried.

## Next slice 2: Rallar-only two-player hosting and recovery

**Outcome:** two authenticated players share the scene using only Rallar as
multiplayer backend, with one appointed browser running the rules.

Keep the separate historical CCA server outside the selected app composition.
Use Rallar WS room transport first, bounded input/snapshot publication, accepted
appointment/epoch validation and client reconciliation. Establish the checkpoint
commit protocol before promising retained scores across host loss.

First reproduce the existing appointment-permission constraints. Prove a valid
successor path for an owner host that backgrounds while still appearing online.
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
semantics are dependent work in slice 2, not independent deferred issues.
