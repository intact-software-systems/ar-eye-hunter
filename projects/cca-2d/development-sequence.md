# Development sequence, agents, and tools

Status: revised for the selected Babylon 2.5D and Rallar player-host direction.
Only the next two implementation slices are concrete. The local Babylon trial, living square and ten-police chase/freeze/rescue loop are implemented; phone feel and device qualification remain open.

## Existing foundation and change of direction

The [local Babylon trial](babylon-local-trial.md) now replaces the Phaser entry.
It implements movement, dash-and-drop, slippery surfaces, camera zoom and pause/reset,
plus six interactive owners, fruit spills, fountain spray, a rolling cart, cleanup,
powder, mini-zappers, birds/dogs/cats, bins/fish/toilet/hydrant, stains/washing,
a +50 bonus and ten-officer raids, plus a clearly labelled local bot companion.
It includes real browser captures and focused rule/browser tests. The historical
server prototype remains outside the app; no new multiplayer is implemented.

The new visual target is [cutout market](visual-concepts/README.md), with a
[construction recipe](babylon-scene-construction.md). Retire the old square frame,
pixel-grid asset rules and separate Bank input in the trial. Carry forward useful
pure rules and input lessons, not the old authority boundary.

## Current slice 1: living square and ten-police crackdown

**Goal:** implement the approved [living-square expansion](grumpy-town.md#living-square-rules-and-approved-scope)
in the local Babylon app, then try it on phone. Preserve the existing controls.

**Architecture:** immutable town rules own incidents, rewards, creatures, stains,
objects and police state; Babylon displays that state. `practice-rules.ts` owns
movement. No new backend or dependency is needed. The government building replaces
the unused scenery bank; it is the actual police origin, not a label on random spawns.

**Task A — reward and consequence:**

- [x] Add failing rule tests for six qualifying incidents, exactly one +50 bonus,
  ten doorway departures, bounded chase/return/cooldown, and no empty-dash farming.
- [x] Update `town/state.ts`, `town/map.ts`, `town/rules.ts`, `town/mess.ts`,
  `town/props.ts`, `town/owners.ts` and `town/authorities.ts`; move the police lifecycle
  into `town/raid.ts` if needed to keep pursuit decisions readable.
- [x] Update government geometry, police presentation and HUD to show the bonus,
  deployment countdown, ten departures and remaining pursuit time.

**Task B — creatures and interactive mess:**

- [x] Add failing rule tests for bird poop, dog pee, cat vomit, dodgeable locked aim,
  player/owner/police soiling, provoked collateral credit, washing and effect expiry.
- [x] Add `town/creatures/rules.ts`, `town/soiling.ts` and `town/objects.ts` with owned
  contracts beside their rules; extend canonical town state without parallel legacy paths.
- [x] Add original creature/prop cutout presentation; two of each creature, two bins,
  fish display, toilet and hydrant. Apply movement/cleanup effects in rules only.
- [x] Add visible-control browser checks for new objects and the full bonus/police
  sequence. Record actual phone-sized gameplay and inspect readable creatures,
  stains, warnings and crowded police movement.

**Verification:** `npx vitest run packages/tests/cca-game`,
`npx playwright test --config apps/cca-2d/playwright.config.ts`,
`npm run build --workspace=cca-2d`, focused test typecheck and scoped style review.
Check independent cases: attacks through walls, repeated rewards, police returning
through obstacles, freeze plus animal hits, and reset/pause while a wave is active.
The fresh review found a scheduled-officer splash edge; a regression now protects
waiting officers from direct and ground soiling until departure. The 48 rule tests,
app build and focused source typecheck pass. Nine browser checks cover controls
and the full wave; actual touch captures show the local production build.
Update the existing draft PR.
Keep unrelated app investigations outside this work.

**Phone decision:** can the player deliberately earn the big bonus, understand
its price, use creatures against grumps, escape ten police, wash off and resume
mischief? Physical Safari/iPad performance and social fun still need device testing.

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
