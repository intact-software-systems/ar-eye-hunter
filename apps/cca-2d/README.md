# CCA — Babylon cutout playground

A local **Grumpy Town** playground in Babylon.js **9.36.0**. Dash into displays,
scatter slippery fruit, tip bins, spill old fish, overflow a toilet, break the
fountain/hydrant and release a parcel cart. Birds drop poop, dogs spray pee and
cats cough up puke; lure their warned attacks into pursuers. Busy owners
clean; tidy neighbours chase and zap away points. Authorities freeze characters
during short raids. The orange BOT PAL demonstrates proximity rescue. Walk over powder or lightning
pickups to load a different prank on the same dash button. The teal hoodie is you.

## Try it

```sh
npm ci
npm --workspace cca-2d run dev
```

Open Vite's Network URL on a phone on the same Wi-Fi. No account, API or game
server is needed. For the smaller production bundle:

```sh
npm --workspace cca-2d run build
npm --workspace cca-2d exec vite preview -- --host 0.0.0.0 --port 5183 --strictPort
```

- Touch: floating joystick + **DASH + DROP**. Pinch the street or use +/− to zoom.
- Keyboard/mouse: WASD or arrows, Space to dash, scroll or +/− to zoom.
- Pause offers resume and reset. Backgrounding pauses; returning requires resume.
- Dash lasts 0.2 seconds, drops one 2.4-second cloud and has a 3-second cooldown.
  Ice, fallen fruit and cartoon puke reduce traction; release the joystick to
  feel the remaining momentum. Powder causes 3.2 seconds of dizziness and a puke
  puddle. A mini-zap shrinks its target for 6 seconds; it never removes control.
- Owners telegraph a zap at a fixed ground target for 0.85 seconds. Move away to
  dodge a three-point penalty. Busy owners prioritize cleanup before watching
  again. Six fresh rewarded incidents give **+50**, then a five-second warning
  precedes **ten police departing from the Ministry of No Fun** for 25 seconds.
  They stop attacking and return home at shift end, followed by a quiet cooldown. Stay near a frozen friend for one second to rescue; auto-thaw
  happens after six seconds. Raids do not deduct points.
- A newly damaged object gives 10 points and one trouble mark. Each source has
  a 30-second reward cooldown; empty dashes do not count. Provoked animal attacks
  hitting residents/police also earn credit; unprovoked accidents do not.
- Poop, pee and puke stain characters temporarily. Water washes them off. Animal
  attacks show a locked warning target for one second; move away to dodge.
- Powder and zapper pickups are outside the purple and yellow stalls down the
  street. One pickup equips one dash; stocked counters replenish pickups after
  10 seconds. The HUD and action button show the loaded prank.

The portrait joystick is 100 CSS pixels and action button 84, floating within the
bottom quarter at the tested 390 × 844 viewport. Landscape uses 80/76 pixels.
Zoom buttons are at least 44 × 44. Camera width is bounded to 8–24 world units in
portrait and scaled by aspect in landscape. The default width is 13. The walkable town is now 48 × 48 world
units with six interactive shops, five street objects, fountain/cart, six
creatures and the government building; the camera follows through the streets.

## Construction and owners

- `main.ts`: lazy import and page lifetime.
- `practice-app.ts`: fixed 60 Hz simulation loop, HUD, pause/reset and teardown.
- `practice-controls.ts`: keyboard, independent pointer capture and pinch input.
- `practice-rules.ts`: immutable movement, dash, traction, cloud lifetime and collision.
- `town/rules.ts`: tick coordination for owners, props, raids, effects and rescue.
- `town/state.ts` and `town/map.ts`: canonical state and map geometry.
- `town/owners.ts`, `town/authorities.ts`, `town/companion.ts`: duties, pursuit, catch and rescue.
- `town/mess.ts`, `town/props.ts`, `town/objects.ts`, `town/pranks.ts`: bounded interactions and cleanup.
- `town/creatures/`: creature rules, original cutout art and rendering.
- `town/soiling.ts`: stains, washing and mess immunity.
- `town/mischief.ts` and `town/raid.ts`: rewards, trouble and police wave lifecycle.
- `town/navigation.ts` and `town/routes.ts`: collision, sight and obstacle-aware travel.
- `town/*presentation.ts`: visual state; it never decides game outcomes.
- `practice-scene.ts`: Babylon engine, camera, actors and cloud presentation.
- `cutout-actor.ts`: ground anchor and hinged limbs; visual poses never move rules.
- `cutout-art.ts`: original SVG part textures, paper grain, shared unlit materials.
- `create-market-environment.ts`: simple textured geometry and ground patches.

The renderer uses WebGL, capped render density, alpha-tested cutouts and a blended
blob shadow. No physics package, external font, generated runtime bitmap download,
CDN script or image API is required. Scene disposal releases Babylon resources;
input listeners belong to abortable lifetimes. Context loss shows a reopen link.

This entry replaces the earlier Phaser practice. That entry's collection,
banking and online UI are removed from this trial. The separate historical
`cca-server` / `packages/cca-game` prototype is outside the local renderer and is
not a dependency. The local chase/freeze/rescue slice is implemented with a labelled bot companion.
Rallar-only player-hosted multiplayer and recovery follow phone feedback. They are
not yet capabilities of this app.

## Checks and evidence

```sh
npx vitest run packages/tests/cca-game
npx playwright test --config apps/cca-2d/playwright.config.ts
npm --workspace cca-2d run build
```

The browser suite covers visible controls, simultaneous touch movement/action,
pinch zoom, desktop movement, responsive layouts, pause/reset and keyboard button
activation, stall damage/cleanup, powder pickup, fountain/cart interactions and
a full bonus/ten-police/freeze/recovery/return cycle. It uses an isolated Chromium context and port 5182.

See [actual captures and trial limits](../../projects/cca-2d/babylon-local-trial.md).
Physical iPhone/iPad comfort, Safari behavior and sustained frame pacing still
need testing on devices. The scene is a visual/feel trial, not a complete match.
