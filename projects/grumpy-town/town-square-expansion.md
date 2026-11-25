# Grumpy Town square and spectacles implementation plan

> **For agentic workers:** use `superpowers:executing-plans` for inline execution,
> followed by one fresh review. The user explicitly requested documentation then
> implementation and a playable trial; no additional plan-approval stop is needed.

**Goal:** turn the existing playground into a recognizable, varied town square
with the endorsed grumpy personalities, a fire-department response, a large poop
bomb and an original absurd vomit set piece, then publish a phone-playable preview.

**Architecture:** extend the canonical immutable town state and fixed-step rules.
Babylon displays accepted state; DOM/input retain the existing joystick, dash/drop,
zoom and pause/reset. Keep the work local; Rallar hosting remains the next technical
checkpoint after this requested content expansion, not an additional backend.

**Tech stack:** the existing pinned Babylon 9.36.0, TypeScript/Vite and Vitest/Playwright.
No new dependency, external art service or physics engine is necessary.

**Spec:** [Grumpy Town](grumpy-town.md), especially the endorsed personalities and
the town/spectacle discussion. The user has now requested implementation of this
whole direction; the following numeric choices are implementation tuning, not
claims that playtesting has established fun.

## Global constraints

- Preserve the selected restrained cutout style and original art/characters.
- Preserve smartphone/iPad/keyboard-mouse controls; no new mandatory action button.
- Preserve the ten-police bonus/chase, freeze/rescue, washing and existing pranks.
- Keep a 48×48 walkable town, a scrolling/zoomable camera, broad streets and exits.
- Witnesses need sight of the act; emergency response follows the incident.
- Effects, queues, rewards, cleanup and NPC pursuits must be bounded and resettable.
- Major effects cannot stack freezes or force endless vomiting/control loss.
- Runtime art remains procedural SVG/cutout geometry; captured media stays in docs.
- Only the following two implementation slices are concrete. Later networking work
  retains the requirements already recorded in architecture.md.

## Review focus

- New building/furniture footprints must not trap players, cleaners or returning police.
- A hidden resident must not identify a player who starts a fire behind solid scenery.
- Queued major events must retain their consequence exactly once without duplicate bonuses.
- Combined water, stains, freeze and vomit must preserve movement/recovery and cover.
- Repeated triggers, pause/reset and expired effects must not leave stale NPC modes,
  growing scene resources, permanent mess or an undeliverable queued response.

## Slice 1: an inhabited square with distinct grumps

**Files and ownership**

- Create `apps/grumpy-town/src/town/layout/map.ts`: named buildings and street furniture,
  their canonical footprints, kind, height, color and sign.
- Create `town/layout/presentation.ts`: varied roofs, facades, booths, balconies,
  awnings and ordinary square details from that map.
- Create `town/personalities/state.ts`, `rules.ts`, `presentation.ts`: resident
  identities, bounded reaction state, movement and original visual reaction props.
- Extend `town/state.ts`, `town/rules.ts`, `town/navigation.ts`, `town/routes.ts`,
  `practice-scene.ts` and `create-market-environment.ts` to consume those owners.
- Extend water/attention handling in existing `town/props.ts`, `owners.ts`,
  `soiling.ts` and movement only where a reaction crosses that real boundary.
- Add `packages/tests/grumpy-town/town-square.test.ts` and visible-control browser coverage.

**Interfaces**

`TOWN_BUILDINGS` and `TOWN_FURNITURE` expose readonly map definitions extending
`TownObstacle`. `createTownPersonalities()` creates the canonical resident state.
`computeTownPersonalities(input: TownTickInput)` returns updated town state
without clock, renderer or network dependencies. `createTownLayout` and
`TownPersonalityPresentation` own meshes and render accepted frames.

**Behavior and steps**

- [x] Write and observe failing tests for new solid footprints, reachable public
      streets, reaction/reward cooldowns and return to normal routines.
- [x] Author civic, shopping, service and residential edges: government/fire station,
      bakery/café/florist/newsstand/post office, varied terraces and balconies. Include
      benches, bus stop, mailboxes, bike racks, planters, notice boards and café seating.
      Replace repeated surrounding-house treatment with varied facades; preserve open lanes.
- [x] Implement the silence fanatic/bell, gardener/pots/flying wig, queue tyrant/barrier,
      cleaner/vacuum burp, mayor/silly statue, washer/laundry/hose and watcher/stolen hat.
      Each has a readable prop, dash trigger, original reaction and bounded recovery.
      Fresh deliberate triggers earn +10 with a 30-second source cooldown. Ambient
      routines/rivalries earn nothing.
- [x] Give creatures a visible occasional broom/chair/hat rivalry with residents;
      retain their existing hostile player encounters and no credit for ambient accidents.
- [x] Verify sight and collision, existing police/cleanup routes, same controls,
      reaction expiry, no repeated reward while active, and complete pause/reset.
- [x] Run focused rule tests and app build; inspect actual phone, tablet and desktop
      frames for variety, legibility, occlusion and playable routes.

## Slice 2: fire department, poop bomb and vomit spectacle

**Files and ownership**

- Create `town/spectacles/state.ts`, `rules.ts`, `fire.ts`, `presentation.ts` for
  canonical requests/lifecycles, fire crew travel, effect application and rendering.
  Split beam/effect rules only if that becomes a coherent separate responsibility.
- Extend `town/map.ts`, `town/pranks.ts`, `town/mischief.ts`, `town/soiling.ts`,
  `town/props.ts`, `town/rules.ts`, `practice-rules.ts` and HUD for selected effects.
- Add `packages/tests/grumpy-town/town-spectacles.test.ts` and
  `tests/playwright/grumpy-town/town-spectacles.spec.ts`.

**Interfaces**

`createTownSpectacles()` owns active event, bounded pending events, source reward
cooldowns, bomb pickup replenishment and fire crew state. Incident requests flow
from accepted dash/contact input. `computeTownSpectacles(input: TownTickInput)`
returns accepted town/player state. Presentation never applies damage or grants
points. A water query returns a spray direction for movement/washing, whether the
source is fountain, resident hose or fire crew.

**Behavior and steps**

- [x] Write failing tests for each incident, exactly-once rewards, witness sight,
      queue expiry/order, bounded secondary effects, washing/cover and reset.
- [x] Fire: dash a clearly marked barbecue/fire-prank prop. Award +20 once, count
      one fresh incident, announce a response, and send a small crew from the fire
      station. Witnessing residents point/chase; unseen residents do not identify you.
      Crew prioritize a localized fire, warn before hose sweeps, soak/wash/push actors,
      restore the site and return. A service bay keeps the truck out of escape lanes.
- [x] Poop bomb: a clearly marked pickup equips the existing dash/drop action.
      Replenish no sooner than 45 seconds. Show a two-second countdown and six-unit
      footprint, then a broad splat with solid-cover protection. Award +20 once and
      create at most twelve temporary ground patches with navigable gaps. No viewport
      obstruction or extra immobilization. Water remains an immediate remedy.
- [x] Vomit: dash the café sample tray to provoke a pompous inspector. A two-second
      green-cheek warning precedes a bounded six-second sweeping stream. A visible
      umbrella redirects the stream; a waiter protects the cake and a tiny-bucket
      cleaner restores the scene. Original staging and copy; no endless sickness chain.
      Award +20 once, one incident, and a source cooldown of at least 45 seconds.
- [x] Permit one major spectacle at a time with a visible bounded queue. Preserve
      committed responses; do not silently discard requests or repeat their rewards.
      Separate ordinary police waves from the spectacle slot; preserve escape routes.
- [x] Run all Grumpy Town rule/browser checks, source typecheck and app build. Capture actual
      touch gameplay for town personalities and all three major incidents. Inspect
      crowded frames and resource bounds after reset. Run scoped style/structure checks.
- [ ] Complete one fresh Grumpy Town review, fix substantive findings with regression tests,
      update current project/app docs and publish the existing draft PR.
- [x] Serve the production preview on the LAN and give the user the verified phone
      URL, actual footage, controls and honest remaining device/multiplayer limits.

## Verification commands and expected results

- `npx vitest run packages/tests/grumpy-town`: all affected domain tests pass.
- `npx playwright test --config apps/grumpy-town/playwright.config.ts`: normal visible
  controls reach each new interaction; no page errors or reset regressions.
- `npm run build --workspace=grumpy-town`: TypeScript and production bundle succeed.
- Focused test source typecheck: pass; report any third-party declaration limitation
  separately rather than claiming it was certified.
- Scoped `check:repo-style`, `check:repo-structure`, formatting and local-link checks:
  resolve changed-surface findings and missing artifacts.
- Read-only PR status before broad final validation; keep this iterative game PR
  draft while the user evaluates the local playground. No unrelated app fixes.

## Completion boundary

All endorsed personalities and the three named incidents must be playable before
claiming this goal complete. A prettier backdrop or only the first incident is an
increment, not completion. Physical phone comfort/heat and social fun still require
human/device feedback; Rallar multiplayer is not part of this local content goal.

## Implementation decisions and review

The first versions of all personalities and incidents are in the local trial.
Fire uses two firefighters and one parked truck; the café waiter also owns its
small-bucket cleanup gag. Street facades have collision/sight footprints but no
indoor scenes. Reaction animation is deliberately built from original cutouts,
short poses and movable props; sound and more elaborate animation remain polish.

Review found and closed an implicit route-cache lifecycle. `PracticeApp` now owns
`TownRoutes`, clears it on reset/stop and passes it through the nonserialized tick
context. Match state contains no routing service. Exact target/cart keys and a
128-destination bound retain the measured optimization. A cache/reset/cart-change
regression and an independent 360-tick two-owner comparison preserve outcomes.

Scoped style metrics flag the cohesive personality and routing rule modules at
50/51. Direct review found their ownership/call paths clear; no standards exception
or arbitrary file split was introduced. All changed named functions are at most
60 lines. The new building routes were independently exercised from five starts
to all eight resident homes (40 successful trials).

Final local acceptance: 66 rule tests, 12 browser tests, focused source typecheck and production build passed. Phone/tablet/desktop captures and the two touch recordings were inspected; local links and structure checks passed. Physical-device comfort and Rallar networking remain outside this local-trial acceptance.
