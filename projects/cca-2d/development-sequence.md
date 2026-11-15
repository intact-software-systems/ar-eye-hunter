# Development sequence, agents, and tools

Status: revised for the selected Babylon 2.5D and Rallar player-host direction.
Only the next two implementation slices are concrete. The basic local Babylon
trial is implemented; phone feel and device qualification remain open.

## Existing foundation and change of direction

The [local Babylon trial](babylon-local-trial.md) now replaces the Phaser entry.
It implements movement, dash-and-drop, ice traction, camera zoom and pause/reset.
It includes real browser captures and focused rule/browser tests. The historical
server prototype remains outside the app; no new multiplayer is implemented.

The new visual target is [cutout market](visual-concepts/README.md), with a
[construction recipe](babylon-scene-construction.md). Retire the old square frame,
pixel-grid asset rules and separate Bank input in the trial. Carry forward useful
pure rules and input lessons, not the old authority boundary.

## Current slice 1: phone feedback on the Babylon scene

**Outcome:** one moving scene on a phone establishes whether the generated look
is reproducible and the single action is enjoyable.

The trial implements the construction guide's small representative corner: one original cutout
rig, rival, guard, stall, bank, authored puddle/ice and dash/fart decoy. Local rules are separate from rendering. Floating controls, orthographic follow
and bounded zoom are implemented. Collection and proposed dwell banking wait
until the four-verb trial is judged; they are not part of its present scope.

Do not build a full market or parallel engine framework. Measure the Babylon
dependency and critical art before producing more assets. Keep any retained
Phaser practice clearly separate from the trial; do not leave two default entry
paths or silently switch between incompatible authority models.

**Acceptance:**

- A real Babylon capture visibly matches the cutout identity at phone scale.
- Run/dash/puff/slide/recovery are controllable and their cause is understandable.
- Character parts, shadows and depth remain coherent at all zoom presets.
- Joystick plus action works; pinch does not steal control pointers.
- Portrait, landscape, iPad and keyboard/mouse have equivalent actions.
- Named physical-device cold loading and ten-minute frame pacing meet the proposed
  budgets or cause a specific simplification decision.
- Pure-rule/runtime checks, app build and visible-control browser play pass.

**Decision:** approve the moving scene and basic interaction before expanding art.

## Next slice 2: Rallar-only two-player hosting and recovery

**Outcome:** two authenticated players share the scene using only Rallar as
multiplayer backend, with one appointed browser running the rules.

Replace the separate CCA server dependency in the selected app composition.
Use Rallar WS room transport first, bounded input/snapshot publication, accepted
appointment/epoch validation and client reconciliation. Establish the checkpoint
commit protocol before promising retained scores across host loss.

First reproduce the existing appointment-permission constraints. Prove a valid
successor path for an owner host that backgrounds while still appearing online.
Any generic missing capability belongs in Rallar and its focused tests; do not
bypass authorization or promote everyone to room admin.

**Acceptance:**

- Two independent sessions agree on movement, hazards, pickups and deposits.
- A phone hosts while rendering at an acceptable sustained frame rate.
- Host close/background and Wi-Fi loss produce bounded recovery or an explicitly
  interrupted round; confirmed money never duplicates or silently disappears.
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
