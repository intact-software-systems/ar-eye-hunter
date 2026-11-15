# Babylon local cutout trial

Implemented 15 November 2026 in [the SPA](../../apps/cca-2d/README.md), using pinned
Babylon.js 9.36.0. The local trial now includes the
[Grumpy Town interaction slice](grumpy-town.md) before multiplayer. Working scene
title: **Grumpy Town**.

## Actual gameplay

![Actual Babylon gameplay: spilled fruit and an owner aiming a mini-zap](visual-concepts/grumpy-town-fruit-zap.png)

[Watch actual touch gameplay](visual-concepts/grumpy-town-gameplay.webm).
The recording uses visible touch controls in a fresh Chromium context at
390 × 844 CSS pixels. Screenshots use device scale 2; render density is capped
at 1.5. These are rendered Babylon meshes and animated textures, not generated
concept art or a physical-device recording. There is no audio yet.

[Starting view](visual-concepts/grumpy-town-phone.png) ·
[Mini player and cleanup](visual-concepts/grumpy-town-mini-cleanup.png) ·
[Powder prank](visual-concepts/grumpy-town-powder.png).
The earlier `babylon-trial-*` captures preserve the initial movement-only trial.

## What to try on your phone

Run the commands in the app README and open its Network URL on the same Wi-Fi.
A local HTTP URL is sufficient for this offline WebGL trial. Later authenticated
Rallar testing uses the architecture's HTTPS deployment.

1. Drag toward a fruit stall and press **DASH + DROP** to tip it. Walk through
   the scattered fruit and feel the skid.
2. Watch the owner's warning target. Move out before the zap, or stay and become
   tiny for six seconds. The owner sweeps up fruit and restores the display.
3. Go down the street to the purple powder or yellow zapper counter. Walk over
   its pickup, then dash near an owner. Powder makes them wobble and puke; a zapper
   briefly shrinks characters in front. Your next action returns to a fart drop.
4. A nearby fart also annoys an owner. Powder can affect you too; its short
   dizziness slows movement without reversing input.
5. Pinch the street or tap +/− to explore the wider town. Pause/reset, switch apps
   and return, then rotate the phone.

The immediate feedback to collect is control comfort, readable faces, dash/slide
feel and how much of the market you can see. This trial does not yet answer
whether complete competitive rounds are fun.

## How this reproduces the direction

Original human characters use separately drawn SVG head/torso/limb textures on
Babylon planes, hinged under TransformNodes. Four expressions cover grumpy, angry, surprised and dizzy poses.
Bodies lean, legs splay, brooms swing and cartoon puke appears briefly. The whole assembly faces the fixed camera
at a consistent tilt. Animation changes presentation only.

Stalls and bank use simple boxes, striped awnings and paper colors. Ice and water
are ground quads. A reusable puff plane grows and fades. Texture grain is authored
in the SVG source. No external art tool, physics engine, 3D character rig or
multiplayer server is needed to reproduce this scene.

The six owners are interactive NPCs driven by the immutable simulation. Displays
tip, fruit rolls and causes slipping, warning targets mark retaliation, and cleanup
removes debris before restocking. Stalls keep their collision footprints while
tipped. The bank and outer buildings remain scenery. Collection/banking, timed
winners, other human players and a complete match objective are not implemented.

## Reliability and loading evidence

The immutable rules run at a fixed 60 Hz with a bounded frame catch-up. Input
cancellation clears movement; backgrounding pauses; resuming consumes stale action
edges. Obstacles stop dashes. A cooldown press is discarded, never queued.

Twenty CCA rule tests and seven visible-control browser tests pass. They cover
stall damage, slipping, dodgable retaliation, cleanup/restocking, temporary pranks,
simultaneous touch movement/dash, pinch, keyboard, responsive dimensions and
pause/reset. These tests establish local behavior, not physical-device performance.

The production build lazy-loads the Babylon scene. The main game/engine chunk is
about 230 kB gzip; other engine/shader chunks are separate. That figure alone is
not a cold-transfer measurement. The old approximately 2 MiB generated WebP seed
art and Phaser dependency are removed from this entry. All current visual textures
are generated locally from the shipped source. Vite reports its large uncompressed
chunk warning; the build passes.

Physical iPhone/iPad Safari, ten-minute heat/frame pacing, cold mobile-network
loading and repeated-remount GPU allocation remain unverified. No multiplayer,
host-recovery or production-release claim follows from these local tests.

## Next decision

Try this scene and decide whether its proportions, cutout expression and control
feel are worth taking forward. Judge whether making a mess, dodging retaliation and interrupting cleanup is fun
before adding more prank types.
The following implementation slice remains Rallar-only player-hosted multiplayer
with explicit recovery behavior. Do not connect the historical separate CCA server
to this entry as a shortcut.
