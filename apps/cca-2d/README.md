# CCA — Babylon cutout playground

A local **Grumpy Town** playground in Babylon.js **9.36.0**. Dash into displays,
scatter slippery fruit, annoy shopkeepers and dodge their mini-zaps. They sweep
up and restock, ready for another round of mischief. Walk over powder or lightning
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
  dodge. They then sweep up fruit and restore their display. A nearby fart also
  makes them angry.
- Powder and zapper pickups are outside the purple and yellow stalls down the
  street. One pickup equips one dash; stocked counters replenish pickups after
  10 seconds. The HUD and action button show the loaded prank.

The portrait joystick is 100 CSS pixels and action button 84, floating within the
bottom quarter at the tested 390 × 844 viewport. Landscape uses 80/76 pixels.
Zoom buttons are at least 44 × 44. Camera width is bounded to 8–24 world units in
portrait and scaled by aspect in landscape. The default width is 13. The walkable town is now 48 × 48 world
units with six interactive shops; the camera follows through the streets.

## Construction and owners

- `main.ts`: lazy import and page lifetime.
- `practice-app.ts`: fixed 60 Hz simulation loop, HUD, pause/reset and teardown.
- `practice-controls.ts`: keyboard, independent pointer capture and pinch input.
- `practice-rules.ts`: immutable movement, dash, traction, cloud lifetime and collision.
- `town-map.ts`: common shop footprints, ice, bank and town boundary.
- `town-rules.ts`: local town state, stall spills, owner reactions/cleanup and effect expiry.
- `town-pranks.ts`: pickup collection and aim-assisted prank targeting.
- `town-presentation.ts`: owner poses, speech, targets, debris and display state.
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
not a dependency. The next local slice proves chase/freeze/rescue; Rallar-only player-hosted
multiplayer follows it. Neither is an implemented capability of this app.

## Checks and evidence

```sh
npx vitest run packages/tests/cca-game
npx playwright test --config apps/cca-2d/playwright.config.ts
npm --workspace cca-2d run build
```

The browser suite covers visible controls, simultaneous touch movement/action,
pinch zoom, desktop movement, responsive layouts, pause/reset and keyboard button
activation, stall damage/retaliation/cleanup and powder pickup. It uses an isolated Chromium context and port 5182.

See [actual captures and trial limits](../../projects/cca-2d/babylon-local-trial.md).
Physical iPhone/iPad comfort, Safari behavior and sustained frame pacing still
need testing on devices. The scene is a visual/feel trial, not a complete match.
