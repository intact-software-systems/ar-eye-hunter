# Building the cutout mockup in Babylon.js

Status: construction recipe now exercised by the [local Babylon trial](babylon-local-trial.md).
Actual browser captures exist; physical-device/performance qualification remains open. The generated [phone mockup](visual-concepts/cutout-market-phone-v1.png)
is an art target. A static illustration cannot certify reproducibility, motion,
loading or mobile performance.

## What is feasible, and what must change

The look can be constructed from ordinary meshes, textures, transform animation
and an orthographic camera. It does not require a special South Park shader,
full character modeling, realistic fluid simulation or a physics engine.

The mockup's paper grain, shadows and foreground character proportions are
illustrative. Its apparent perspective is not a calibrated orthographic camera.
Do not trace it into one giant background or promise pixel-identical rendering.
The first scene must choose a consistent camera, simplify texture density and
show more ground at normal play zoom. Close zoom can retain larger expressions.

## Scene recipe

| Visible element      | Babylon construction                                          | Asset needed                                | Verification                                                   |
| -------------------- | ------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| Three-quarter market | Fixed orthographic camera over an X/Z ground plane, Y up      | Authored obstacle footprints and simple map | Same camera basis for input, rendering and ground picking      |
| Streets              | Ground mesh with muted repeatable texture                     | Small seamless ground texture               | No distracting repetition or shimmer at overview               |
| Stall/bank/bin       | Boxes and low-poly planes with matte shared materials         | Small facade/awning atlas                   | Corners, depth and walkable footprints agree                   |
| Player and guard     | A ground-anchored root with layered textured planes           | Transparent body parts and face atlas       | Consistent feet and correct overlap from every allowed view    |
| Faces                | Swap eyes/brows/mouth atlas regions or child-plane visibility | Deadpan, smug, surprised, angry expressions | Distinguishable at normal phone scale                          |
| Running/dash/fall    | Animate limb pivot nodes and visual body tilt                 | Joint pivots and named pose curves          | Animation never moves authoritative ground root                |
| Ice/puddle           | Slightly elevated ground-aligned patches                      | Cyan ice and blue puddle silhouettes        | No z-fighting; hazard boundary matches actual rule area        |
| Fart cloud           | A few pooled transparent planes or a capped particle emitter  | One puff texture plus color/opacity curve   | Does not hide faces or hazard edges                            |
| Poop/footprints      | Bounded ground decals/quads                                   | Simple splat/footprint sheet                | Cosmetic unless rules explicitly define a hazard               |
| Shadows              | Small blob quads and baked texture shading                    | One soft oval                               | Stable ground anchor; no real-time shadow map needed initially |
| HUD/controls         | DOM over the Babylon canvas                                   | Real text, icons and CSS                    | Measured tap targets and independent pointer handling          |

### Camera and movement

Use a fixed azimuth/elevation, starting around 50 degrees above the ground.
Calculate orthographic left/right/top/bottom bounds from zoom and viewport aspect.
Zoom changes these extents; changing camera distance alone does not zoom an
orthographic view. Disable orbit controls. Follow the accepted/predicted ground
position with bounded smoothing, not a freely rotating camera.

Project screen-relative joystick direction onto the X/Z ground basis, normalize
once, and feed that normalized direction to the rules. Pixel-to-ground picking,
if used for debug or effects, must use the same camera. Do not make forward speed
depend on depth, display size or zoom. See the [camera API](https://doc.babylonjs.com/typedoc/classes/BABYLON.UniversalCamera).

### Character construction

Each entity has a simulation-independent presentation root at its ground anchor.
A child cutout assembly carries torso, head, hair, two arms, two legs and face.
Pivot TransformNodes sit at shoulders/hips; limb planes are offset relative to
those pivots. Use stable tiny depth offsets within the assembly, not one coplanar
stack that flickers.

With a fixed camera, orient the whole art assembly consistently toward the camera;
do not billboard each limb independently. Start with a fixed camera-facing tilt
and use facing artwork/mirroring for directional movement. Test ground contact
and occlusion before selecting full billboarding. Optional billboard support is
documented in Babylon's [Mesh API](https://doc.babylonjs.com/typedoc/classes/babylon.mesh).

Use a textured unlit/lighting-disabled material for flat paper color, with grain
baked into the art. Share materials/atlases where practical. Prefer alpha-tested
cutout edges where visually acceptable so silhouettes write depth predictably;
reserve alpha blending for soft puffs/shadows. Test edge halos, intersections,
two characters crossing and a character behind a stall. Layer order inside one
rig does not solve world transparency sorting. Do not disable depth globally to
hide a sorting bug.

Animate child transforms with short pose clips or sampled curves. Keep animation
state driven by accepted presentation state; clamp recovery duration to the rules.
A falling sprite can rotate while its authoritative collision remains a simple
ground footprint. Do not require skeletal retargeting or ragdolls for this look.

### Hazards and effects

Water is a drawn patch plus a short splash; ice is a ground patch plus rule-driven
velocity/traction. Neither needs fluid simulation. The host decides hazard identity,
position, activation, duration and slip response. Clients render that accepted
state and may animate bounded cosmetic particles locally.

Pool puff planes, fade them over a short lifetime and cap overlap. Avoid volumetric
smoke and full-screen post-processing. Babylon supports billboard particles and
standard alpha blending; choose subdued opacity rather than additive glow.
See [particle modes](https://doc.babylonjs.com/features/featuresDeepDive/particles/particle_system/ramps_and_blends/)
and [blend modes](https://doc.babylonjs.com/features/featuresDeepDive/materials/using/blendModes/).

### Environment and occlusion

Keep buildings simple and foreground props low enough to reveal faces and feet.
Prefer moving a decorative stall to complex transparency. If occlusion fading is
needed, fade only the relevant decoration while keeping obstacle footprints
readable. Test close/play/overview rather than designing only one screenshot.

Batch repeated static scenery when measurement justifies it. Shared atlases do
not automatically make all body parts one draw call. Start with a modest part
count and record actual draw calls/transparent overdraw with two and four actors.

## Asset delivery recipe for agents

1. Produce one original neutral character turnaround and a face-expression strip
   at a fixed scale; user reviews the identity.
2. Produce transparent separated parts with full hidden joint overlap, common
   palette/grain, named pivots and padding. Inspect at intended CSS size.
3. Pack a small runtime atlas and record part rectangles, pivots and depth order.
   Source art and large mockups remain outside the shipped asset path.
4. Assemble the character in Babylon and author three short poses: run, dash/puff,
   slip/recovery. Fix joint seams and silhouette drift in motion.
5. Build one ground patch, one stall and the bank from simple geometry; add one
   rival and guard using the same construction rules.
6. Capture the real scene using the same camera/viewport/seed for comparisons.

Generation makes bitmap parts, not a rig or playable level. Agents must deliver
the parts, anchors, renderer scene and in-engine capture together. Blender is
optional for unusual props, not required for the first construction. No new MCP
is required for planes, boxes, transforms and textures.

## Rendered proof gate

Before expanding the game, build one representative scene in the actual chosen
Babylon version and use visible controls on a real phone:

- Run, dash/puff, slide and recover; all ground contacts and faces remain legible.
- Cross a rival and walk behind the stall without transparency/sorting artifacts.
- Zoom between all presets and rotate the device without distorted art, lost
  control pointers or accidental gameplay input.
- Measure CSS control sizes, cold transferred bytes, decoded texture allocation,
  draw calls, frame pacing and disposal after repeated remounts.
- Compare the real capture against this reference at the same screen size; list
  differences explicitly. The close-up mockup is not a gameplay-scale blueprint.

Use Babylon's [optimization guidance](https://doc.babylonjs.com/features/featuresDeepDive/scene/optimize_your_scene/)
and [modular package guidance](https://doc.babylonjs.com/setup/frameworkPackages/npmSupport/).
The local trial pins and tests Babylon.js 9.36.0. Use WebGL as the baseline; optional WebGPU must not be a
phone admission requirement.

Acceptance is a recognizable cutout identity, readable tactical play and the
[architecture budgets](architecture.md#performance-and-acceptance), not literal
replication of generated shadows. If it fails, simplify the rig/materials/art and
recapture before adding assets. If it still fails the cost/quality comparison,
reconsider Phaser with the same cutout direction.

Official documentation was consulted on 15 November 2026. Capability documentation
supports the recipe; only the rendered proof can demonstrate the final result.
